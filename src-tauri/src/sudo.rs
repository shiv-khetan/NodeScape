use crate::contracts::{AppError, ErrorKind, Target};
use crate::transport::{self, RunOpts};
use zeroize::Zeroizing;

fn quote_into(script: &mut String, value: &str) {
    script.push('\'');
    for c in value.chars() {
        if c == '\'' {
            script.push_str("'\\''");
        } else {
            script.push(c);
        }
    }
    script.push('\'');
}

const SUDO_STATUS: &str = r#"
if ! command -v sudo >/dev/null 2>&1; then echo missing
elif sudo -n true 2>/dev/null; then echo passwordless
elif id -nG | tr ' ' '\n' | grep -qxE 'sudo|wheel|admin'; then echo password
else echo none; fi
"#;

/// How admin actions will behave for this SSH account: "passwordless", "password" (asked per action),
/// "none" (not in a sudo group, so admin actions will likely be refused) or "missing" (no sudo installed).
pub fn parse_sudo_status(output: &str) -> &'static str {
    match output.trim() {
        "passwordless" => "passwordless",
        "password" => "password",
        "missing" => "missing",
        _ => "none",
    }
}

#[tauri::command]
pub async fn sudo_status(target: Target) -> Result<&'static str, AppError> {
    let output = transport::run(&target, SUDO_STATUS, RunOpts::default()).await?;
    Ok(parse_sudo_status(&output))
}

/// Callers must validate argv and choose a fixed command; this is never exposed as an IPC command.
pub async fn run_privileged(
    target: &Target,
    argv: &[&str],
    password: Option<Zeroizing<String>>,
    mut opts: RunOpts,
) -> Result<String, AppError> {
    if password
        .as_ref()
        .is_some_and(|p| p.contains(['\0', '\r', '\n']))
    {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Sudo passwords cannot contain NUL, CR or LF",
        ));
    }
    if argv.is_empty() || argv.iter().any(|arg| arg.contains('\0')) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid privileged command",
        ));
    }
    // Reserve before inserting the secret, so script growth cannot free password copies.
    let capacity = 128
        + argv.iter().map(|arg| arg.len() * 4 + 3).sum::<usize>()
        + password.as_ref().map_or(0, |p| p.len() * 4 + 2);
    let mut script = Zeroizing::new(String::with_capacity(capacity));
    if let Some(password) = &password {
        script.push_str("P=");
        quote_into(&mut script, password);
        script.push_str("; printf '%s\\n' \"$P\" | sudo -S -k -p '' --");
    } else {
        script.push_str("sudo -n --");
    }
    for arg in argv {
        script.push(' ');
        quote_into(&mut script, arg);
    }
    if password.is_some() {
        script.push_str("; s=$?; unset P; exit $s");
    }
    opts.redact = password;
    transport::run(target, &script, opts).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{classify_ssh_failure, ErrorKind};
    use std::time::Duration;

    fn target(host: &str) -> Target {
        Target {
            host: host.into(),
            config: None,
        }
    }

    fn opts() -> RunOpts {
        let program = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(if cfg!(windows) {
                "fake-ssh.exe"
            } else {
                "fake-ssh"
            });
        assert!(
            program.is_file(),
            "cargo test must build the fake-ssh helper"
        );
        RunOpts {
            ssh_program: program,
            timeout: Duration::from_secs(3),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn no_password_uses_noninteractive_sudo_and_quotes_every_argument() {
        let output = run_privileged(
            &target("echo"),
            &["systemctl", "restart", "--", "test.service"],
            None,
            opts(),
        )
        .await
        .unwrap();
        assert_eq!(
            output,
            "sudo -n -- 'systemctl' 'restart' '--' 'test.service'"
        );
        let output = run_privileged(
            &target("echo"),
            &["printf", "", "a'b", "$(id); x"],
            None,
            opts(),
        )
        .await
        .unwrap();
        assert_eq!(output, "sudo -n -- 'printf' '' 'a'\\''b' '$(id); x'");
    }

    #[tokio::test]
    async fn password_is_only_in_stdin_with_builtin_printf_and_never_in_ssh_argv() {
        let output = run_privileged(
            &target("sudo-audit"),
            &["systemctl", "restart", "--", "test.service"],
            Some(Zeroizing::new("p'ass $word;💫".into())),
            opts(),
        )
        .await
        .unwrap();
        assert_eq!(output, "verified stdin and argv");
    }

    #[tokio::test]
    async fn password_is_scrubbed_before_errors_are_capped_in_both_output_streams() {
        for host in ["sudo-stderr", "sudo-stdout"] {
            let error = run_privileged(
                &target(host),
                &["systemctl", "restart", "--", "test.service"],
                Some(Zeroizing::new("p'ass $word;💫".into())),
                opts(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::SudoWrongPassword);
            assert!(!error.message.contains("p'ass"));
            assert!(!error.message.contains("p'\\''ass"));
            assert!(!error.message.contains("$word"));
            assert!(error.message.contains("[redacted]"));
            assert_eq!(error.message.chars().count(), 4000);
        }
    }

    #[tokio::test]
    async fn successful_output_is_also_scrubbed() {
        let output = run_privileged(
            &target("echo"),
            &["true"],
            Some(Zeroizing::new("p'ass $word;💫".into())),
            opts(),
        )
        .await
        .unwrap();
        assert!(output.starts_with("P='[redacted]'; printf '%s\\n'"));
        assert!(!output.contains("$word"));
    }

    #[tokio::test]
    async fn rejects_password_controls_before_starting_ssh() {
        for value in ["bad\0password", "bad\rpassword", "bad\npassword"] {
            let options = RunOpts {
                ssh_program: "missing-sudo-test-ssh".into(),
                ..Default::default()
            };
            let error = run_privileged(
                &target("testbox"),
                &["true"],
                Some(Zeroizing::new(value.into())),
                options,
            )
            .await
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidInput);
            assert!(!error.message.contains(value));
        }
    }

    #[tokio::test]
    async fn redaction_preserves_classification_when_password_is_a_diagnostic_word() {
        let error = run_privileged(
            &target("exit-sudo-wrong"),
            &["true"],
            Some(Zeroizing::new("password".into())),
            opts(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::SudoWrongPassword);
        assert_eq!(error.message, "sudo: 1 incorrect [redacted] attempt");
    }

    #[tokio::test]
    async fn rejects_empty_commands_and_nul_arguments() {
        for argv in [&[][..], &["true", "bad\0argument"][..]] {
            let error = run_privileged(&target("testbox"), argv, None, RunOpts::default())
                .await
                .unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn classifies_sudo_policy_denials_and_explains_requiretty() {
        for message in [
            "testuser is not in the sudoers file",
            "testuser is not allowed to execute '/usr/bin/systemctl'",
        ] {
            for (stderr, stdout) in [(message, ""), ("", message)] {
                assert_eq!(
                    classify_ssh_failure(stderr, stdout, Some(1)).kind,
                    ErrorKind::PermissionDenied
                );
            }
        }
        let error =
            classify_ssh_failure("sudo: sorry, you must have a tty to run sudo", "", Some(1));
        assert_eq!(error.kind, ErrorKind::Remote);
        assert!(error.message.contains("requiretty"));
    }

    #[test]
    fn sudo_status_maps_unknown_output_to_none() {
        for (out, want) in [
            (
                "passwordless
",
                "passwordless",
            ),
            ("password", "password"),
            ("missing", "missing"),
            ("none", "none"),
            ("", "none"),
            ("garbage", "none"),
        ] {
            assert_eq!(parse_sudo_status(out), want);
        }
    }
}
