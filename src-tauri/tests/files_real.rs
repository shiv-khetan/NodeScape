#[allow(dead_code)]
#[path = "../src/askpass.rs"]
mod askpass;
#[allow(dead_code)]
#[path = "../src/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../src/credentials.rs"]
mod credentials;
#[allow(dead_code)]
#[path = "../src/files.rs"]
mod files;
#[allow(dead_code)]
#[path = "../src/transfers.rs"]
mod transfers;
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;

use contracts::{AppError, ErrorKind, Target};
use files::{EntryKind, Session};
use russh_sftp::protocol::FileAttributes;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    hash::{BuildHasher, RandomState},
    io::{Read, Write},
    path::Path,
};
use tokio::io::AsyncReadExt;

fn environment() -> Option<(Target, String)> {
    let file = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../.env.test.local"))
        .unwrap_or_default();
    let values: HashMap<_, _> = file
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            Some((key.trim(), value.trim().trim_matches(['\'', '"'])))
        })
        .collect();
    let value = |key: &str| {
        std::env::var(key)
            .ok()
            .or_else(|| values.get(key).map(|v| v.to_string()))
            .filter(|v| !v.is_empty())
    };
    let (Some(config), Some(host), Some(dir)) = (
        value("NODESCAPE_TEST_SSH_CONFIG"),
        value("NODESCAPE_TEST_HOST"),
        value("NODESCAPE_TEST_DIR"),
    ) else {
        eprintln!("SKIP files real tests: configure the three NODESCAPE_TEST variables");
        return None;
    };
    assert!(contracts::valid_host(&host), "invalid test alias");
    assert!(
        files::checked_path(&dir, true).is_ok(),
        "invalid test directory"
    );
    let suffix = files::staging_name()
        .replace(".nodescape-", "")
        .replace(".part", "");
    Some((
        Target {
            host,
            config: Some(config),
        },
        format!("{}/files-{suffix}", dir.trim_end_matches('/')),
    ))
}

fn require(condition: bool, message: &str) -> Result<(), AppError> {
    if condition {
        Ok(())
    } else {
        Err(AppError::new(ErrorKind::Internal, message))
    }
}
fn local_error(_: std::io::Error) -> AppError {
    AppError::new(ErrorKind::Internal, "Local test file operation failed")
}
async fn cleanup(target: &Target, base: &str) -> Result<(), AppError> {
    // Restore the intentionally inaccessible directory even when a test assertion failed.
    if let Ok(mut session) = Session::open(target, None).await {
        let _ = session
            .raw
            .setstat(
                format!("{base}/denied"),
                FileAttributes {
                    permissions: Some(0o700),
                    ..Default::default()
                },
            )
            .await;
        let _: Result<(), AppError> = session.finish(Ok(())).await;
    }
    files::file_delete(target.clone(), base.into(), true).await
}

#[tokio::test]
async fn subsystem_uses_binary_pipes_config_strict_options_and_cancel_registry() {
    let dir = tempfile::Builder::new()
        .prefix("sftp config spaces ")
        .tempdir()
        .unwrap();
    let config = dir.path().join("chosen config");
    std::fs::write(&config, "").unwrap();
    let target = Target {
        host: "jump-one".into(),
        config: Some(config.to_string_lossy().into_owned()),
    };
    let options = transport::RunOpts {
        ssh_program: env!("CARGO_BIN_EXE_fake-ssh").into(),
        operation_id: Some("sftp-subsystem-args".into()),
        ..Default::default()
    };
    let mut process = transport::spawn_subsystem(&target, "sftp", options)
        .await
        .unwrap();
    // Done sending, as an SFTP client would be; fake ssh prints its argv after stdin closes.
    drop(process.stdin.take());
    let mut text = String::new();
    process
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut text)
        .await
        .unwrap();
    for option in [
        "SessionType=subsystem",
        "--",
        "jump-one",
        "sftp",
        "StrictHostKeyChecking=yes",
        "BatchMode=yes",
        "UpdateHostKeys=no",
        "ProxyCommand=",
    ] {
        assert!(text.contains(option), "missing subsystem safety option");
    }
    assert!(text.contains(config.to_str().unwrap()));
    assert!(!text.contains("sh -s"));
    assert!(transport::operation_cancel("sftp-subsystem-args")
        .await
        .unwrap());
    assert!(*process.cancelled.borrow_and_update());
    process.stop().await;
    drop(process);
    assert!(!transport::operation_cancel("sftp-subsystem-args")
        .await
        .unwrap());
}

#[tokio::test]
#[ignore = "requires unprivileged real SSH test account"]
async fn files_crud_unicode_symlinks_conflict_and_denied_directory() {
    let Some((target, base)) = environment() else {
        return;
    };
    files::file_mkdir(target.clone(), base.clone())
        .await
        .unwrap_or_else(|e| panic!("test directory setup failed: {:?}: {}", e.kind, e.message));
    let test_target = target.clone();
    let test_base = base.clone();
    let result = tokio::spawn(async move {
        let target = test_target;
        let base = test_base;
        let original = format!("{base}/empty.txt");
        let renamed = format!("{base}/ü ñ 文件 test.txt");
        files::file_create(target.clone(), original.clone()).await?;
        require(
            files::file_create(target.clone(), original.clone())
                .await
                .is_err(),
            "create replaced an existing file",
        )?;
        files::file_rename(target.clone(), original, renamed.clone()).await?;
        let mut session = Session::open(&target, None).await?;
        let setup = session
            .raw
            .setstat(
                renamed.as_str(),
                FileAttributes {
                    permissions: Some(0o755),
                    ..Default::default()
                },
            )
            .await
            .map(|_| ())
            .map_err(files::sftp_error);
        session.finish(setup).await?;
        let empty = files::file_read_text(target.clone(), renamed.clone()).await?;
        files::file_write_text(
            target.clone(),
            renamed.clone(),
            "hello ü ñ 文件\n".into(),
            empty.sha256,
        )
        .await?;
        let before = files::file_read_text(target.clone(), renamed.clone()).await?;
        files::file_write_text(
            target.clone(),
            renamed.clone(),
            "other ü ñ 文件\n".into(),
            before.sha256.clone(),
        )
        .await?;
        let mut session = Session::open(&target, None).await?;
        // Pin both versions to the same second even when SSH latency crosses a clock tick.
        let setup = session
            .raw
            .setstat(
                renamed.as_str(),
                FileAttributes {
                    atime: Some(before.mtime),
                    mtime: Some(before.mtime),
                    ..Default::default()
                },
            )
            .await
            .map(|_| ())
            .map_err(files::sftp_error);
        session.finish(setup).await?;
        let text = files::file_read_text(target.clone(), renamed.clone()).await?;
        require(
            text.mtime == before.mtime && text.size == before.size,
            "same-second test setup failed",
        )?;
        let entries = files::files_list(target.clone(), base.clone()).await?;
        require(
            entries.iter().any(|e| {
                e.name == "ü ñ 文件 test.txt" && e.mode.map(|m| m & 0o7777) == Some(0o755)
            }),
            "staged save changed executable permissions",
        )?;
        require(
            text.text == "other ü ñ 文件\n",
            "Unicode text round trip failed",
        )?;
        let conflict = files::file_write_text(
            target.clone(),
            renamed.clone(),
            "must not replace".into(),
            before.sha256,
        )
        .await;
        require(
            matches!(
                conflict,
                Err(AppError {
                    kind: ErrorKind::Conflict,
                    ..
                })
            ),
            "stale save was accepted",
        )?;
        let collision = format!("{base}/collision");
        files::file_create(target.clone(), collision.clone()).await?;
        require(
            files::file_rename(target.clone(), renamed.clone(), collision)
                .await
                .is_err(),
            "rename replaced destination",
        )?;
        let mut session = Session::open(&target, None).await?;
        let setup = async {
            // OpenSSH SFTP v3 uses target first, link name second on the wire.
            session
                .raw
                .symlink(renamed.as_str(), format!("{base}/shortcut"))
                .await
                .map_err(files::sftp_error)?;
            session
                .raw
                .symlink(format!("{base}/missing"), format!("{base}/dangling"))
                .await
                .map_err(files::sftp_error)?;
            session
                .raw
                .mkdir(
                    format!("{base}/denied"),
                    FileAttributes {
                        permissions: Some(0o700),
                        ..Default::default()
                    },
                )
                .await
                .map_err(files::sftp_error)?;
            session
                .raw
                .setstat(
                    format!("{base}/denied"),
                    FileAttributes {
                        permissions: Some(0),
                        ..Default::default()
                    },
                )
                .await
                .map_err(files::sftp_error)?;
            Ok(())
        }
        .await;
        session.finish(setup).await?;
        let entries = files::files_list(target.clone(), base.clone()).await?;
        for name in ["shortcut", "dangling"] {
            require(
                entries.iter().any(|e| {
                    e.name == name && e.kind == EntryKind::Symlink && e.link_target.is_some()
                }),
                "symlink listing failed",
            )?;
        }
        require(
            entries.iter().any(|e| e.name == "ü ñ 文件 test.txt"),
            "Unicode filename missing",
        )?;
        let denied = files::files_list(target.clone(), format!("{base}/denied")).await;
        require(
            matches!(
                denied,
                Err(AppError {
                    kind: ErrorKind::PermissionDenied,
                    ..
                })
            ),
            "unreadable directory was not permission_denied",
        )?;
        // Removing a link must leave its target intact.
        files::file_delete(target.clone(), format!("{base}/shortcut"), true).await?;
        require(
            files::file_read_text(target.clone(), renamed.clone())
                .await?
                .text
                == text.text,
            "delete followed a symlink",
        )?;
        let tree = format!("{base}/tree");
        let outside = format!("{base}/outside");
        let marker = format!("{outside}/keep.txt");
        files::file_mkdir(target.clone(), tree.clone()).await?;
        files::file_mkdir(target.clone(), outside.clone()).await?;
        files::file_create(target.clone(), marker.clone()).await?;
        let mut session = Session::open(&target, None).await?;
        let setup = session
            .raw
            .symlink(outside.as_str(), format!("{tree}/link"))
            .await
            .map(|_| ())
            .map_err(files::sftp_error);
        session.finish(setup).await?;
        files::file_delete(target.clone(), tree, true).await?;
        require(
            files::file_read_text(target.clone(), marker)
                .await?
                .text
                .is_empty(),
            "recursive delete followed directory symlink",
        )?;
        require(
            !files::files_list(target.clone(), base.clone())
                .await?
                .iter()
                .any(|e| e.name == "tree"),
            "recursive delete left tree behind",
        )?;

        let local = tempfile::tempdir().map_err(local_error)?;
        let source = local.path().join("overwrite.txt");
        std::fs::write(&source, "uploaded replacement").map_err(local_error)?;
        transfers::transfer(
            target.clone(),
            "up".into(),
            source.to_string_lossy().into_owned(),
            renamed.clone(),
            files::staging_name(),
            true,
            |_| Ok(()),
        )
        .await?;
        require(
            files::file_read_text(target.clone(), renamed).await?.text == "uploaded replacement",
            "overwrite upload failed",
        )?;
        require(
            files::files_list(target.clone(), base)
                .await?
                .iter()
                .any(|e| {
                    e.name == "ü ñ 文件 test.txt" && e.mode.map(|m| m & 0o7777) == Some(0o755)
                }),
            "overwrite upload changed executable permissions",
        )?;
        Ok::<_, AppError>(())
    })
    .await;
    let cleaned = cleanup(&target, &base).await;
    assert!(cleaned.is_ok(), "test directory cleanup failed");
    match result {
        Ok(Ok(())) => (),
        Ok(Err(e)) => panic!("files real check failed: {:?}", e.kind),
        Err(_) => panic!("files real check panicked"),
    }
}

fn random_payload(path: &Path) -> Result<[u8; 32], AppError> {
    let mut file = std::fs::File::create(path).map_err(local_error)?;
    let mut hash = Sha256::new();
    let mut state = RandomState::new().hash_one("files-test-payload") | 1;
    let mut buffer = [0u8; 64 * 1024];
    for _ in 0..(120 * 1024 * 1024 / buffer.len()) {
        for chunk in buffer.chunks_mut(8) {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            chunk.copy_from_slice(&state.to_le_bytes());
        }
        file.write_all(&buffer).map_err(local_error)?;
        hash.update(buffer);
    }
    Ok(hash.finalize().into())
}
fn sha256(path: &Path) -> Result<[u8; 32], AppError> {
    let mut file = std::fs::File::open(path).map_err(local_error)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(local_error)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().into())
}

#[tokio::test]
#[ignore = "requires unprivileged real SSH test account; transfers 120 MiB"]
async fn files_large_transfer_hash_progress_and_cancel_removes_partials() {
    let Some((target, base)) = environment() else {
        return;
    };
    files::file_mkdir(target.clone(), base.clone())
        .await
        .unwrap_or_else(|e| panic!("test directory setup failed: {:?}: {}", e.kind, e.message));
    let test_target = target.clone();
    let test_base = base.clone();
    let result = tokio::spawn(async move {
        let target = test_target;
        let base = test_base;
        let local = tempfile::tempdir().map_err(local_error)?;
        let source = local.path().join("ü ñ 文件 source.bin");
        let download = local.path().join("download.bin");
        let expected = random_payload(&source)?;
        let remote = format!("{base}/ü ñ 文件 test.bin");
        let mut up = Vec::new();
        transfers::transfer(
            target.clone(),
            "up".into(),
            source.to_string_lossy().into_owned(),
            remote.clone(),
            files::staging_name(),
            false,
            |event| {
                up.push(event);
                Ok(())
            },
        )
        .await?;
        require(
            up.len() >= 2
                && up.first().is_some_and(|p| p.bytes == 0)
                && up
                    .last()
                    .is_some_and(|p| p.bytes == 120 * 1024 * 1024 && p.bytes == p.total),
            "upload progress missing",
        )?;
        let mut down = Vec::new();
        transfers::transfer(
            target.clone(),
            "down".into(),
            download.to_string_lossy().into_owned(),
            remote.clone(),
            files::staging_name(),
            false,
            |event| {
                down.push(event);
                Ok(())
            },
        )
        .await?;
        require(
            sha256(&download)? == expected,
            "SHA-256 round trip mismatch",
        )?;
        require(
            down.len() >= 2 && down.last().is_some_and(|p| p.bytes == p.total),
            "download progress missing",
        )?;
        for direction in ["up", "down"] {
            let operation = files::staging_name();
            let id = operation.clone();
            let mut requested = false;
            let remote_path = if direction == "up" {
                format!("{base}/cancelled.bin")
            } else {
                remote.clone()
            };
            let local_path = if direction == "up" {
                source.clone()
            } else {
                local.path().join("cancelled.bin")
            };
            let result = transfers::transfer(
                target.clone(),
                direction.into(),
                local_path.to_string_lossy().into_owned(),
                remote_path,
                operation,
                false,
                |event| {
                    if !requested && event.bytes > 0 && event.bytes < event.total {
                        requested = true;
                        let id = id.clone();
                        tokio::spawn(async move {
                            let _ = transport::operation_cancel(&id).await;
                        });
                    }
                    Ok(())
                },
            )
            .await;
            require(
                requested
                    && matches!(
                        result,
                        Err(AppError {
                            kind: ErrorKind::Cancelled,
                            ..
                        })
                    ),
                "mid-transfer cancellation failed",
            )?;
        }
        let entries = files::files_list(target.clone(), base).await?;
        require(
            entries.len() == 1 && !entries.iter().any(|e| e.name.starts_with(".nodescape-")),
            "remote partial file remained",
        )?;
        require(
            std::fs::read_dir(local.path())
                .map_err(local_error)?
                .count()
                == 2,
            "local partial file remained",
        )?;
        Ok::<_, AppError>(())
    })
    .await;
    let cleaned = cleanup(&target, &base).await;
    assert!(cleaned.is_ok(), "test directory cleanup failed");
    match result {
        Ok(Ok(())) => (),
        Ok(Err(e)) => panic!("large transfer real check failed: {:?}", e.kind),
        Err(_) => panic!("large transfer check panicked"),
    }
}
