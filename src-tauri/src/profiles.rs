use crate::contracts::{valid_host, valid_local_path, AppError, ErrorKind};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::Manager;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub config: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    profiles: Vec<Profile>,
}
#[derive(Serialize)]
pub struct ProfileList {
    pub profiles: Vec<Profile>,
    pub warning: Option<String>,
}
static WRITES: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(1);
fn local(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Internal, error.to_string())
}
fn invalid(message: &str) -> AppError {
    AppError::new(ErrorKind::InvalidInput, message)
}
pub(crate) fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path().app_config_dir().map_err(local)
}
fn validate(profile: &Profile) -> Result<(), AppError> {
    if profile.name.trim().is_empty()
        || profile.name.len() > 120
        || profile.name.chars().any(char::is_control)
    {
        return Err(invalid("Use a server name of 1–120 characters"));
    }
    if !valid_host(&profile.host) {
        return Err(invalid("Invalid SSH alias or user@host"));
    }
    if !profile.id.is_empty()
        && (profile.id.len() > 100
            || !profile
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-'))
    {
        return Err(invalid("Invalid profile id"));
    }
    if let Some(path) = &profile.config {
        if !valid_local_path(path) {
            return Err(invalid("SSH config file not found or invalid path"));
        }
    }
    Ok(())
}
fn read(path: &Path) -> ProfileList {
    let loaded = fs::read_to_string(path)
        .map_err(local)
        .and_then(|text| serde_json::from_str::<File>(&text).map_err(local));
    match loaded {
        Ok(file)
            if file.version == 1
                && file
                    .profiles
                    .iter()
                    .all(|p| !p.id.is_empty() && validate(p).is_ok())
                && file.profiles.iter().enumerate().all(|(i, p)| {
                    file.profiles[..i]
                        .iter()
                        .all(|q| q.id != p.id && !q.name.eq_ignore_ascii_case(&p.name))
                }) =>
        {
            ProfileList {
                profiles: file.profiles,
                warning: None,
            }
        }
        _ => ProfileList {
            profiles: vec![],
            warning: Some(
                "Saved servers are missing or unreadable. Add a server to get connected.".into(),
            ),
        },
    }
}

// Apply permissions before renaming: an unprotected config must never become the active file.
pub(crate) fn private_file(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(local)?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let system = PathBuf::from(
            std::env::var_os("SystemRoot")
                .ok_or_else(|| local("Cannot secure SSH config: SystemRoot is missing"))?,
        )
        .join("System32");
        let owner = Command::new(system.join("whoami.exe"))
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(0x08000000)
            .output()
            .map_err(local)?;
        let output = String::from_utf8_lossy(&owner.stdout);
        let sid = output
            .trim()
            .rsplit(',')
            .next()
            .unwrap_or_default()
            .trim_matches('"');
        if !owner.status.success()
            || !sid.starts_with("S-1-")
            || !sid
                .bytes()
                .all(|c| c.is_ascii_digit() || b"S-".contains(&c))
        {
            return Err(local(
                "Cannot determine the current user's SID to secure SSH config",
            ));
        }
        let status = Command::new(system.join("icacls.exe"))
            .arg(path)
            .args(["/inheritance:r", "/grant:r", &format!("*{sid}:(F)")])
            .creation_flags(0x08000000)
            .output()
            .map_err(local)?;
        if !status.status.success() {
            return Err(AppError::new(ErrorKind::PermissionDenied, "Cannot restrict the app SSH config to your account. Check folder permissions before continuing."));
        }
    }
    Ok(())
}
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Invalid config path"))?;
    fs::create_dir_all(parent).map_err(local)?;
    let temp = parent.join(format!(
        ".nodescape-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(local)?;
    let result = (|| {
        private_file(&temp)?;
        file.write_all(bytes).map_err(local)?;
        file.sync_all().map_err(local)?;
        drop(file);
        fs::rename(&temp, path).map_err(local)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn write_profiles(path: &Path, profiles: Vec<Profile>) -> Result<(), AppError> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(&File {
            version: 1,
            profiles,
        })
        .map_err(local)?,
    )
}
fn save(path: &Path, mut profile: Profile) -> Result<Profile, AppError> {
    profile.name = profile.name.trim().to_owned();
    validate(&profile)?;
    if profile
        .config
        .as_deref()
        .is_some_and(|p| !Path::new(p).is_file())
    {
        return Err(invalid("SSH config file not found"));
    }
    let _guard = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let mut profiles = read(path).profiles;
    if profiles
        .iter()
        .any(|p| p.id != profile.id && p.name.eq_ignore_ascii_case(&profile.name))
    {
        return Err(invalid("Server names must be unique"));
    }
    if profile.id.is_empty() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(local)?
            .as_nanos();
        profile.id = format!("profile-{stamp}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        profiles.push(profile.clone());
    } else if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        return Err(AppError::new(
            ErrorKind::NotFound,
            "Server profile no longer exists",
        ));
    }
    write_profiles(path, profiles)?;
    Ok(profile)
}
fn remove(path: &Path, id: &str) -> Result<(), AppError> {
    let _guard = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let mut profiles = read(path).profiles;
    profiles.retain(|p| p.id != id);
    write_profiles(path, profiles)
}
#[tauri::command]
pub fn profiles_list(app: tauri::AppHandle) -> Result<ProfileList, AppError> {
    Ok(read(&config_dir(&app)?.join("profiles.json")))
}
#[tauri::command]
pub fn profile_save(app: tauri::AppHandle, profile: Profile) -> Result<Profile, AppError> {
    save(&config_dir(&app)?.join("profiles.json"), profile)
}
#[tauri::command]
pub fn profile_remove(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    remove(&config_dir(&app)?.join("profiles.json"), &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            id: String::new(),
            name: "Lab".into(),
            host: "testbox".into(),
            config: None,
        }
    }
    #[test]
    fn round_trip_update_remove_and_unique_names() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        assert!(read(&file).profiles.is_empty());
        assert!(read(&file).warning.is_some());
        let saved = save(&file, profile()).unwrap();
        assert!(!saved.id.is_empty());
        assert_eq!(read(&file).profiles, vec![saved.clone()]);
        let mut duplicate = profile();
        duplicate.name = "lab".into();
        assert!(save(&file, duplicate).is_err());
        let mut changed = saved.clone();
        changed.name = "Renamed".into();
        save(&file, changed).unwrap();
        remove(&file, &saved.id).unwrap();
        assert!(read(&file).profiles.is_empty());
        assert!(read(&file).warning.is_none());
    }
    #[test]
    fn missing_config_does_not_discard_saved_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        let config = dir.path().join("ssh config");
        std::fs::write(&config, "").unwrap();
        let mut p = profile();
        p.config = Some(config.to_string_lossy().into());
        let saved = save(&file, p).unwrap();
        std::fs::remove_file(config).unwrap();
        assert_eq!(read(&file).profiles, vec![saved]);
    }

    #[test]
    fn corrupt_unknown_version_and_invalid_profiles_are_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        for data in [
            "{",
            r#"{"version":99,"profiles":[]}"#,
            r#"{"version":1,"profiles":[{"id":"a","name":"x","host":"x;id","config":null}]}"#,
        ] {
            std::fs::write(&file, data).unwrap();
            let result = read(&file);
            assert!(result.profiles.is_empty());
            assert!(result.warning.is_some());
        }
    }
    #[test]
    fn atomic_replacement_leaves_only_complete_file_and_preserves_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        save(&file, profile()).unwrap();
        let before = std::fs::read(&file).unwrap();
        let mut bad = profile();
        bad.host = "-oProxyCommand=bad".into();
        assert!(save(&file, bad).is_err());
        assert_eq!(before, std::fs::read(&file).unwrap());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        atomic_write(&file, b"complete").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"complete");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn validates_profile_and_paths_with_spaces() {
        let dir = tempfile::Builder::new()
            .prefix("profile config ")
            .tempdir()
            .unwrap();
        let config = dir.path().join("ssh config");
        std::fs::write(&config, "").unwrap();
        let mut p = profile();
        p.config = Some(config.to_string_lossy().into());
        assert!(validate(&p).is_ok());
        for host in ["", "a b", "x\n", "a;id", "$(id)"] {
            p.host = host.into();
            assert!(validate(&p).is_err());
        }
    }
}
