use crate::{
    contracts::{valid_local_path, valid_public_key, AppError, ErrorKind, Target},
    transport,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;
#[derive(Serialize)]
pub struct Program {
    path: String,
    version: Option<String>,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    ssh: Program,
    ssh_keygen: Program,
    ssh_dir_exists: bool,
    public_keys: Vec<String>,
}
fn resolved(program: PathBuf) -> PathBuf {
    if program.is_absolute() {
        return program;
    }
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .flat_map(|p| {
                    let path = p.join(&program);
                    if cfg!(windows) {
                        vec![path.clone(), path.with_extension("exe")]
                    } else {
                        vec![path]
                    }
                })
                .find(|p| p.is_file())
        })
        .unwrap_or(program)
}
pub(crate) fn keygen_program() -> PathBuf {
    let ssh = resolved(transport::ssh_program());
    ssh.with_file_name(if cfg!(windows) {
        "ssh-keygen.exe"
    } else {
        "ssh-keygen"
    })
}
#[tauri::command]
pub async fn environment_check() -> Result<Environment, AppError> {
    let ssh = resolved(transport::ssh_program());
    let keygen = keygen_program();
    let mut command = Command::new(&ssh);
    command.arg("-V").kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let (version, error) =
        match tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await {
            Ok(Ok(output)) if output.status.success() => {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stderr),
                    String::from_utf8_lossy(&output.stdout)
                );
                (
                    Some(text.trim().chars().take(500).collect::<String>()),
                    None,
                )
            }
            Ok(Err(e)) => (None, Some(format!("System SSH is unavailable: {e}"))),
            _ => (
                None,
                Some("System SSH version check failed or timed out".into()),
            ),
        };
    let exists = keygen.is_file();
    // ssh-keygen has no version flag; label the sibling OpenSSH suite version explicitly.
    let keygen_version = exists
        .then(|| {
            version
                .as_ref()
                .map(|v| format!("{v} (OpenSSH suite; ssh-keygen has no version flag)"))
        })
        .flatten();
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME")
    };
    let ssh_dir = home.map(|p| PathBuf::from(p).join(".ssh"));
    let mut public_keys = Vec::new();
    if let Some(dir) = ssh_dir.as_ref().and_then(|p| std::fs::read_dir(p).ok()) {
        for entry in dir.flatten() {
            if entry.path().extension().is_some_and(|e| e == "pub")
                && entry.file_type().is_ok_and(|t| t.is_file())
            {
                public_keys.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    public_keys.sort();
    Ok(Environment {
        ssh: Program {
            path: ssh.to_string_lossy().into_owned(),
            version,
            error,
        },
        ssh_keygen: Program {
            path: keygen.to_string_lossy().into_owned(),
            version: keygen_version,
            error: (!exists).then(|| "The sibling ssh-keygen executable was not found".into()),
        },
        ssh_dir_exists: ssh_dir.is_some_and(|p| p.is_dir()),
        public_keys,
    })
}
fn read_public_key(path: &Path) -> Result<String, AppError> {
    if path.extension().is_none_or(|e| e != "pub") || !valid_local_path(&path.to_string_lossy()) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Choose a public key file ending in .pub",
        ));
    }
    let file = std::fs::File::open(path)
        .map_err(|_| AppError::new(ErrorKind::NotFound, "Public key file could not be opened"))?;
    use std::io::Read;
    let mut key = String::new();
    file.take(16385)
        .read_to_string(&mut key)
        .map_err(|_| AppError::new(ErrorKind::InvalidInput, "Invalid public key file"))?;
    let key = key.trim_end_matches(['\r', '\n']);
    if !valid_public_key(key) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Expected one OpenSSH public key (ed25519, RSA or ECDSA)",
        ));
    }
    Ok(key.to_owned())
}
#[tauri::command]
pub fn public_key_read(path: String) -> Result<String, AppError> {
    read_public_key(Path::new(&path))
}
#[tauri::command]
pub async fn connection_test(target: Target, operation_id: Option<String>) -> Result<(), AppError> {
    transport::run(
        &target,
        "true\n",
        transport::RunOpts {
            operation_id,
            ..Default::default()
        },
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_keys_reject_shell_text_and_private_material() {
        for key in [
            "ssh-ed25519 AAAA nodescape",
            "ssh-rsa YWJjZA==",
            "ecdsa-sha2-nistp256 AAAA comment",
        ] {
            assert!(crate::contracts::valid_public_key(key));
        }
        for key in [
            "ssh-ed25519 AAAA\n",
            "ssh-ed25519 AAAA;id",
            "ssh-ed25519 AAAA $(id)",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "ssh-ed25519 invalid!",
            "ssh-dss AAAA",
        ] {
            assert!(!crate::contracts::valid_public_key(key));
        }
    }
    #[test]
    fn public_key_reader_only_reads_pub_files() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("id.pub");
        std::fs::write(&key, "ssh-ed25519 AAAA nodescape\n").unwrap();
        assert_eq!(read_public_key(&key).unwrap(), "ssh-ed25519 AAAA nodescape");
        let private = dir.path().join("id");
        std::fs::write(&private, "private").unwrap();
        assert!(read_public_key(&private).is_err());
    }
}
