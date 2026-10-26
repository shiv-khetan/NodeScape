use crate::{
    contracts::{AppError, ErrorKind, Target},
    files::{checked_path, is_status, sftp_error, staging_name, staging_path, Session, CHUNK},
};
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub bytes: u64,
    pub total: u64,
}

fn local_error(error: std::io::Error) -> AppError {
    let kind = match error.kind() {
        std::io::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
        std::io::ErrorKind::NotFound => ErrorKind::NotFound,
        std::io::ErrorKind::AlreadyExists => ErrorKind::Conflict,
        _ => ErrorKind::Internal,
    };
    AppError::new(kind, error.to_string())
}

fn local_path(path: &str) -> Result<PathBuf, AppError> {
    if path.contains('\0') || !Path::new(path).is_absolute() {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Choose an absolute local file path",
        ));
    }
    Ok(PathBuf::from(path))
}

fn cancelled() -> AppError {
    AppError::new(ErrorKind::Cancelled, "Transfer cancelled")
}

async fn upload(
    target: &Target,
    session: &mut Session,
    local: &Path,
    remote: &str,
    overwrite: bool,
    progress: &mut impl FnMut(Progress) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(local).await.map_err(local_error)?;
    if !metadata.is_file() {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Choose a regular local file",
        ));
    }
    let mut file = fs::File::open(local).await.map_err(local_error)?;
    let total = file.metadata().await.map_err(local_error)?.len();
    if overwrite {
        session.require_atomic_rename()?;
    } else {
        session.absent(remote).await?;
    }
    if *session.process.cancelled.borrow() {
        return Err(cancelled());
    }
    let stage = staging_path(remote)?;
    let handle = session.create_exclusive(&stage).await?;
    let mut bytes = 0u64;
    let raw = &session.raw;
    let receiver = &mut session.process.cancelled;
    let result = if *receiver.borrow() {
        Err(cancelled())
    } else {
        tokio::select! {
            biased;
            _ = receiver.changed() => Err(cancelled()),
            result = async {
                progress(Progress { bytes: 0, total })?;
                let mut buffer = vec![0; CHUNK];
                let mut last = Instant::now();
                loop {
                    let count = file.read(&mut buffer).await.map_err(local_error)?;
                    if count == 0 { break; }
                    raw.write(handle.as_str(), bytes, buffer[..count].to_vec()).await.map_err(sftp_error)?;
                    bytes += count as u64;
                    if last.elapsed() >= Duration::from_millis(100) || bytes == total {
                        progress(Progress { bytes, total })?;
                        last = Instant::now();
                    }
                }
                if bytes != total { return Err(AppError::new(ErrorKind::Conflict, "Local file changed during upload")); }
                Ok(())
            } => result,
        }
    };
    let closed = session.raw.close(handle).await.map_err(sftp_error);
    let result = async {
        result?;
        closed?;
        if *session.process.cancelled.borrow() {
            return Err(cancelled());
        }
        if overwrite {
            session.atomic_rename(&stage, remote).await?;
        } else {
            session
                .raw
                .rename(stage.as_str(), remote)
                .await
                .map_err(sftp_error)?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        if session.remove_partial(target, &stage).await.is_err() {
            return Err(AppError::new(
                error.kind,
                format!(
                    "{} Partial file cleanup failed; refresh the remote directory before retrying.",
                    error.message
                ),
            ));
        }
        return Err(error);
    }
    let _ = progress(Progress { bytes, total });
    Ok(())
}

async fn download(
    session: &mut Session,
    local: &Path,
    remote: &str,
    overwrite: bool,
    progress: &mut impl FnMut(Progress) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let attrs = session.regular(remote).await?;
    if !overwrite {
        match fs::symlink_metadata(local).await {
            Ok(_) => {
                return Err(AppError::new(
                    ErrorKind::Conflict,
                    "Destination already exists",
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(local_error(e)),
        }
    }
    if *session.process.cancelled.borrow() {
        return Err(cancelled());
    }
    let handle = session
        .raw
        .open(remote, OpenFlags::READ, FileAttributes::default())
        .await
        .map_err(sftp_error)?
        .handle;
    let stage = local.with_file_name(staging_name());
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stage)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            let _ = session.raw.close(handle).await;
            return Err(local_error(error));
        }
    };
    let raw = &session.raw;
    let receiver = &mut session.process.cancelled;
    let mut bytes = 0u64;
    let mut total = attrs.size.unwrap_or(0);
    let result = if *receiver.borrow() {
        Err(cancelled())
    } else {
        tokio::select! {
            biased;
            _ = receiver.changed() => Err(cancelled()),
            result = async {
                let before = raw.fstat(handle.as_str()).await.map_err(sftp_error)?.attrs;
                total = before.size.ok_or_else(|| AppError::new(ErrorKind::Remote, "Server did not provide a file size"))?;
                progress(Progress { bytes: 0, total })?;
                let mut last = Instant::now();
                loop {
                    match raw.read(handle.as_str(), bytes, CHUNK as u32).await {
                        Ok(data) => {
                            if data.data.is_empty() { break; }
                            file.write_all(&data.data).await.map_err(local_error)?;
                            bytes += data.data.len() as u64;
                            if last.elapsed() >= Duration::from_millis(100) || bytes == total {
                                progress(Progress { bytes, total })?;
                                last = Instant::now();
                            }
                        }
                        Err(error) if is_status(&error, StatusCode::Eof) => break,
                        Err(error) => return Err(sftp_error(error)),
                    }
                }
                let after = raw.fstat(handle.as_str()).await.map_err(sftp_error)?.attrs;
                if bytes != total || before.size != after.size || before.mtime != after.mtime {
                    return Err(AppError::new(ErrorKind::Conflict, "Remote file changed during download"));
                }
                file.flush().await.map_err(local_error)?;
                file.sync_all().await.map_err(local_error)?;
                Ok(())
            } => result,
        }
    };
    drop(file);
    let closed = session.raw.close(handle).await.map_err(sftp_error);
    let result = async {
        result?;
        closed?;
        if *session.process.cancelled.borrow() {
            return Err(cancelled());
        }
        if overwrite {
            fs::rename(&stage, local).await.map_err(local_error)?;
        } else {
            // A sibling hard link publishes without replacing a destination created concurrently.
            fs::hard_link(&stage, local).await.map_err(local_error)?;
            fs::remove_file(&stage).await.map_err(local_error)?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        if let Err(error) = fs::remove_file(&stage).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(AppError::new(
                    ErrorKind::Internal,
                    "Transfer failed and local partial file could not be removed",
                ));
            }
        }
    } else {
        let _ = progress(Progress { bytes, total });
    }
    result
}

pub async fn transfer(
    target: Target,
    direction: String,
    local_path_text: String,
    remote_path: String,
    operation_id: String,
    overwrite: bool,
    mut progress: impl FnMut(Progress) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if !["up", "down"].contains(&direction.as_str())
        || operation_id.is_empty()
        || operation_id.len() > 200
    {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid transfer direction or operation id",
        ));
    }
    let local = local_path(&local_path_text)?;
    let remote = checked_path(&remote_path, true)?;
    let mut session = Session::open(&target, Some(operation_id)).await?;
    let result = if direction == "up" {
        upload(
            &target,
            &mut session,
            &local,
            &remote,
            overwrite,
            &mut progress,
        )
        .await
    } else {
        download(&mut session, &local, &remote, overwrite, &mut progress).await
    };
    session.finish(result).await
}

#[tauri::command]
pub async fn transfer_start(
    target: Target,
    direction: String,
    local_path: String,
    remote_path: String,
    operation_id: String,
    overwrite: bool,
    channel: tauri::ipc::Channel<Progress>,
) -> Result<(), AppError> {
    transfer(
        target,
        direction,
        local_path,
        remote_path,
        operation_id,
        overwrite,
        |event| {
            channel
                .send(event)
                .map_err(|_| AppError::new(ErrorKind::Cancelled, "Transfer view closed"))
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_paths_and_local_failures_are_typed() {
        assert!(local_path("relative.txt").is_err());
        assert!(local_path("bad\0path").is_err());
        assert_eq!(
            local_error(std::io::ErrorKind::PermissionDenied.into()).kind,
            ErrorKind::PermissionDenied
        );
        assert_eq!(
            local_error(std::io::ErrorKind::AlreadyExists.into()).kind,
            ErrorKind::Conflict
        );
    }
}
