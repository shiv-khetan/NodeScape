use crate::contracts::{valid_unit, AppError, ErrorKind, Target};
use crate::transport::{self, RunOpts};
use serde::Serialize;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

#[derive(Debug, Serialize)]
pub struct Unit {
    pub name: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
    pub enabled: String,
}

#[derive(Debug, Serialize)]
pub struct SystemServices {
    pub units: Vec<Unit>,
}

#[derive(Debug, Serialize)]
pub struct UserServices {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub units: Vec<Unit>,
}

#[derive(Debug, Serialize)]
pub struct Services {
    pub system: SystemServices,
    pub user: UserServices,
}

const USER_ENV: &str = r#"runtime_dir=/run/user/$(id -u)
if [ -d "$runtime_dir" ]; then export XDG_RUNTIME_DIR="$runtime_dir"; fi
"#;

const READ: &str = r#"export LC_ALL=C
system_units=$(systemctl list-units --type=service --all --plain --no-legend --no-pager) || exit $?
system_files=$(systemctl list-unit-files --type=service --plain --no-legend --no-pager) || exit $?
printf '@system_units\n%s\n@system_files\n%s\n' "$system_units" "$system_files"
runtime_dir=/run/user/$(id -u)
if [ -d "$runtime_dir" ]; then export XDG_RUNTIME_DIR="$runtime_dir"; fi
if user_units=$(systemctl --user list-units --type=service --all --plain --no-legend --no-pager 2>/dev/null) &&
   user_files=$(systemctl --user list-unit-files --type=service --plain --no-legend --no-pager 2>/dev/null); then
    printf '@user_units\n%s\n@user_files\n%s\n@user_status\navailable\n' "$user_units" "$user_files"
else
    printf '@user_units\n@user_files\n@user_status\nunavailable\n'
fi
"#;

fn field<'a>(line: &mut &'a str) -> Option<&'a str> {
    *line = line.trim_start();
    if line.is_empty() {
        return None;
    }
    let end = line.find(char::is_whitespace).unwrap_or(line.len());
    let value = &line[..end];
    *line = &line[end..];
    Some(value)
}

fn service_name(name: &str) -> bool {
    valid_unit(name) && name.ends_with(".service")
}

fn parse_units(list: &str, files: &str) -> Vec<Unit> {
    let mut units = BTreeMap::new();
    for line in list.lines() {
        let mut line = line.trim_start().trim_start_matches('●');
        let Some(name) = field(&mut line).filter(|name| service_name(name)) else {
            continue;
        };
        let (Some(load), Some(active), Some(sub)) =
            (field(&mut line), field(&mut line), field(&mut line))
        else {
            continue;
        };
        units.insert(
            name.to_owned(),
            Unit {
                name: name.into(),
                load: load.into(),
                active: active.into(),
                sub: sub.into(),
                description: line.trim().into(),
                enabled: "unknown".into(),
            },
        );
    }
    for line in files.lines() {
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next().filter(|name| service_name(name)) else {
            continue;
        };
        let Some(enabled) = fields.next() else {
            continue;
        };
        let unit = units.entry(name.into()).or_insert_with(|| Unit {
            name: name.into(),
            load: "not-loaded".into(),
            active: "inactive".into(),
            sub: "dead".into(),
            description: String::new(),
            enabled: "unknown".into(),
        });
        unit.enabled = enabled.into();
    }
    units.into_values().collect()
}

fn parse_read(output: &str) -> Result<Services, AppError> {
    let mut sections: BTreeMap<&str, String> = BTreeMap::new();
    let mut section = "";
    for line in output.lines() {
        if [
            "@system_units",
            "@system_files",
            "@user_units",
            "@user_files",
            "@user_status",
        ]
        .contains(&line)
        {
            section = line;
            sections.entry(section).or_default();
        } else if let Some(value) = sections.get_mut(section) {
            value.push_str(line);
            value.push('\n');
        }
    }
    let get = |name: &str| {
        sections
            .get(name)
            .map(String::as_str)
            .ok_or_else(|| AppError::new(ErrorKind::Remote, "Incomplete services response"))
    };
    let system = SystemServices {
        units: parse_units(get("@system_units")?, get("@system_files")?),
    };
    let available = match get("@user_status")?.trim() {
        "available" => true,
        "unavailable" => false,
        _ => {
            return Err(AppError::new(
                ErrorKind::Remote,
                "Invalid user manager status",
            ))
        }
    };
    let units = parse_units(get("@user_units")?, get("@user_files")?);
    Ok(Services {
        system,
        user: UserServices {
            available,
            reason: (!available).then(|| "user manager not running — services under this account only run while you are logged in unless lingering is enabled".into()),
            units: if available { units } else { Vec::new() },
        },
    })
}

#[tauri::command]
pub async fn services_read(
    target: Target,
    operation_id: Option<String>,
) -> Result<Services, AppError> {
    let output = transport::run(
        &target,
        READ,
        RunOpts {
            operation_id,
            ..Default::default()
        },
    )
    .await?;
    parse_read(&output)
}

fn action_argv<'a>(scope: &str, unit: &'a str, action: &'a str) -> Result<Vec<&'a str>, AppError> {
    if !["system", "user"].contains(&scope)
        || !valid_unit(unit)
        || !["start", "stop", "restart", "enable", "disable"].contains(&action)
    {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Refused: invalid scope, unit name or action",
        ));
    }
    let mut argv = vec!["systemctl"];
    if scope == "user" {
        argv.push("--user");
    }
    argv.extend([action, "--", unit]);
    Ok(argv)
}

fn mutation_error(error: AppError) -> AppError {
    // Only failures that can happen after the command reached the server are "unknown".
    // Unreachable means nothing ran; Remote means systemctl ran and reported its own error.
    if matches!(
        error.kind,
        ErrorKind::Timeout | ErrorKind::Internal | ErrorKind::Cancelled
    ) {
        AppError::new(
            ErrorKind::OutcomeUnknown,
            format!(
                "Outcome unknown: the service action could not be confirmed. Refresh state before trying again. {}",
                error.message
            ),
        )
    } else {
        error
    }
}

async fn run_action(
    target: &Target,
    scope: &str,
    unit: &str,
    action: &str,
    password: Option<Zeroizing<String>>,
    opts: RunOpts,
) -> Result<String, AppError> {
    let argv = action_argv(scope, unit, action)?;
    if scope == "user" && password.is_some() {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "User services do not use a sudo password",
        ));
    }
    let result = if scope == "system" {
        crate::sudo::run_privileged(target, &argv, password, opts).await
    } else {
        // All argv values passed validation above; quote even the fixed arguments.
        let command = argv
            .iter()
            .map(|arg| format!("'{arg}'"))
            .collect::<Vec<_>>()
            .join(" ");
        transport::run(
            target,
            &format!("export LC_ALL=C\n{USER_ENV}{command}"),
            opts,
        )
        .await
    };
    result.map_err(mutation_error)
}

#[tauri::command]
pub async fn service_action(
    target: Target,
    scope: String,
    unit: String,
    action: String,
    password: Option<String>,
    operation_id: Option<String>,
) -> Result<String, AppError> {
    run_action(
        &target,
        &scope,
        &unit,
        &action,
        password.map(Zeroizing::new),
        RunOpts {
            operation_id,
            ..Default::default()
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_units_and_files_without_losing_disabled_or_unloaded_units() {
        let units = parse_units(
            "web.service loaded active running Web server\n● failed.service loaded failed failed Failed job\ninvalid;unit.service loaded active running Bad\nshort.service loaded\n",
            "web.service enabled enabled\ncold.service disabled enabled\nfailed.service static -\nmissing.timer enabled enabled\n",
        );
        assert_eq!(units.len(), 3);
        let cold = units.iter().find(|u| u.name == "cold.service").unwrap();
        assert_eq!(
            (&*cold.load, &*cold.active, &*cold.sub, &*cold.enabled),
            ("not-loaded", "inactive", "dead", "disabled")
        );
        assert_eq!(
            units
                .iter()
                .find(|u| u.name == "web.service")
                .unwrap()
                .enabled,
            "enabled"
        );
        assert_eq!(
            units
                .iter()
                .find(|u| u.name == "failed.service")
                .unwrap()
                .active,
            "failed"
        );
    }

    #[test]
    fn keeps_odd_descriptions_and_handles_missing_description_and_file_state() {
        let units = parse_units("odd@x.service loaded active exited A  <tag> 'quoted' — café\nempty.service loaded inactive dead\n", "odd@x.service disabled\nmalformed.service\n");
        assert_eq!(units[0].name, "empty.service");
        assert_eq!(units[0].description, "");
        assert_eq!(units[0].enabled, "unknown");
        assert_eq!(units[1].description, "A  <tag> 'quoted' — café");
        assert_eq!(units[1].enabled, "disabled");
    }

    #[test]
    fn detects_unavailable_user_manager_without_discarding_system_units() {
        let result = parse_read("@system_units\nweb.service loaded active running Web\n@system_files\nweb.service enabled\n@user_units\n@user_files\n@user_status\nunavailable\n").unwrap();
        assert_eq!(result.system.units.len(), 1);
        assert!(!result.user.available);
        assert!(result.user.units.is_empty());
        assert!(result.user.reason.unwrap().contains("lingering"));
    }

    #[test]
    fn accepts_empty_available_user_scope_and_rejects_incomplete_reads() {
        let result = parse_read(
            "@system_units\n@system_files\n@user_units\n@user_files\n@user_status\navailable\n",
        )
        .unwrap();
        assert!(result.user.available);
        assert!(result.user.reason.is_none());
        assert!(parse_read("@system_units\n").is_err());
        assert!(parse_read(
            "@system_units\n@system_files\n@user_units\n@user_files\n@user_status\nwrong\n"
        )
        .is_err());
    }

    #[test]
    fn validates_scope_unit_and_all_five_actions_before_building_commands() {
        for scope in ["system", "user"] {
            for action in ["start", "stop", "restart", "enable", "disable"] {
                assert!(action_argv(scope, "demo@account.service", action).is_ok());
            }
        }
        for (scope, unit, action) in [
            ("root", "a.service", "start"),
            ("user", "-bad.service", "start"),
            ("user", "a;id.service", "start"),
            ("system", "a.service", "reload"),
            ("user", "a.service\n", "start"),
        ] {
            assert_eq!(
                action_argv(scope, unit, action).unwrap_err().kind,
                ErrorKind::InvalidInput
            );
        }
    }

    fn opts() -> RunOpts {
        RunOpts {
            ssh_program: std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join(if cfg!(windows) {
                    "fake-ssh.exe"
                } else {
                    "fake-ssh"
                }),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn system_scope_uses_existing_sudo_and_quotes_arguments() {
        let target = Target {
            host: "echo".into(),
            config: None,
        };
        let result = run_action(
            &target,
            "system",
            "demo@account.service",
            "enable",
            None,
            opts(),
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            "sudo -n -- 'systemctl' 'enable' '--' 'demo@account.service'"
        );
    }

    #[tokio::test]
    async fn user_scope_sets_runtime_directory_quotes_and_never_uses_sudo() {
        let target = Target {
            host: "echo".into(),
            config: None,
        };
        let result = run_action(
            &target,
            "user",
            "demo@account.service",
            "restart",
            None,
            opts(),
        )
        .await
        .unwrap();
        assert!(result.contains(USER_ENV));
        assert!(result.contains("'systemctl' '--user' 'restart' '--' 'demo@account.service'"));
        assert!(!result.contains("sudo"));
        let err = run_action(
            &target,
            "user",
            "demo.service",
            "start",
            Some(Zeroizing::new("secret".into())),
            opts(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn unclassified_mutation_failures_are_unknown_but_auth_trust_and_sudo_stay_typed() {
        for kind in [
            ErrorKind::Timeout,
            ErrorKind::Cancelled,
            ErrorKind::Internal,
        ] {
            let error = mutation_error(AppError::new(kind, "lost contact or remote diagnostic"));
            assert_eq!(error.kind, ErrorKind::OutcomeUnknown);
            assert!(error.message.contains("lost contact or remote diagnostic"));
        }
        for kind in [
            ErrorKind::Unreachable,
            ErrorKind::Remote,
            ErrorKind::InvalidInput,
            ErrorKind::AuthFailed,
            ErrorKind::HostKeyUnknown,
            ErrorKind::HostKeyChanged,
            ErrorKind::SudoRequired,
            ErrorKind::SudoWrongPassword,
            ErrorKind::PermissionDenied,
            ErrorKind::SshMissing,
        ] {
            assert_eq!(
                mutation_error(AppError::new(kind, "definite failure")).kind,
                kind
            );
        }
    }

    #[test]
    fn collector_uses_fixed_plain_english_lists_and_checks_both_user_reads() {
        assert!(READ.contains("export LC_ALL=C"));
        assert!(READ.contains("list-unit-files --type=service --plain --no-legend --no-pager"));
        assert!(READ.contains("list-units --type=service --all --plain --no-legend --no-pager"));
        assert!(READ.contains(USER_ENV));
        assert!(READ.contains("user_files=$(systemctl --user"));
    }
}
