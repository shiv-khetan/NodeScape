use crate::{
    contracts::{AppError, Target},
    transport::{execute, RunOpts},
};
use std::collections::HashMap;

pub async fn effective(target: &Target) -> Result<HashMap<String, String>, AppError> {
    let output = execute(target, None, RunOpts::default()).await?;
    let mut values = HashMap::new();
    for line in output.lines() {
        if let Some((key, value)) = line.split_once(' ') {
            // OpenSSH may emit repeated keys (e.g. identityfile); retain the first value.
            values
                .entry(key.to_owned())
                .or_insert_with(|| value.to_owned());
        }
    }
    Ok(values)
}

use crate::contracts::{valid_host, valid_local_path, ErrorKind};
use serde::Deserialize;
use std::{path::Path, sync::Mutex};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedServer {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u32,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub auth: Auth,
    /// One jump host, `[user@]host[:port]`, written as ProxyJump.
    #[serde(default)]
    pub jump: Option<String>,
}

#[derive(Deserialize, Default, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    #[default]
    Key,
    /// The password is typed at connect time (and optionally saved encrypted), never written here.
    Password,
}
fn invalid(message: &str) -> AppError {
    AppError::new(ErrorKind::InvalidInput, message)
}
fn token(value: &str, extra: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || extra.as_bytes().contains(&c))
}
fn render_block(server: &ManagedServer) -> Result<String, AppError> {
    if !valid_host(&server.alias) || !token(&server.alias, "._-") {
        return Err(invalid(
            "Invalid server alias. Use letters, numbers, dot, underscore or hyphen.",
        ));
    }
    if !valid_host(&server.hostname) || !token(&server.hostname, ".-:%") {
        return Err(invalid("Invalid hostname or IP address"));
    }
    if !token(&server.user, "._-") {
        return Err(invalid("Invalid SSH user"));
    }
    if !(1..=65535).contains(&server.port) {
        return Err(invalid("Port must be 1–65535"));
    }
    let mut block = format!(
        "Host {}\n  HostName {}\n  User {}\n  Port {}\n",
        server.alias, server.hostname, server.user, server.port
    );
    match server.auth {
        Auth::Key => {
            let identity = server.identity_file.as_deref().unwrap_or("");
            if !valid_local_path(identity)
                || identity.contains(['%', '$', '"'])
                || !Path::new(identity).is_absolute()
                || !Path::new(identity).is_file()
            {
                return Err(invalid("Choose an existing identity file with an absolute path (no percent, dollar or quote characters)"));
            }
            block += &format!(
                "  IdentityFile \"{}\"\n  IdentitiesOnly yes\n",
                identity.replace('\\', "/")
            );
        }
        Auth::Password => {
            block += "  PreferredAuthentications password,keyboard-interactive\n  PubkeyAuthentication no\n";
        }
    }
    if let Some(jump) = server
        .jump
        .as_deref()
        .map(str::trim)
        .filter(|j| !j.is_empty())
    {
        // One hop only; the transport re-validates it before every connection.
        if jump.contains(',') || !token(jump, "._-@:[]") {
            return Err(invalid(
                "Invalid jump host. Use [user@]host[:port] (one hop).",
            ));
        }
        block += &format!("  ProxyJump {jump}\n");
    }
    Ok(block)
}
fn write_managed(path: &Path, server: &ManagedServer) -> Result<(), AppError> {
    static WRITES: Mutex<()> = Mutex::new(());
    let block = render_block(server)?;
    let _guard = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let old = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(AppError::new(ErrorKind::Internal, e.to_string())),
    };
    let mut blocks = String::new();
    let mut keep = false;
    for line in old.split_inclusive('\n') {
        if let Some(alias) = line.strip_prefix("Host ") {
            keep = !alias.trim().eq_ignore_ascii_case(&server.alias);
        }
        if keep {
            blocks.push_str(line);
        }
    }
    blocks.push_str(&block);
    crate::profiles::atomic_write(path, blocks.as_bytes())
}
#[tauri::command]
pub fn ssh_config_save(app: tauri::AppHandle, server: ManagedServer) -> Result<Target, AppError> {
    let path = crate::profiles::config_dir(&app)?.join("ssh_config");
    write_managed(&path, &server)?;
    Ok(Target {
        host: server.alias,
        config: Some(path.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod managed_tests {
    use super::*;
    fn server(path: String) -> ManagedServer {
        ManagedServer {
            alias: "lab".into(),
            hostname: "box.example".into(),
            user: "operator".into(),
            port: 22,
            identity_file: Some(path),
            auth: Auth::Key,
            jump: None,
        }
    }
    #[test]
    fn password_servers_need_no_key_and_never_write_a_secret() {
        let mut s = server(String::new());
        assert!(
            render_block(&s).is_err(),
            "key auth still needs an identity file"
        );
        s.auth = Auth::Password;
        s.identity_file = None;
        let block = render_block(&s).unwrap();
        assert!(block.contains("PreferredAuthentications password,keyboard-interactive\n"));
        assert!(block.contains("PubkeyAuthentication no\n"));
        assert!(!block.contains("IdentityFile"));
    }
    #[test]
    fn jump_hosts_are_one_validated_hop() {
        let mut s = server(String::new());
        s.auth = Auth::Password;
        s.jump = Some("admin@bastion.example:2222".into());
        assert!(render_block(&s)
            .unwrap()
            .contains("  ProxyJump admin@bastion.example:2222\n"));
        for bad in [
            "a,b",
            "-oProxyCommand=x",
            "bastion;id",
            "bastion\nHost evil",
            "bas tion",
        ] {
            s.jump = Some(bad.into());
            assert!(render_block(&s).is_err(), "{bad}");
        }
        s.jump = Some("  ".into());
        assert!(!render_block(&s).unwrap().contains("ProxyJump"));
    }
    #[test]
    fn validates_every_field_and_quotes_identity_paths() {
        let dir = tempfile::Builder::new()
            .prefix("identity spaces ")
            .tempdir()
            .unwrap();
        let key = dir.path().join("my key");
        std::fs::write(&key, "synthetic").unwrap();
        let mut s = server(key.to_string_lossy().into());
        let block = render_block(&s).unwrap();
        assert!(block.contains("Host lab\n  HostName box.example\n  User operator\n  Port 22\n"));
        assert!(block.contains("IdentityFile \""));
        assert!(block.contains("my key\"\n  IdentitiesOnly yes\n"));
        for alias in ["-x", "a b", "a*", "a;id", "a\nHost evil"] {
            s.alias = alias.into();
            assert!(render_block(&s).is_err());
        }
        s.alias = "lab".into();
        s.port = 0;
        assert!(render_block(&s).is_err());
        s.port = 65536;
        assert!(render_block(&s).is_err());
        s.port = 65535;
        assert!(render_block(&s).is_ok());
        s.user = "a;id".into();
        assert!(render_block(&s).is_err());
        s.user = "operator".into();
        s.hostname = "box\nProxyCommand evil".into();
        assert!(render_block(&s).is_err());
    }
    #[test]
    fn owned_config_upserts_without_touching_user_config() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("Host key");
        std::fs::write(&key, "synthetic").unwrap();
        let own = dir.path().join("ssh_config");
        let user = dir.path().join("user_config");
        std::fs::write(&user, "untouched").unwrap();
        let mut s = server(key.to_string_lossy().into());
        write_managed(&own, &s).unwrap();
        s.port = 2222;
        write_managed(&own, &s).unwrap();
        s.alias = "second".into();
        write_managed(&own, &s).unwrap();
        let text = std::fs::read_to_string(own).unwrap();
        assert_eq!(text.matches("Host lab\n").count(), 1);
        assert!(text.contains("Port 2222"));
        assert!(text.contains("Host second\n"));
        assert_eq!(std::fs::read_to_string(user).unwrap(), "untouched");
    }
}
