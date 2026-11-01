//! Server login passwords. Kept in memory for this app session and, when the user chooses
//! "Remember", in Windows Credential Manager (encrypted for this Windows user, Local persistence so
//! it never roams). There is deliberately no command that returns a saved password to the webview.
use crate::contracts::{AppError, ErrorKind, Target};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use zeroize::Zeroizing;

/// None marks "looked in the saved store and found nothing", so key-only servers skip it next time.
type Store = Mutex<HashMap<String, Option<Zeroizing<String>>>>;

fn store() -> &'static Store {
    static STORE: OnceLock<Store> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The same alias under a different ssh config is a different server.
fn key(target: &Target) -> String {
    format!(
        "{}\0{}",
        target.host,
        target.config.as_deref().unwrap_or("").trim()
    )
}

/// Credential Manager entry name: readable host plus a short hash of the full key.
fn saved_name(target: &Target) -> String {
    let digest = Sha256::digest(key(target).as_bytes());
    let short: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("NodeScape:ssh:{}:{short}", target.host)
}

pub fn validate(password: &str) -> Result<(), AppError> {
    if password.is_empty() || password.chars().count() > 1024 {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Enter a password of 1–1024 characters",
        ));
    }
    // askpass answers with one line, so a line break would truncate the password silently.
    if password.contains(['\0', '\r', '\n']) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Passwords cannot contain line breaks",
        ));
    }
    Ok(())
}

fn session() -> std::sync::MutexGuard<'static, HashMap<String, Option<Zeroizing<String>>>> {
    store().lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
pub fn remember_for_session(target: &Target, password: String) -> Result<(), AppError> {
    let password = Zeroizing::new(password);
    validate(&password)?;
    session().insert(key(target), Some(password));
    Ok(())
}

/// Session copy first, then the saved store once; the result is cached either way.
pub fn password(target: &Target) -> Option<Zeroizing<String>> {
    let key = key(target);
    if let Some(known) = session().get(&key) {
        return known.clone();
    }
    let loaded = saved::load(&saved_name(target));
    session().insert(key, loaded.clone());
    loaded
}

/// Forget everywhere: used when the server refuses the password or the profile is removed.
pub fn forget(target: &Target) {
    session().insert(key(target), None);
    saved::delete(&saved_name(target));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPassword {
    pub target: Target,
    pub password: String,
    pub remember: bool,
}

#[tauri::command]
pub fn login_password_set(login: LoginPassword) -> Result<(), AppError> {
    let LoginPassword {
        target,
        password,
        remember,
    } = login;
    let password = Zeroizing::new(password);
    validate(&password)?;
    if remember {
        saved::save(&saved_name(&target), &password)?;
    } else {
        saved::delete(&saved_name(&target));
    }
    session().insert(key(&target), Some(password));
    Ok(())
}

#[tauri::command]
pub fn login_password_forget(target: Target) {
    forget(&target);
}

/// Whether a password is saved, never the password itself.
#[tauri::command]
pub fn login_password_saved(target: Target) -> bool {
    saved::load(&saved_name(&target)).is_some()
}

#[cfg(windows)]
mod saved {
    use crate::contracts::{AppError, ErrorKind};
    use keyring_core::{api::CredentialStoreApi, Entry};
    use std::collections::HashMap;
    use zeroize::Zeroizing;

    fn entry(name: &str) -> keyring_core::Result<Entry> {
        let modifiers = HashMap::from([("target", name), ("persistence", "Local")]);
        windows_native_keyring_store::Store::new()?.build("NodeScape", "ssh", Some(&modifiers))
    }

    pub fn save(name: &str, password: &str) -> Result<(), AppError> {
        entry(name)
            .and_then(|e| e.set_password(password))
            .map_err(|e| {
                AppError::new(
                    ErrorKind::Internal,
                    format!("Could not save the password: {e}"),
                )
            })
    }

    pub fn load(name: &str) -> Option<Zeroizing<String>> {
        entry(name)
            .and_then(|e| e.get_password())
            .ok()
            .map(Zeroizing::new)
    }

    pub fn delete(name: &str) {
        let _ = entry(name).and_then(|e| e.delete_credential());
    }
}

// ponytail: other platforms keep session memory only until a keychain store is wired in.
#[cfg(not(windows))]
mod saved {
    use crate::contracts::{AppError, ErrorKind};
    use zeroize::Zeroizing;
    pub fn save(_: &str, _: &str) -> Result<(), AppError> {
        Err(AppError::new(
            ErrorKind::Internal,
            "Saving passwords is supported on Windows only",
        ))
    }
    pub fn load(_: &str) -> Option<Zeroizing<String>> {
        None
    }
    pub fn delete(_: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str, config: Option<&str>) -> Target {
        Target {
            host: host.into(),
            config: config.map(Into::into),
        }
    }

    #[test]
    fn passwords_are_per_server_and_config() {
        let a = target("cred-a", None);
        let b = target("cred-a", Some("C:/other/config"));
        remember_for_session(&a, "one".into()).unwrap();
        assert_eq!(password(&a).as_deref().map(String::as_str), Some("one"));
        assert!(password(&b).is_none());
        assert_ne!(saved_name(&a), saved_name(&b));
        assert!(saved_name(&a).starts_with("NodeScape:ssh:cred-a:"));
        forget(&a);
        assert!(password(&a).is_none());
    }

    #[test]
    fn rejects_empty_oversized_and_multiline_passwords() {
        let t = target("cred-b", None);
        for bad in ["", "a\nb", "a\rb", "a\0b"] {
            assert_eq!(
                remember_for_session(&t, bad.into()).unwrap_err().kind,
                ErrorKind::InvalidInput
            );
        }
        assert!(remember_for_session(&t, "x".repeat(1025)).is_err());
        assert!(password(&t).is_none());
    }

    /// Touches the real Windows Credential Manager under a throwaway name, then removes it.
    #[test]
    #[ignore]
    fn saved_passwords_round_trip_through_credential_manager() {
        let t = target("nodescape-selftest.invalid", Some("C:/selftest/config"));
        login_password_set(LoginPassword {
            target: t.clone(),
            password: "s3cret test".into(),
            remember: true,
        })
        .unwrap();
        session().remove(&key(&t));
        assert!(login_password_saved(t.clone()));
        assert_eq!(
            password(&t).as_deref().map(String::as_str),
            Some("s3cret test")
        );
        forget(&t);
        assert!(!login_password_saved(t.clone()));
    }
}
