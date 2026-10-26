use crate::contracts::{valid_remote_path, AppError, ErrorKind, Target};
use crate::transport::{self, RunOpts, Subsystem};
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::Serialize;
use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::time::{timeout_at, Instant};

pub const TEXT_LIMIT: usize = 1024 * 1024;
pub const CHUNK: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub mtime: Option<u32>,
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TextFile {
    pub text: String,
    pub mtime: u32,
    pub size: u64,
}

pub fn checked_path(path: &str, mutation: bool) -> Result<String, AppError> {
    if !valid_remote_path(path)
        || path.contains('\r')
        || path.split('/').any(|part| part == "." || part == "..")
    {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Use an absolute remote path without dot segments or control characters",
        ));
    }
    let path = path.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    if mutation && path == "/" {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "The root directory cannot be changed",
        ));
    }
    Ok(path.to_owned())
}

pub fn child_path(parent: &str, name: &str) -> Result<String, AppError> {
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid directory entry name",
        ));
    }
    checked_path(&format!("{}/{name}", parent.trim_end_matches('/')), false)
}

pub fn staging_name() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let random = RandomState::new().hash_one(NEXT.fetch_add(1, Ordering::Relaxed));
    format!(".nodescape-{:x}-{random:016x}.part", std::process::id())
}

pub fn staging_path(path: &str) -> Result<String, AppError> {
    let path = checked_path(path, true)?;
    let parent = path.rsplit_once('/').expect("absolute path").0;
    child_path(parent, &staging_name())
}

fn entry_kind(attrs: &FileAttributes) -> EntryKind {
    match attrs.permissions.map(|m| m & 0o170000) {
        Some(0o100000) => EntryKind::File,
        Some(0o040000) => EntryKind::Dir,
        Some(0o120000) => EntryKind::Symlink,
        _ => EntryKind::Other,
    }
}

fn map_entry(name: String, attrs: &FileAttributes, link_target: Option<String>) -> Entry {
    Entry {
        name,
        kind: entry_kind(attrs),
        size: attrs.size,
        mtime: attrs.mtime,
        mode: attrs.permissions,
        link_target,
    }
}

pub fn check_mtime(actual: Option<u32>, expected: u32) -> Result<(), AppError> {
    if actual != Some(expected) {
        return Err(AppError::new(
            ErrorKind::Conflict,
            "File changed on the server. Reload it before saving; your edits have been kept.",
        ));
    }
    Ok(())
}

fn decode_text(bytes: Vec<u8>) -> Result<String, AppError> {
    if bytes.len() > TEXT_LIMIT {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Text editor supports files up to 1 MiB. Download this file instead.",
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorKind::InvalidInput,
            "File is not UTF-8 text. Download it instead.",
        )
    })
}

pub fn sftp_error(error: SftpError) -> AppError {
    let kind = match &error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::PermissionDenied => ErrorKind::PermissionDenied,
            StatusCode::NoSuchFile => ErrorKind::NotFound,
            StatusCode::ConnectionLost | StatusCode::NoConnection => ErrorKind::Unreachable,
            _ => ErrorKind::Remote,
        },
        SftpError::Timeout => ErrorKind::Timeout,
        _ => ErrorKind::Remote,
    };
    AppError::new(kind, error.to_string())
}

pub fn is_status(error: &SftpError, code: StatusCode) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == code)
}

pub struct Session {
    pub raw: RawSftpSession,
    pub process: Subsystem,
    posix_rename: bool,
}

impl Session {
    pub async fn open(target: &Target, operation_id: Option<String>) -> Result<Self, AppError> {
        let opts = RunOpts {
            operation_id,
            ..Default::default()
        };
        let deadline = Instant::now() + opts.timeout;
        let mut process = transport::spawn_subsystem(target, "sftp", opts).await?;
        let raw = RawSftpSession::new_with_config(
            tokio::io::join(
                process.stdout.take().expect("stdout"),
                process.stdin.take().expect("stdin"),
            ),
            russh_sftp::client::Config {
                max_packet_len: 128 * 1024,
                request_timeout_secs: 15,
                max_concurrent_writes: 1,
            },
        );
        let result = tokio::select! {
            biased;
            _ = process.cancelled.changed() => Err(AppError::new(ErrorKind::Cancelled, "Operation cancelled")),
            version = timeout_at(deadline, raw.init()) => match version {
                Ok(result) => result.map_err(sftp_error),
                Err(_) => Err(AppError::new(ErrorKind::Timeout, "SFTP connection timed out")),
            }
        };
        match result {
            Ok(version) => Ok(Self {
                raw,
                process,
                posix_rename: version
                    .extensions
                    .get("posix-rename@openssh.com")
                    .is_some_and(|v| v == "1"),
            }),
            Err(error) => {
                let error = process.failure(error).await;
                process.stop().await;
                Err(error)
            }
        }
    }

    pub async fn finish<T>(&mut self, result: Result<T, AppError>) -> Result<T, AppError> {
        let result = match result {
            Err(error)
                if matches!(
                    error.kind,
                    ErrorKind::Remote | ErrorKind::Timeout | ErrorKind::Unreachable
                ) =>
            {
                Err(self.process.failure(error).await)
            }
            other => other,
        };
        let _ = self.raw.close_session();
        self.process.stop().await;
        result
    }

    pub fn require_atomic_rename(&self) -> Result<(), AppError> {
        if !self.posix_rename {
            return Err(AppError::new(ErrorKind::Remote, "Server does not support posix-rename@openssh.com; atomic replacement is unavailable"));
        }
        Ok(())
    }

    pub async fn atomic_rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        self.require_atomic_rename()?;
        let mut data = Vec::with_capacity(from.len() + to.len() + 8);
        for path in [from, to] {
            data.extend_from_slice(&(path.len() as u32).to_be_bytes());
            data.extend_from_slice(path.as_bytes());
        }
        match self
            .raw
            .extended("posix-rename@openssh.com", data)
            .await
            .map_err(sftp_error)?
        {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(status) => Err(sftp_error(SftpError::Status(status))),
            _ => Err(AppError::new(
                ErrorKind::Remote,
                "Unexpected atomic rename response",
            )),
        }
    }

    pub async fn absent(&self, path: &str) -> Result<(), AppError> {
        match self.raw.lstat(path).await {
            Ok(_) => Err(AppError::new(
                ErrorKind::Conflict,
                "Destination already exists",
            )),
            Err(error) if is_status(&error, StatusCode::NoSuchFile) => Ok(()),
            Err(error) => Err(sftp_error(error)),
        }
    }

    pub async fn regular(&self, path: &str) -> Result<FileAttributes, AppError> {
        let attrs = self.raw.lstat(path).await.map_err(sftp_error)?.attrs;
        if entry_kind(&attrs) != EntryKind::File {
            return Err(AppError::new(
                ErrorKind::InvalidInput,
                "Choose a regular file; symlinks and special files cannot be edited or transferred",
            ));
        }
        Ok(attrs)
    }

    pub async fn create_exclusive(&self, path: &str) -> Result<String, AppError> {
        Ok(self
            .raw
            .open(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await
            .map_err(sftp_error)?
            .handle)
    }

    pub async fn names(&self, path: &str) -> Result<Vec<russh_sftp::protocol::File>, AppError> {
        let handle = self.raw.opendir(path).await.map_err(sftp_error)?.handle;
        let result = async {
            let mut entries = Vec::new();
            loop {
                match self.raw.readdir(handle.as_str()).await {
                    Ok(batch) => {
                        for entry in batch.files {
                            if entry.filename == "." || entry.filename == ".." {
                                continue;
                            }
                            child_path(path, &entry.filename)?;
                            entries.push(entry);
                        }
                        if entries.len() > 100_000 {
                            return Err(AppError::new(
                                ErrorKind::Remote,
                                "Directory has more than 100,000 entries",
                            ));
                        }
                    }
                    Err(error) if is_status(&error, StatusCode::Eof) => return Ok(entries),
                    Err(error) => return Err(sftp_error(error)),
                }
            }
        }
        .await;
        let closed = self.raw.close(handle).await.map_err(sftp_error);
        result.and_then(|entries| closed.map(|_| entries))
    }

    pub async fn remove_partial(&self, target: &Target, path: &str) -> Result<(), AppError> {
        match self.raw.remove(path).await {
            Ok(_) => Ok(()),
            Err(error) if is_status(&error, StatusCode::NoSuchFile) => Ok(()),
            Err(_) => {
                let mut cleanup = Self::open(target, None).await?;
                let result = match cleanup.raw.remove(path).await {
                    Ok(_) => Ok(()),
                    Err(error) if is_status(&error, StatusCode::NoSuchFile) => Ok(()),
                    Err(error) => Err(sftp_error(error)),
                };
                cleanup.finish(result).await
            }
        }
    }
}

#[tauri::command]
pub async fn files_list(target: Target, path: String) -> Result<Vec<Entry>, AppError> {
    let path = checked_path(&path, false)?;
    let mut session = Session::open(&target, None).await?;
    let result = async {
        let mut entries = Vec::new();
        for file in session.names(&path).await? {
            let link = if entry_kind(&file.attrs) == EntryKind::Symlink {
                session
                    .raw
                    .readlink(child_path(&path, &file.filename)?)
                    .await
                    .ok()
                    .and_then(|name| name.files.first().map(|f| f.filename.clone()))
            } else {
                None
            };
            entries.push(map_entry(file.filename, &file.attrs, link));
        }
        entries.sort_by(|a, b| {
            (a.kind != EntryKind::Dir)
                .cmp(&(b.kind != EntryKind::Dir))
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(entries)
    }
    .await;
    session.finish(result).await
}

#[tauri::command]
pub async fn file_mkdir(target: Target, path: String) -> Result<(), AppError> {
    let path = checked_path(&path, true)?;
    let mut session = Session::open(&target, None).await?;
    let result = session
        .raw
        .mkdir(path, FileAttributes::default())
        .await
        .map(|_| ())
        .map_err(sftp_error);
    session.finish(result).await
}

#[tauri::command]
pub async fn file_create(target: Target, path: String) -> Result<(), AppError> {
    let path = checked_path(&path, true)?;
    let mut session = Session::open(&target, None).await?;
    let result = async {
        session.absent(&path).await?;
        let handle = session.create_exclusive(&path).await?;
        session
            .raw
            .close(handle)
            .await
            .map(|_| ())
            .map_err(sftp_error)
    }
    .await;
    session.finish(result).await
}

#[tauri::command]
pub async fn file_rename(target: Target, from: String, to: String) -> Result<(), AppError> {
    let from = checked_path(&from, true)?;
    let to = checked_path(&to, true)?;
    let mut session = Session::open(&target, None).await?;
    let result = async {
        session.absent(&to).await?;
        // SFTP v3 rename refuses an existing destination, including dangling links.
        session
            .raw
            .rename(from, to)
            .await
            .map(|_| ())
            .map_err(sftp_error)
    }
    .await;
    session.finish(result).await
}

async fn no_symlink_ancestors(session: &Session, path: &str) -> Result<(), AppError> {
    let mut parent = String::new();
    let components: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        parent.push('/');
        parent.push_str(component);
        let attrs = session
            .raw
            .lstat(parent.as_str())
            .await
            .map_err(sftp_error)?
            .attrs;
        if entry_kind(&attrs) != EntryKind::Dir {
            return Err(AppError::new(
                ErrorKind::InvalidInput,
                "Deletion cannot traverse a symlink or special file",
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn file_delete(target: Target, path: String, recursive: bool) -> Result<(), AppError> {
    let path = checked_path(&path, true)?;
    let mut session = Session::open(&target, None).await?;
    let result = async {
        let mut pending = vec![(path, false)];
        while let Some((path, visited)) = pending.pop() {
            no_symlink_ancestors(&session, &path).await?;
            let attrs = session
                .raw
                .lstat(path.as_str())
                .await
                .map_err(sftp_error)?
                .attrs;
            match entry_kind(&attrs) {
                EntryKind::Dir if recursive && !visited => {
                    let children = session.names(&path).await?;
                    pending.push((path.clone(), true));
                    for child in children {
                        pending.push((child_path(&path, &child.filename)?, false));
                    }
                }
                EntryKind::Dir => {
                    session.raw.rmdir(path).await.map_err(sftp_error)?;
                }
                _ => {
                    session.raw.remove(path).await.map_err(sftp_error)?;
                }
            }
        }
        Ok(())
    }
    .await;
    session.finish(result).await
}

#[tauri::command]
pub async fn file_read_text(target: Target, path: String) -> Result<TextFile, AppError> {
    let path = checked_path(&path, false)?;
    let mut session = Session::open(&target, None).await?;
    let result = async {
        session.regular(&path).await?;
        let handle = session
            .raw
            .open(path.as_str(), OpenFlags::READ, FileAttributes::default())
            .await
            .map_err(sftp_error)?
            .handle;
        let read = async {
            let attrs = session
                .raw
                .fstat(handle.as_str())
                .await
                .map_err(sftp_error)?
                .attrs;
            let mtime = attrs.mtime.ok_or_else(|| {
                AppError::new(
                    ErrorKind::Remote,
                    "Server did not provide a modification time",
                )
            })?;
            if attrs.size.is_some_and(|size| size > TEXT_LIMIT as u64) {
                return Err(AppError::new(
                    ErrorKind::InvalidInput,
                    "Text editor supports files up to 1 MiB. Download this file instead.",
                ));
            }
            let mut bytes = Vec::new();
            loop {
                match session
                    .raw
                    .read(handle.as_str(), bytes.len() as u64, CHUNK as u32)
                    .await
                {
                    Ok(data) => {
                        if data.data.is_empty() {
                            break;
                        }
                        bytes.extend_from_slice(&data.data);
                        if bytes.len() > TEXT_LIMIT {
                            return decode_text(bytes).map(|_| unreachable!());
                        }
                    }
                    Err(error) if is_status(&error, StatusCode::Eof) => break,
                    Err(error) => return Err(sftp_error(error)),
                }
            }
            let after = session
                .raw
                .fstat(handle.as_str())
                .await
                .map_err(sftp_error)?
                .attrs;
            check_mtime(after.mtime, mtime)?;
            if attrs.size != after.size {
                return Err(AppError::new(
                    ErrorKind::Conflict,
                    "File changed while reading. Reload it.",
                ));
            }
            let size = bytes.len() as u64;
            Ok(TextFile {
                text: decode_text(bytes)?,
                mtime,
                size,
            })
        }
        .await;
        let closed = session.raw.close(handle).await.map_err(sftp_error);
        read.and_then(|text| closed.map(|_| text))
    }
    .await;
    session.finish(result).await
}

#[tauri::command]
pub async fn file_write_text(
    target: Target,
    path: String,
    text: String,
    expected_mtime: u32,
) -> Result<(), AppError> {
    let path = checked_path(&path, true)?;
    if text.len() > TEXT_LIMIT {
        return Err(AppError::new(ErrorKind::InvalidInput, "Text exceeds 1 MiB"));
    }
    let stage = staging_path(&path)?;
    let mut session = Session::open(&target, None).await?;
    let mut created = false;
    let result = async {
        session.require_atomic_rename()?;
        let original = session.regular(&path).await?;
        check_mtime(original.mtime, expected_mtime)?;
        let handle = session.create_exclusive(&stage).await?;
        created = true;
        let written = async {
            for (index, chunk) in text.as_bytes().chunks(CHUNK).enumerate() {
                session
                    .raw
                    .write(handle.as_str(), (index * CHUNK) as u64, chunk.to_vec())
                    .await
                    .map_err(sftp_error)?;
            }
            if let Some(mode) = original.permissions {
                session
                    .raw
                    .fsetstat(
                        handle.as_str(),
                        FileAttributes {
                            permissions: Some(mode & 0o777),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(sftp_error)?;
            }
            Ok(())
        }
        .await;
        let closed = session.raw.close(handle).await.map_err(sftp_error);
        written?;
        closed?;
        let current = session.regular(&path).await?;
        check_mtime(current.mtime, expected_mtime)?;
        if current.size != original.size {
            return Err(AppError::new(
                ErrorKind::Conflict,
                "File changed on the server. Your edits have been kept.",
            ));
        }
        session.atomic_rename(&stage, &path).await
    }
    .await;
    let result = if result.is_err() && created {
        match session.remove_partial(&target, &stage).await {
            Ok(()) => result,
            Err(_) => result.map_err(|error| {
                AppError::new(
                    error.kind,
                    format!(
                        "{} Partial file cleanup failed; refresh the directory before retrying.",
                        error.message
                    ),
                )
            }),
        }
    } else {
        result
    };
    session.finish(result).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_are_absolute_and_safe_to_address() {
        for path in ["/", "/srv/ü ñ 文件 test.txt", "/srv/quote'$.txt"] {
            assert!(checked_path(path, false).is_ok());
        }
        for path in ["", "relative", "/a\0b", "/a\nb", "/a/../b", "/a/./b"] {
            assert!(checked_path(path, false).is_err());
        }
        assert!(checked_path("/", true).is_err());
        assert!(checked_path("////", true).is_err());
        assert_eq!(checked_path("/srv/a///", true).unwrap(), "/srv/a");
    }
    #[test]
    fn staging_names_are_random_siblings() {
        let a = staging_path("/srv/ü ñ 文件 test.txt").unwrap();
        let b = staging_path("/srv/ü ñ 文件 test.txt").unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with("/srv/.nodescape-") && a.ends_with(".part"));
        assert!(crate::contracts::valid_remote_path(&a));
        assert!(staging_path("/").is_err());
    }
    #[test]
    fn entries_map_exact_type_bits_and_keep_missing_attributes() {
        for (mode, kind) in [
            (0o100644, EntryKind::File),
            (0o40755, EntryKind::Dir),
            (0o120777, EntryKind::Symlink),
            (0o20600, EntryKind::Other),
        ] {
            let attrs = FileAttributes {
                permissions: Some(mode),
                size: Some(23),
                mtime: Some(42),
                ..Default::default()
            };
            let entry = map_entry("ü ñ 文件 test.txt".into(), &attrs, Some("/missing".into()));
            assert_eq!(entry.kind, kind);
            assert_eq!(entry.size, Some(23));
            assert_eq!(entry.mtime, Some(42));
        }
        let entry = map_entry("missing".into(), &FileAttributes::default(), None);
        assert_eq!(entry.size, None);
        assert_eq!(entry.mtime, None);
        assert_eq!(entry.kind, EntryKind::Other);
    }
    #[test]
    fn conflict_detection_requires_known_equal_mtimes() {
        assert!(check_mtime(Some(10), 10).is_ok());
        assert_eq!(
            check_mtime(Some(11), 10).unwrap_err().kind,
            ErrorKind::Conflict
        );
        assert_eq!(check_mtime(None, 10).unwrap_err().kind, ErrorKind::Conflict);
    }
    #[test]
    fn text_limits_are_bytes_and_utf8_is_required() {
        assert!(decode_text(vec![b'a'; TEXT_LIMIT]).is_ok());
        assert!(decode_text(vec![b'a'; TEXT_LIMIT + 1]).is_err());
        assert!(decode_text(vec![0xff]).is_err());
        assert_eq!(
            decode_text("ü ñ 文件".as_bytes().to_vec()).unwrap(),
            "ü ñ 文件"
        );
    }
    #[test]
    fn server_names_cannot_escape_the_listed_directory() {
        for name in ["..", ".", "x/y", "", "bad\nname"] {
            assert!(child_path("/srv", name).is_err());
        }
        assert_eq!(
            child_path("/srv", "ü ñ 文件 test.txt").unwrap(),
            "/srv/ü ñ 文件 test.txt"
        );
    }
}
