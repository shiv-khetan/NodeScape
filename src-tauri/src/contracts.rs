use serde::{Deserialize, Serialize};
use std::fmt;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub host: String,
    pub config: Option<String>,
}

// P01 defines the shared vocabulary; later packages use the remaining kinds.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    InvalidInput,
    Conflict,
    SshMissing,
    AuthFailed,
    HostKeyUnknown,
    HostKeyChanged,
    Unreachable,
    Timeout,
    PermissionDenied,
    NotFound,
    SudoRequired,
    SudoWrongPassword,
    Cancelled,
    OutcomeUnknown,
    Remote,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl AsRef<str>) -> Self {
        Self {
            kind,
            message: message.as_ref().chars().take(4000).collect(),
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

pub fn classify_ssh_failure(stderr: &str, stdout: &str, status: Option<i32>) -> AppError {
    classify_ssh_failure_redacted(stderr, stdout, status, None)
}

pub(crate) fn classify_ssh_failure_redacted(
    stderr: &str,
    stdout: &str,
    status: Option<i32>,
    password: Option<&str>,
) -> AppError {
    let message = Zeroizing::new(if !stderr.trim().is_empty() {
        stderr.to_owned()
    } else if !stdout.trim().is_empty() {
        stdout.to_owned()
    } else {
        match status {
            Some(code) => format!("ssh exited with {code}"),
            None => "ssh exited without an exit code".into(),
        }
    });
    let text = Zeroizing::new(format!("{stderr}\n{stdout}"));
    let kind = if text.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        ErrorKind::HostKeyChanged
    } else if text.contains("Host key verification failed")
        || (text.contains("host key is known") && text.contains("strict checking"))
    {
        ErrorKind::HostKeyUnknown
    } else if [
        "Permission denied (publickey",
        "Permission denied (password",
        "Too many authentication failures",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        ErrorKind::AuthFailed
    } else if ["Connection timed out", "Operation timed out"]
        .iter()
        .any(|s| text.contains(s))
    {
        ErrorKind::Timeout
    } else if [
        "Could not resolve hostname",
        "No route to host",
        "Connection refused",
        "Network is unreachable",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        ErrorKind::Unreachable
    } else if text.contains("is not in the sudoers file") || text.contains("not allowed to execute")
    {
        ErrorKind::PermissionDenied
    } else if text.contains("you must have a tty") {
        return AppError::new(
            ErrorKind::Remote,
            "The server sudo requiretty policy requires an interactive terminal. Run this action in a terminal or ask the server administrator to review requiretty.",
        );
    } else if text.contains("sudo: a password is required") {
        ErrorKind::SudoRequired
    } else if ["Sorry, try again", "incorrect password attempt"]
        .iter()
        .any(|s| text.contains(s))
    {
        ErrorKind::SudoWrongPassword
    } else if text.contains("Permission denied") {
        ErrorKind::PermissionDenied
    } else if text.contains("No such file or directory") {
        ErrorKind::NotFound
    } else {
        ErrorKind::Remote
    };
    AppError::new(kind, redact_text(&message, password))
}

pub(crate) fn redact_text(value: &str, password: Option<&str>) -> Zeroizing<String> {
    let mut text = Zeroizing::new(value.to_owned());
    if let Some(secret) = password.filter(|secret| !secret.is_empty()) {
        let escaped = Zeroizing::new(secret.replace('\'', "'\\''"));
        text = Zeroizing::new(text.replace(escaped.as_str(), "[redacted]"));
        text = Zeroizing::new(text.replace(secret, "[redacted]"));
    }
    text
}

pub fn valid_host(h: &str) -> bool {
    // '%' allows IPv6 link-local zones like fe80::1%14.
    !h.is_empty()
        && !h.starts_with('-')
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._-:%".contains(c))
}

pub fn valid_local_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && !path.chars().any(char::is_control)
}

pub fn valid_public_key(key: &str) -> bool {
    if key.len() > 16384
        || key
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || " -_@./+=".contains(c)))
    {
        return false;
    }
    let mut fields = key.split(' ');
    let prefix = fields.next().unwrap_or_default();
    let body = fields.next().unwrap_or_default();
    [
        "ssh-ed25519",
        "ssh-rsa",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
    ]
    .contains(&prefix)
        && body.len() >= 4
        && body.len().is_multiple_of(4)
        && body
            .trim_end_matches('=')
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"+/".contains(&c))
        && body.len() - body.trim_end_matches('=').len() <= 2
}

pub fn valid_unit(u: &str) -> bool {
    !u.is_empty()
        && !u.starts_with('-')
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._:-".contains(c))
}

// Account and file commands are introduced by later packages.
#[allow(dead_code)]
pub fn valid_account_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && (bytes[0].is_ascii_lowercase() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_-".contains(c))
}

#[allow(dead_code)]
pub fn valid_remote_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= 4096 && !path.contains(['\0', '\n'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    #[test]
    fn ssh_failure_mappings() {
        use ErrorKind::*;
        for (text, kind) in [
            ("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\r\nHost key verification failed.", HostKeyChanged),
            ("Host key verification failed.", HostKeyUnknown),
            ("No ED25519 host key is known for x and you have requested strict checking.\r\nHost key verification failed.", HostKeyUnknown),
            ("No ED25519 host key is known for x and you have requested strict checking.", HostKeyUnknown),
            ("testuser@testbox: Permission denied (publickey).", AuthFailed),
            ("testuser@testbox: Permission denied (password).", AuthFailed),
            ("Received disconnect from testbox port 22:2: Too many authentication failures", AuthFailed),
            ("ssh: connect to host testbox port 22: Connection timed out", Timeout),
            ("ssh: connect to host testbox port 22: Operation timed out", Timeout),
            ("ssh: Could not resolve hostname testbox: Name or service not known", Unreachable),
            ("ssh: connect to host testbox port 22: No route to host", Unreachable),
            ("ssh: connect to host testbox port 22: Connection refused", Unreachable),
            ("ssh: connect to host testbox port 22: Network is unreachable", Unreachable),
            ("sudo: a password is required", SudoRequired),
            ("Sorry, try again.", SudoWrongPassword),
            ("sudo: 1 incorrect password attempt", SudoWrongPassword),
            ("cat: /restricted: Permission denied", PermissionDenied),
            ("cat: /missing: No such file or directory", NotFound),
            ("remote collector failed", Remote),
        ] {
            let err = classify_ssh_failure(text, "", Some(255));
            assert_eq!(err.kind, kind, "{text}");
            assert_eq!(err.message, text);
            assert_eq!(classify_ssh_failure("", text, Some(1)).kind, kind);
        }
    }

    #[test]
    fn classification_is_conservative_and_ordered() {
        assert_eq!(
            classify_ssh_failure("host key is known", "", Some(255)).kind,
            ErrorKind::Remote
        );
        assert_eq!(
            classify_ssh_failure("Connection refused\nPermission denied", "", Some(1)).kind,
            ErrorKind::Unreachable
        );
        assert_eq!(
            classify_ssh_failure("custom error\r\n", "output", Some(1)).message,
            "custom error\r\n"
        );
        assert_eq!(
            classify_ssh_failure("", "custom output\n", None).message,
            "custom output\n"
        );
        assert_eq!(
            classify_ssh_failure("", "", Some(42)).message,
            "ssh exited with 42"
        );
        assert_eq!(classify_ssh_failure("", "", None).kind, ErrorKind::Remote);
    }

    #[test]
    fn error_json_shape_and_display() {
        use ErrorKind::*;
        for (kind, name) in [
            (InvalidInput, "invalid_input"),
            (Conflict, "conflict"),
            (SshMissing, "ssh_missing"),
            (AuthFailed, "auth_failed"),
            (HostKeyUnknown, "host_key_unknown"),
            (HostKeyChanged, "host_key_changed"),
            (Unreachable, "unreachable"),
            (Timeout, "timeout"),
            (PermissionDenied, "permission_denied"),
            (NotFound, "not_found"),
            (SudoRequired, "sudo_required"),
            (SudoWrongPassword, "sudo_wrong_password"),
            (Cancelled, "cancelled"),
            (OutcomeUnknown, "outcome_unknown"),
            (Remote, "remote"),
            (Internal, "internal"),
        ] {
            let err = AppError::new(kind, "example");
            let InvokeResponseBody::Json(json) = (&err).body().unwrap() else {
                panic!("expected JSON")
            };
            assert_eq!(json, format!(r#"{{"kind":"{name}","message":"example"}}"#));
            assert_eq!(err.to_string(), "example");
            let _: &dyn std::error::Error = &err;
        }
    }

    #[test]
    fn messages_are_capped_by_characters() {
        for len in [3999, 4000, 4001] {
            let err = AppError::new(ErrorKind::Remote, "é".repeat(len));
            assert_eq!(err.message.chars().count(), len.min(4000));
        }
        assert_eq!(
            classify_ssh_failure(&"x".repeat(5000), "", Some(1))
                .message
                .len(),
            4000
        );
    }

    #[test]
    fn target_shape() {
        let target = Target {
            host: "testbox".into(),
            config: None,
        };
        let InvokeResponseBody::Json(json) = target.body().unwrap() else {
            panic!("expected JSON")
        };
        assert_eq!(json, r#"{"host":"testbox","config":null}"#);
    }

    #[test]
    fn host_validation() {
        for host in ["testbox", "testuser@testbox", "10.0.0.2", "fe80::1%14"] {
            assert!(valid_host(host), "{host}");
        }
        for host in [
            "",
            "-oProxyCommand=x",
            "a b",
            "x;rm",
            "../etc",
            "x\0",
            "x\n",
        ] {
            assert!(!valid_host(host), "{host}");
        }
    }

    #[test]
    fn unit_validation() {
        for unit in ["nginx.service", "getty@tty1.service", "test-unit.timer"] {
            assert!(valid_unit(unit), "{unit}");
        }
        for unit in [
            "",
            "-oProxyCommand=x",
            "a b",
            "x;rm",
            "../etc",
            "a$(id)",
            "x\0",
            "x\n",
        ] {
            assert!(!valid_unit(unit), "{unit}");
        }
    }

    #[test]
    fn account_validation() {
        for name in ["testuser", "_", "_test", "test-user_2", &"a".repeat(32)] {
            assert!(valid_account_name(name), "{name}");
        }
        for name in [
            "",
            "1user",
            "User",
            "test$",
            "-oProxyCommand=x",
            "a b",
            "x;rm",
            "../etc",
            "é",
            "x\0",
            "x\n",
            &"a".repeat(33),
        ] {
            assert!(!valid_account_name(name), "{name}");
        }
    }

    #[test]
    fn path_validation() {
        for path in [
            "/",
            "/etc",
            "/test path/file",
            "/é",
            &format!("/{}", "a".repeat(4095)),
        ] {
            assert!(valid_remote_path(path));
        }
        for path in [
            "",
            "relative",
            "../etc",
            "-oProxyCommand=x",
            "a b",
            "x;rm",
            "/x\0",
            "/x\n",
            &format!("/{}", "a".repeat(4096)),
            &format!("/{}", "é".repeat(2048)),
        ] {
            assert!(!valid_remote_path(path));
        }
    }
}
