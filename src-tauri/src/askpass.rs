//! NodeScape doubles as ssh's SSH_ASKPASS helper. ssh runs the app exe with the prompt as its argument;
//! the password arrives in the child-only environment variable below and is printed for password prompts only.
pub const SECRET_ENV: &str = "NODESCAPE_ASKPASS";

/// Answer "user@host's password:" and keyboard-interactive "Password:", never key passphrases,
/// host key questions, one-time codes or expired-password changes.
pub fn is_password_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    prompt.contains("password")
        && ![
            "new password",
            "current",
            "retype",
            "passphrase",
            "(yes/no",
            "verification",
            "code",
        ]
        .iter()
        .any(|word| prompt.contains(word))
}

/// Call first thing in main(): exits when this process is an askpass invocation.
pub fn run_if_requested() {
    let Some(secret) = std::env::var_os(SECRET_ENV) else {
        return;
    };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    if is_password_prompt(&prompt) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(secret.to_string_lossy().as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
        std::process::exit(0);
    }
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_password_prompts_only() {
        for prompt in [
            "operator@nas-01's password: ",
            "Password: ",
            "(operator@nas-01) Password:",
        ] {
            assert!(is_password_prompt(prompt), "{prompt}");
        }
        for prompt in [
            "Enter passphrase for key 'C:/Users/me/.ssh/id_ed25519': ",
            "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
            "Verification code: ",
            "(current) UNIX password: ",
            "New password: ",
            "Retype new password: ",
            "",
        ] {
            assert!(!is_password_prompt(prompt), "{prompt}");
        }
    }
}
