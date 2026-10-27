use crate::contracts::{valid_account_name, AppError, ErrorKind, Target};
use crate::sudo;
use crate::transport::{self, RunOpts};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use zeroize::Zeroizing;

const READ: &str = r#"
export LC_ALL=C
printf '@passwd\n'
getent passwd || exit 1
printf '@group\n'
getent group || exit 1
printf '@current\n'
id -un || exit 1
printf '@current_groups\n'
id -Gn || exit 1
printf '@sudo\n'
getent group sudo admin wheel
s=$?
[ "$s" -eq 0 ] || [ "$s" -eq 2 ]
"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
    pub shell: String,
    pub groups: Vec<String>,
    pub system: bool,
    pub login: bool,
}

#[derive(Debug, Serialize)]
pub struct Group {
    pub name: String,
    pub gid: u32,
    pub members: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    pub users: Vec<Account>,
    pub groups: Vec<Group>,
    pub sudo_groups: Vec<String>,
    pub current_user: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountArgs {
    pub name: String,
    #[serde(default)]
    pub groups: Vec<String>,
    pub group: Option<String>,
    #[serde(default)]
    pub remove_home: bool,
}

fn passwd(line: &str) -> Option<Account> {
    let f: Vec<_> = line.split(':').collect();
    if f.len() != 7 || f[0].is_empty() {
        return None;
    }
    let uid = f[2].parse().ok()?;
    Some(Account {
        name: f[0].into(),
        uid,
        gid: f[3].parse().ok()?,
        home: f[5].into(),
        shell: f[6].into(),
        groups: vec![],
        system: !(1000..65534).contains(&uid),
        login: !["nologin", "false"].contains(&f[6].rsplit('/').next().unwrap_or_default()),
    })
}

fn group(line: &str) -> Option<Group> {
    let f: Vec<_> = line.split(':').collect();
    if f.len() != 4 || f[0].is_empty() {
        return None;
    }
    Some(Group {
        name: f[0].into(),
        gid: f[2].parse().ok()?,
        members: f[3]
            .split(',')
            .filter(|m| !m.is_empty())
            .map(String::from)
            .collect(),
    })
}

fn parse(text: &str) -> Result<Accounts, AppError> {
    let mut sections: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut section = "";
    for line in text.lines() {
        if ["@passwd", "@group", "@current", "@current_groups", "@sudo"].contains(&line) {
            section = line;
            sections.entry(section).or_default();
        } else if !line.is_empty() {
            sections.entry(section).or_default().push(line);
        }
    }
    let incomplete = || {
        AppError::new(
            ErrorKind::Remote,
            "Incomplete accounts response; no action was taken",
        )
    };
    if ["@passwd", "@group", "@current", "@current_groups", "@sudo"]
        .iter()
        .any(|s| !sections.contains_key(s))
    {
        return Err(incomplete());
    }
    let current = &sections["@current"];
    if current.len() != 1 || sections["@current_groups"].is_empty() {
        return Err(incomplete());
    }
    let mut users: Vec<_> = sections["@passwd"]
        .iter()
        .filter_map(|l| passwd(l))
        .collect();
    let mut groups: Vec<_> = sections["@group"].iter().filter_map(|l| group(l)).collect();
    if !users.iter().any(|u| u.name == current[0]) || groups.is_empty() {
        return Err(incomplete());
    }
    let mut sudo_groups = vec![];
    for g in sections["@sudo"].iter().filter_map(|l| group(l)) {
        if !["sudo", "admin", "wheel"].contains(&g.name.as_str()) {
            continue;
        }
        if !sudo_groups.contains(&g.name) {
            sudo_groups.push(g.name.clone());
        }
        if let Some(existing) = groups.iter_mut().find(|existing| existing.name == g.name) {
            for member in g.members {
                if !existing.members.contains(&member) {
                    existing.members.push(member);
                }
            }
        } else {
            groups.push(g);
        }
    }
    for user in &mut users {
        user.groups = groups
            .iter()
            .filter(|g| g.gid == user.gid || g.members.contains(&user.name))
            .map(|g| g.name.clone())
            .collect();
        if user.name == current[0] {
            for name in sections["@current_groups"]
                .iter()
                .flat_map(|l| l.split_whitespace())
            {
                if !user.groups.iter().any(|g| g == name) {
                    user.groups.push(name.into());
                }
            }
        }
    }
    Ok(Accounts {
        users,
        groups,
        sudo_groups,
        current_user: current[0].into(),
    })
}

fn validate(action: &str, args: &AccountArgs) -> Result<(), AppError> {
    if ![
        "create_user",
        "delete_user",
        "add_to_group",
        "remove_from_group",
    ]
    .contains(&action)
        || !valid_account_name(&args.name)
        || args.groups.iter().any(|g| !valid_account_name(g))
        || args.group.as_ref().is_some_and(|g| !valid_account_name(g))
        || (["add_to_group", "remove_from_group"].contains(&action) && args.group.is_none())
    {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid account name, group name or account action",
        ));
    }
    Ok(())
}

fn build_argv(action: &str, args: &AccountArgs, data: &Accounts) -> Result<Vec<String>, AppError> {
    validate(action, args)?;
    let user = data.users.iter().find(|u| u.name == args.name);
    if action == "create_user" {
        if user.is_some() {
            return Err(AppError::new(ErrorKind::Conflict, "User already exists"));
        }
    } else {
        let user =
            user.ok_or_else(|| AppError::new(ErrorKind::NotFound, "User no longer exists"))?;
        if ["delete_user", "remove_from_group"].contains(&action)
            && (user.name == "root"
                || user.uid < 1000
                || user.system
                || user.name == data.current_user)
        {
            return Err(AppError::new(
                ErrorKind::PermissionDenied,
                "Refused: cannot delete or demote root, the current SSH user, or a system account",
            ));
        }
    }
    for name in args.groups.iter().chain(args.group.iter()) {
        if !data.groups.iter().any(|g| &g.name == name) {
            return Err(AppError::new(
                ErrorKind::NotFound,
                format!("Group does not exist: {name}"),
            ));
        }
    }
    if action == "remove_from_group"
        && data
            .groups
            .iter()
            .any(|g| Some(&g.name) == args.group.as_ref() && Some(g.gid) == user.map(|u| u.gid))
    {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Cannot remove a user's primary group",
        ));
    }
    let mut argv = match action {
        "create_user" => vec!["useradd", "-m", "-s", "/bin/bash"],
        "delete_user" => vec!["userdel"],
        "add_to_group" => vec!["gpasswd", "-a"],
        "remove_from_group" => vec!["gpasswd", "-d"],
        _ => unreachable!(),
    }
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    if action == "create_user" && !args.groups.is_empty() {
        argv.extend(["-G".into(), args.groups.join(",")]);
    }
    if action == "delete_user" && args.remove_home {
        argv.push("-r".into());
    }
    if ["create_user", "delete_user"].contains(&action) {
        argv.push("--".into());
    }
    argv.push(args.name.clone());
    if ["add_to_group", "remove_from_group"].contains(&action) {
        argv.push(args.group.clone().expect("validated group"));
    }
    Ok(argv)
}

fn mutation_error(error: AppError) -> AppError {
    match error.kind {
        ErrorKind::Timeout
        | ErrorKind::Cancelled
        | ErrorKind::Unreachable
        | ErrorKind::Internal
        | ErrorKind::Remote => AppError::new(
            ErrorKind::OutcomeUnknown,
            format!(
                "Account action outcome unknown. Refresh before taking another action. {}",
                error.message
            ),
        ),
        _ => error,
    }
}

#[tauri::command]
pub async fn accounts_read(
    target: Target,
    operation_id: Option<String>,
) -> Result<Accounts, AppError> {
    let output = transport::run(
        &target,
        READ,
        RunOpts {
            operation_id,
            ..Default::default()
        },
    )
    .await?;
    parse(&output)
}

#[tauri::command]
pub async fn account_action(
    target: Target,
    action: String,
    args: AccountArgs,
    password: Option<String>,
    operation_id: Option<String>,
) -> Result<String, AppError> {
    let password = password.map(Zeroizing::new);
    validate(&action, &args)?;
    // Re-read on each action (including sudo submissions) so protection never relies on UI state.
    let data = accounts_read(target.clone(), operation_id.clone()).await?;
    let argv = build_argv(&action, &args, &data)?;
    let argv: Vec<_> = argv.iter().map(String::as_str).collect();
    sudo::run_privileged(
        &target,
        &argv,
        password,
        RunOpts {
            operation_id,
            ..Default::default()
        },
    )
    .await
    .map_err(mutation_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Accounts {
        parse("@passwd\nroot:x:0:0::/root:/bin/bash\nalice:x:1000:1000::/home/alice:/bin/bash\noperator:x:1001:1001::/home/operator:/bin/zsh\ndaemon:x:2:2::/:/usr/sbin/nologin\nnobody:x:65534:65534::/:/bin/false\n@group\nroot:x:0:\nalice:x:1000:\noperator:x:1001:\nsudo:x:27:alice\nteam:x:2000:alice,operator\n@current\noperator\n@current_groups\noperator team admin\n@sudo\nsudo:x:27:alice\nadmin:x:80:\n").unwrap()
    }
    fn args(name: &str) -> AccountArgs {
        AccountArgs {
            name: name.into(),
            groups: vec![],
            group: None,
            remove_home: false,
        }
    }

    #[test]
    fn parses_passwd_and_group_records() {
        let d = data();
        assert_eq!(d.users.len(), 5);
        let alice = &d.users[1];
        assert_eq!((alice.uid, alice.gid), (1000, 1000));
        assert_eq!(alice.home, "/home/alice");
        assert_eq!(alice.shell, "/bin/bash");
        assert_eq!(alice.groups, ["alice", "sudo", "team"]);
        assert!(!alice.system && alice.login);
        assert!(d.users[0].system && d.users[0].login);
        assert!(d.users[3].system && !d.users[3].login);
        assert!(d.users[4].system && !d.users[4].login);
        assert!(d.groups[0].members.is_empty());
        assert_eq!(d.groups[4].members, ["alice", "operator"]);
        assert_eq!(d.current_user, "operator");
    }

    #[test]
    fn sudo_includes_primary_supplementary_and_current_id_membership() {
        let d = data();
        assert_eq!(d.sudo_groups, ["sudo", "admin"]);
        assert!(d.users[1].groups.contains(&"sudo".into()));
        assert!(d.users[2].groups.contains(&"admin".into()));
        let d = parse("@passwd\na:x:1000:27::/:/bin/bash\n@group\nsudo:x:27:\n@current\na\n@current_groups\nsudo\n@sudo\nsudo:x:27:\n").unwrap();
        assert_eq!(d.users[0].groups, ["sudo"]);
    }

    #[test]
    fn odd_shells_and_malformed_records_are_handled() {
        let d = parse("@passwd\na:x:1000:1000::/:/opt/odd shell\nb:x:1001:1000::/:\nc:x:1002:1000::/:/opt/false\nd:x:1003:1000::/:/opt/nologin\nbad:x:no:1::/:/bin/bash\nshort:x:1\n@group\nusers:x:1000:\nbad:x:no:\nshort:x\n@current\na\n@current_groups\nusers\n@sudo\n").unwrap();
        assert_eq!(d.users.len(), 4);
        assert!(d.users[0].login && d.users[1].login);
        assert!(!d.users[2].login && !d.users[3].login);
        assert_eq!(d.groups.len(), 1);
    }

    #[test]
    fn many_groups_are_not_truncated() {
        let groups = (0..200)
            .map(|i| format!("g{i}:x:{}:a\n", i + 2000))
            .collect::<String>();
        let d = parse(&format!("@passwd\na:x:1000:1000::/:/bin/bash\n@group\n{groups}@current\na\n@current_groups\ng0\n@sudo\n")).unwrap();
        assert_eq!(d.users[0].groups.len(), 200);
    }

    #[test]
    fn incomplete_reads_fail_closed() {
        for text in [
            "",
            "@passwd\n@group\n@current\nmissing\n@current_groups\nusers\n@sudo\n",
        ] {
            assert_eq!(parse(text).unwrap_err().kind, ErrorKind::Remote);
        }
    }

    #[test]
    fn constructs_every_fixed_argv() {
        let d = data();
        let mut a = args("newuser");
        assert_eq!(
            build_argv("create_user", &a, &d).unwrap(),
            ["useradd", "-m", "-s", "/bin/bash", "--", "newuser"]
        );
        a.groups = vec!["team".into(), "sudo".into()];
        assert_eq!(
            build_argv("create_user", &a, &d).unwrap(),
            [
                "useradd",
                "-m",
                "-s",
                "/bin/bash",
                "-G",
                "team,sudo",
                "--",
                "newuser"
            ]
        );
        a = args("alice");
        assert_eq!(
            build_argv("delete_user", &a, &d).unwrap(),
            ["userdel", "--", "alice"]
        );
        a.remove_home = true;
        assert_eq!(
            build_argv("delete_user", &a, &d).unwrap(),
            ["userdel", "-r", "--", "alice"]
        );
        a = args("alice");
        a.group = Some("team".into());
        assert_eq!(
            build_argv("add_to_group", &a, &d).unwrap(),
            ["gpasswd", "-a", "alice", "team"]
        );
        assert_eq!(
            build_argv("remove_from_group", &a, &d).unwrap(),
            ["gpasswd", "-d", "alice", "team"]
        );
    }

    #[test]
    fn refuses_delete_and_demote_of_every_protected_account() {
        let d = data();
        for name in ["root", "operator", "daemon", "nobody"] {
            for action in ["delete_user", "remove_from_group"] {
                let mut a = args(name);
                a.group = Some("team".into());
                let e = build_argv(action, &a, &d).unwrap_err();
                assert_eq!(e.kind, ErrorKind::PermissionDenied, "{name} {action}");
                assert!(e.message.contains("Refused"));
            }
        }
        let mut d = data();
        d.users[1].uid = 0;
        assert!(build_argv("delete_user", &args("alice"), &d).is_err());
    }

    #[test]
    fn refuses_duplicate_missing_user_and_missing_group() {
        let d = data();
        let e = build_argv("create_user", &args("alice"), &d).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert!(e.message.contains("already exists"));
        assert_eq!(
            build_argv("delete_user", &args("missing"), &d)
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
        let mut a = args("alice");
        a.group = Some("missing".into());
        assert_eq!(
            build_argv("add_to_group", &a, &d).unwrap_err().kind,
            ErrorKind::NotFound
        );
        a = args("newuser");
        a.groups = vec!["missing".into()];
        assert_eq!(
            build_argv("create_user", &a, &d).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn validates_every_user_and_group_value_and_action() {
        let d = data();
        for name in [
            "", "-r", "a;id", "a$(id)", "a,b", "a b", "a\n", "a'", "UPPER",
        ] {
            assert_eq!(
                build_argv("create_user", &args(name), &d).unwrap_err().kind,
                ErrorKind::InvalidInput
            );
            let mut a = args("newuser");
            a.groups = vec![name.into()];
            assert_eq!(
                build_argv("create_user", &a, &d).unwrap_err().kind,
                ErrorKind::InvalidInput
            );
            a = args("alice");
            a.group = Some(name.into());
            assert_eq!(
                build_argv("add_to_group", &a, &d).unwrap_err().kind,
                ErrorKind::InvalidInput
            );
        }
        assert_eq!(
            build_argv("exec", &args("alice"), &d).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
        assert_eq!(
            build_argv("add_to_group", &args("alice"), &d)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn primary_group_removal_is_refused() {
        let mut a = args("alice");
        a.group = Some("alice".into());
        assert_eq!(
            build_argv("remove_from_group", &a, &data())
                .unwrap_err()
                .kind,
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn mutation_disconnects_are_unknown_but_explicit_refusals_stay_typed() {
        for kind in [
            ErrorKind::Timeout,
            ErrorKind::Cancelled,
            ErrorKind::Unreachable,
            ErrorKind::Internal,
            ErrorKind::Remote,
        ] {
            assert_eq!(
                mutation_error(AppError::new(kind, "lost")).kind,
                ErrorKind::OutcomeUnknown
            );
        }
        for kind in [
            ErrorKind::SudoRequired,
            ErrorKind::SudoWrongPassword,
            ErrorKind::PermissionDenied,
            ErrorKind::HostKeyChanged,
            ErrorKind::AuthFailed,
        ] {
            assert_eq!(mutation_error(AppError::new(kind, "refused")).kind, kind);
        }
    }
    #[test]
    fn system_uid_boundaries_are_exact() {
        for (uid, system) in [
            (999, true),
            (1000, false),
            (65533, false),
            (65534, true),
            (65535, true),
        ] {
            let user = passwd(&format!("sample:x:{uid}:1000::/:/bin/bash")).unwrap();
            assert_eq!(user.system, system);
        }
    }

    #[tokio::test]
    async fn ipc_validation_runs_before_transport() {
        for action in [
            "create_user",
            "delete_user",
            "add_to_group",
            "remove_from_group",
            "exec",
        ] {
            let error = account_action(
                Target {
                    host: "invalid host".into(),
                    config: None,
                },
                action.into(),
                args("bad;name"),
                None,
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidInput);
            assert!(error.message.starts_with("Invalid account name"));
        }
    }
}
