#[allow(dead_code)]
#[path = "../src/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../src/profiles.rs"]
mod profiles;
#[allow(dead_code)]
#[path = "../src/ssh_config.rs"]
mod ssh_config;
// The SFTP launcher is exercised by files_real.rs, not here.
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;

use contracts::{AppError, ErrorKind, Target};
use std::time::{Duration, Instant};
use transport::{run, RunOpts};

fn target(host: &str) -> Target {
    Target {
        host: host.into(),
        config: None,
    }
}

fn opts() -> RunOpts {
    RunOpts {
        ssh_program: env!("CARGO_BIN_EXE_fake-ssh").into(),
        timeout: Duration::from_secs(3),
        ..RunOpts::default()
    }
}

// Open a synchronization handle while the fake is alive, then wait on that exact process.
#[cfg(windows)]
mod process_handle {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    }
    pub struct Process(OwnedHandle);
    impl Process {
        pub fn open(pid: u32) -> Self {
            // SAFETY: request only SYNCHRONIZE, then take ownership of the returned handle.
            let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
            assert!(!handle.is_null(), "cannot open child process handle");
            Self(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
        pub fn assert_gone(&self) {
            // SAFETY: the owned synchronization handle remains valid throughout this wait.
            assert_eq!(
                unsafe { WaitForSingleObject(self.0.as_raw_handle(), 1000) },
                0,
                "child is still running"
            );
        }
    }
}

async fn wait_pid(path: &std::path::Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse() {
                    break pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("fake ssh did not start")
}

fn stalled_call(
    id: &str,
    timeout: Duration,
) -> (
    tempfile::TempDir,
    std::path::PathBuf,
    tokio::task::JoinHandle<Result<String, AppError>>,
) {
    let dir = tempfile::tempdir().unwrap();
    let pid_path = dir.path().join("pid");
    let script = format!("{}\n{}", pid_path.display(), "x".repeat(2_000_000));
    let options = RunOpts {
        operation_id: Some(id.into()),
        timeout,
        ..opts()
    };
    let task = tokio::spawn(async move { run(&target("stall"), &script, options).await });
    (dir, pid_path, task)
}

#[tokio::test]
async fn echoes_large_stdin() {
    let script = "echo example\n".repeat(100_000);
    assert_eq!(run(&target("echo"), &script, opts()).await.unwrap(), script);
}

#[tokio::test]
async fn every_call_has_required_strict_arguments_and_no_default_config_override() {
    let args = run(&target("args"), "", opts()).await.unwrap();
    for value in [
        "-T",
        "BatchMode=yes",
        "ConnectTimeout=5",
        "RequestTTY=no",
        "SessionType=default",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
        "--",
        "args",
        "sh -s",
    ] {
        assert!(
            args.lines().any(|line| line == value),
            "missing argument: {value}"
        );
    }
    assert!(!args.lines().any(|line| line == "-F"));
}

#[tokio::test]
async fn deadline_kills_stalled_child_including_blocked_stdin() {
    let started = Instant::now();
    let (_dir, path, task) = stalled_call("timeout-test", Duration::from_millis(700));
    let _pid = wait_pid(&path).await;
    #[cfg(windows)]
    let process = process_handle::Process::open(_pid);
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert!(started.elapsed() < Duration::from_millis(1700));
    #[cfg(windows)]
    process.assert_gone();
    assert!(!transport::operation_cancel("timeout-test").await.unwrap());
}

#[tokio::test]
async fn stdout_and_stderr_floods_are_capped_without_deadlock() {
    for host in ["flood-out", "flood-err", "flood-both"] {
        let started = Instant::now();
        let options = RunOpts {
            max_output: 64 * 1024,
            ..opts()
        };
        let error = run(&target(host), &"x".repeat(2_000_000), options)
            .await
            .unwrap_err();
        assert_eq!(error, AppError::new(ErrorKind::Remote, "output too large"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

#[tokio::test]
async fn default_deadline_and_capture_cap() {
    assert_eq!(RunOpts::default().timeout, Duration::from_secs(15));
    assert_eq!(RunOpts::default().max_output, 16 * 1024 * 1024);
    assert_eq!(
        run(&target("flood-out"), "", opts()).await.unwrap_err(),
        AppError::new(ErrorKind::Remote, "output too large")
    );
}

#[tokio::test]
async fn failures_use_contract_classifier_even_when_stdin_closes_early() {
    for (host, message, kind) in [
        (
            "exit-255-auth",
            "Permission denied (publickey).",
            ErrorKind::AuthFailed,
        ),
        (
            "exit-255-unknown",
            "Host key verification failed.",
            ErrorKind::HostKeyUnknown,
        ),
        (
            "exit-255-changed",
            "REMOTE HOST IDENTIFICATION HAS CHANGED",
            ErrorKind::HostKeyChanged,
        ),
        (
            "exit-255-unreachable",
            "Connection refused",
            ErrorKind::Unreachable,
        ),
        ("exit-42", "collector failed", ErrorKind::Remote),
    ] {
        let error = run(&target(host), &"x".repeat(2_000_000), opts())
            .await
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert_eq!(error.message, message);
    }
    assert_eq!(
        run(&target("exit-empty"), "", opts())
            .await
            .unwrap_err()
            .message,
        "ssh exited with 42"
    );
}

#[tokio::test]
async fn missing_program_and_invalid_input() {
    let options = RunOpts {
        ssh_program: "nodescape-nonexistent-ssh-842912".into(),
        ..opts()
    };
    assert_eq!(
        run(&target("echo"), "", options).await.unwrap_err().kind,
        ErrorKind::SshMissing
    );
    for host in ["", "-oProxyCommand=bad", "bad host"] {
        assert_eq!(
            run(&target(host), "", opts()).await.unwrap_err().kind,
            ErrorKind::InvalidInput
        );
    }
    for config in ["bad\nconfig", "missing-config", "bad\0config"] {
        let target = Target {
            host: "echo".into(),
            config: Some(config.into()),
        };
        assert_eq!(
            run(&target, "", opts()).await.unwrap_err().kind,
            ErrorKind::InvalidInput
        );
    }
}

#[tokio::test]
async fn cancellation_kills_child_and_removes_registration() {
    let (_dir, path, task) = stalled_call("cancel-test", Duration::from_secs(3));
    let _pid = wait_pid(&path).await;
    #[cfg(windows)]
    let process = process_handle::Process::open(_pid);
    assert!(transport::operation_cancel("cancel-test").await.unwrap());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .kind,
        ErrorKind::Cancelled
    );
    #[cfg(windows)]
    process.assert_gone();
    assert!(!transport::operation_cancel("cancel-test").await.unwrap());
}

#[tokio::test]
async fn duplicate_ids_do_not_orphan_the_first_child() {
    let (_dir, path, task) = stalled_call("duplicate-test", Duration::from_secs(3));
    let _pid = wait_pid(&path).await;
    #[cfg(windows)]
    let process = process_handle::Process::open(_pid);
    let options = RunOpts {
        operation_id: Some("duplicate-test".into()),
        ..opts()
    };
    assert_eq!(
        run(&target("echo"), "", options).await.unwrap_err().kind,
        ErrorKind::InvalidInput
    );
    transport::operation_cancel("duplicate-test").await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    #[cfg(windows)]
    process.assert_gone();
}

#[tokio::test]
async fn dropping_a_call_kills_child_and_cleans_registry() {
    let (_dir, path, task) = stalled_call("drop-test", Duration::from_secs(3));
    let _pid = wait_pid(&path).await;
    #[cfg(windows)]
    let process = process_handle::Process::open(_pid);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(!transport::operation_cancel("drop-test").await.unwrap());
    #[cfg(windows)]
    process.assert_gone();
}

#[tokio::test]
async fn capture_limit_is_shared_and_both_pipes_drain_before_stdin() {
    let options = RunOpts {
        max_output: 80_000,
        ..opts()
    };
    assert_eq!(
        run(&target("dual"), &"x".repeat(2_000_000), options)
            .await
            .unwrap()
            .len(),
        40_000
    );
    let options = RunOpts {
        max_output: 79_999,
        ..opts()
    };
    assert_eq!(
        run(&target("dual"), "", options).await.unwrap_err(),
        AppError::new(ErrorKind::Remote, "output too large")
    );
}

#[tokio::test]
async fn config_with_spaces_is_passed_directly_and_strict_cli_wins() {
    let dir = tempfile::Builder::new()
        .prefix("nodescape config spaces ")
        .tempdir()
        .unwrap();
    let config = dir.path().join("chosen config");
    std::fs::write(&config, "Host *\n StrictHostKeyChecking accept-new\n UpdateHostKeys yes\nHost testbox\n HostName example.invalid\n HostKeyAlias test-key\n IdentityFile \"/synthetic key with spaces\"\n ProxyJump jumpbox\nHost jumpbox\n HostName jump.invalid\n HostKeyAlias jump-key\n").unwrap();
    let mut target = Target {
        host: "args".into(),
        config: Some(config.to_string_lossy().into_owned()),
    };
    let args = run(&target, "", opts()).await.unwrap();
    let lines: Vec<_> = args.lines().collect();
    let position = lines.iter().position(|s| *s == "-F").unwrap();
    assert_eq!(lines[position + 1], config.to_str().unwrap());
    target.host = "testbox".into();
    let effective = match ssh_config::effective(&target).await {
        Err(e) if e.kind == ErrorKind::SshMissing => {
            eprintln!("SKIP ssh -G precedence: ssh is not installed");
            return;
        }
        result => result.unwrap(),
    };
    assert_eq!(
        effective.get("stricthostkeychecking").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        effective.get("updatehostkeys").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        effective.get("hostkeyalias").map(String::as_str),
        Some("test-key")
    );
    assert_eq!(
        effective.get("identityfile").map(String::as_str),
        Some("/synthetic key with spaces")
    );
    assert_eq!(
        effective.get("proxyjump").map(String::as_str),
        Some("jumpbox")
    );
    target.host = "jumpbox".into();
    let effective = ssh_config::effective(&target).await.unwrap();
    assert_eq!(
        effective.get("stricthostkeychecking").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        effective.get("hostkeyalias").map(String::as_str),
        Some("jump-key")
    );
}

#[tokio::test]
async fn single_jump_is_replaced_with_a_strict_proxy_command() {
    let args = run(&target("jump-one"), "", opts()).await.unwrap();
    let proxy = args
        .lines()
        .find(|line| line.starts_with("ProxyCommand="))
        .unwrap();
    for value in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
        "-W",
        "%h:%p",
        "testjump",
    ] {
        assert!(proxy.contains(value), "proxy is missing {value}");
    }
    assert!(proxy.contains(env!("CARGO_BIN_EXE_fake-ssh")));
    assert!(!proxy.contains("-F"));
    let args = run(&target("jump-port"), "", opts()).await.unwrap();
    let proxy = args
        .lines()
        .find(|line| line.starts_with("ProxyCommand="))
        .unwrap();
    assert!(proxy.contains("2222"));
    assert!(proxy.contains("testuser@testjump"));
    for host in ["jump-chain", "jump-invalid"] {
        let error = run(&target(host), "", opts()).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
    }
    let error = run(&target("jump-chain"), "", opts()).await.unwrap_err();
    assert_eq!(error.message, "Multiple jump hosts are not supported yet");
}

#[tokio::test]
async fn preflight_uses_the_same_deadline_and_is_cancellable() {
    for host in ["config-stall", "config-flood", "config-auth"] {
        let options = RunOpts {
            timeout: if host == "config-stall" {
                Duration::from_millis(250)
            } else {
                Duration::from_secs(3)
            },
            max_output: 1024,
            ..opts()
        };
        let error = run(&target(host), "", options).await.unwrap_err();
        let expected = match host {
            "config-stall" => ErrorKind::Timeout,
            "config-flood" => ErrorKind::Remote,
            _ => ErrorKind::AuthFailed,
        };
        assert_eq!(error.kind, expected);
    }
    let options = RunOpts {
        operation_id: Some("preflight-cancel".into()),
        ..opts()
    };
    let task = tokio::spawn(async move { run(&target("config-stall"), "", options).await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !transport::operation_cancel("preflight-cancel")
            .await
            .unwrap()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().kind, ErrorKind::Cancelled);
}

#[cfg(windows)]
#[tokio::test]
async fn windows_proxy_command_quotes_program_and_config_paths_with_spaces() {
    let dir = tempfile::Builder::new()
        .prefix("nodescape proxy spaces ")
        .tempdir()
        .unwrap();
    let fake = dir.path().join("fake %r ssh.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_fake-ssh"), &fake).unwrap();
    let config = dir.path().join("chosen %h config");
    std::fs::write(&config, "Host testbox\n HostName example.invalid\n").unwrap();
    let target = Target {
        host: "testbox".into(),
        config: Some(config.to_string_lossy().into_owned()),
    };
    let known_hosts = dir.path().join("empty known hosts");
    std::fs::write(&known_hosts, "").unwrap();
    let proxy = transport::proxy_command(&target, &fake, "proxy-args", Some(&known_hosts)).unwrap();
    let mut command = tokio::process::Command::new(transport::ssh_program());
    command
        .creation_flags(0x0800_0000)
        .kill_on_drop(true)
        .arg("-F")
        .arg(&config)
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "UpdateHostKeys=no",
            "-o",
            &format!("ProxyCommand={proxy}"),
            "--",
            "testbox",
        ]);
    let output = tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .unwrap()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("PROXY_ARGS"),
        "proxy helper did not execute"
    );
    assert!(
        stderr.contains(config.to_str().unwrap()),
        "config path was not passed intact"
    );
    assert!(stderr.contains("StrictHostKeyChecking=yes"));
    assert!(stderr.contains("UpdateHostKeys=no"));
    let known_path = known_hosts.to_str().unwrap().replace('\\', "/");
    assert!(
        stderr.contains(&format!("UserKnownHostsFile=\"{known_path}\"")),
        "trust-store path was not passed intact"
    );
}

#[test]
fn jump_hosts_and_ports_are_validated_before_execution() {
    for jump in [
        "testjump",
        "testuser@testjump:2222",
        "[::1]:22",
        "testuser@[::1]:2222",
    ] {
        assert!(transport::proxy_command(&target("echo"), &opts().ssh_program, jump, None).is_ok());
    }
    for jump in [
        "one,two",
        "",
        "-oProxyCommand=x",
        "x;command",
        "@jump",
        "user@-jump",
        ":22",
        "jump:0",
        "jump:65536",
        "jump:noport",
        "[::1",
        "[::1]suffix",
        "[]:22",
    ] {
        assert_eq!(
            transport::proxy_command(&target("echo"), &opts().ssh_program, jump, None)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidInput
        );
    }
}
