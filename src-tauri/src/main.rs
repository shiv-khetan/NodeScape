#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod contracts;

use contracts::{classify_ssh_failure, valid_host, valid_unit, AppError, ErrorKind, Target};
use std::io::{ErrorKind as IoErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ponytail: shells out to the system `ssh`, so ssh config files, keys, known_hosts and ssh-agent just work.
// No agent on the server; swap for the `russh` crate if we ever need password auth or a pooled session.

// CPU and network are sampled first, before the script prints anything, so the app's own SSH output
// doesn't show up as network traffic.
const SNAPSHOT: &str = r#"
echo @rx1; tail -n +3 /proc/net/dev
echo @cpu; head -1 /proc/stat; sleep 0.5; head -1 /proc/stat
echo @rx2; tail -n +3 /proc/net/dev
echo @gw; ip route show default 2>/dev/null
echo @conn; echo "$SSH_CONNECTION"
echo @host; hostname
echo @os; [ -r /etc/os-release ] && . /etc/os-release; echo "${PRETTY_NAME:-$(uname -s)}"
echo @kernel; uname -r
echo @ip; hostname -I 2>/dev/null
echo @uptime; cat /proc/uptime
echo @load; cat /proc/loadavg
echo @cpus; nproc
echo @mem; free -b
echo @disk; df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs --output=target,size,used 2>/dev/null | tail -n +2
echo @net; ip -br addr 2>/dev/null
echo @svc; systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null
echo @log; journalctl -q -n 12 --no-pager -o short-iso 2>/dev/null
true
"#;

const PROCESSES: &str = "ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu --no-headers | head -80";

// `|| true`: grep exits 1 when there is no crontab, which must not read as a connection failure.
const TIMERS: &str = r#"
echo @timers; systemctl show '*.timer' --no-pager -p Id -p Unit -p ActiveState -p NextElapseUSecRealtime -p LastTriggerUSec 2>/dev/null
echo @cron; crontab -l 2>/dev/null | grep -v '^#' || true
"#;

/// The ssh config to use: the one picked in Settings, else ~/.ssh/config (ssh's own default).
fn config_path(config: &Option<String>) -> Result<Option<PathBuf>, AppError> {
    match config.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) if Path::new(c).is_file() => Ok(Some(PathBuf::from(c))),
        Some(c) => Err(AppError::new(
            ErrorKind::InvalidInput,
            format!("SSH config file not found: {c}"),
        )),
        None => Ok(None),
    }
}

/// Runs `script` on `host` through `sh -s` (script on stdin, so no remote quoting issues).
fn ssh(host: &str, config: &Option<String>, script: &str) -> Result<String, AppError> {
    if !valid_host(host) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid host. Use an ssh config alias or user@host.",
        ));
    }
    let mut cmd = Command::new("ssh");
    if let Some(cfg) = config_path(config)? {
        cmd.arg("-F").arg(cfg);
    }
    // No StrictHostKeyChecking override: with BatchMode ssh refuses unknown or changed host keys,
    // and whatever the config says (e.g. HostKeyAlias) still applies.
    cmd.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "--",
        host,
        "sh -s",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash per call
    }
    let mut child = cmd.spawn().map_err(|e| {
        let kind = if e.kind() == IoErrorKind::NotFound {
            ErrorKind::SshMissing
        } else {
            ErrorKind::Internal
        };
        AppError::new(kind, format!("Could not start ssh: {e}"))
    })?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(script.as_bytes())
        .map_err(|e| AppError::new(ErrorKind::Internal, e.to_string()))?;
    let out = child
        .wait_with_output()
        .map_err(|e| AppError::new(ErrorKind::Internal, e.to_string()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(classify_ssh_failure(&stderr, &stdout, out.status.code()))
}

async fn run(host: String, config: Option<String>, script: String) -> Result<String, AppError> {
    let target = Target { host, config };
    tauri::async_runtime::spawn_blocking(move || ssh(&target.host, &target.config, &script))
        .await
        .map_err(|e| AppError::new(ErrorKind::Internal, e.to_string()))?
}

fn parse_hosts(cfg: &str) -> Vec<String> {
    cfg.lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            w.next()?.eq_ignore_ascii_case("host").then_some(w)
        })
        .flatten()
        .filter(|h| !h.contains(['*', '?', '!']))
        .map(String::from)
        .collect()
}

#[tauri::command]
fn hosts(config: Option<String>) -> Vec<String> {
    let path = config_path(&config).ok().flatten().unwrap_or_else(|| {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .unwrap_or_default();
        Path::new(&home).join(".ssh").join("config")
    });
    parse_hosts(&std::fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
async fn query(host: String, what: String, config: Option<String>) -> Result<String, AppError> {
    let script = match what.as_str() {
        "snapshot" => SNAPSHOT,
        "processes" => PROCESSES,
        "timers" => TIMERS,
        _ => return Err(AppError::new(ErrorKind::InvalidInput, "unknown query")),
    };
    run(host, config, script.into()).await
}

#[tauri::command]
async fn logs(
    host: String,
    unit: Option<String>,
    lines: u32,
    config: Option<String>,
) -> Result<String, AppError> {
    let unit = match unit.filter(|u| !u.is_empty()) {
        Some(u) if valid_unit(&u) => format!("-u {u}"),
        Some(_) => return Err(AppError::new(ErrorKind::InvalidInput, "Invalid unit name")),
        None => String::new(),
    };
    run(
        host,
        config,
        format!(
            "journalctl -n {} --no-pager -o short-iso {unit} 2>&1",
            lines.clamp(1, 5000)
        ),
    )
    .await
}

#[tauri::command]
async fn service_action(
    host: String,
    unit: String,
    action: String,
    config: Option<String>,
) -> Result<String, AppError> {
    if !["start", "stop", "restart", "enable", "disable"].contains(&action.as_str())
        || !valid_unit(&unit)
    {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Refused: unknown action or invalid unit name",
        ));
    }
    // sudo -n never prompts: fails fast unless the user allowed passwordless systemctl in sudoers.
    run(
        host,
        config,
        format!("sudo -n systemctl {action} -- {unit} 2>&1 && echo ok"),
    )
    .await
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![hosts, query, logs, service_action])
        .run(tauri::generate_context!())
        .expect("error while running NodeScape");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation() {
        assert_eq!(
            parse_hosts("Host nas pi\n  HostName 10.0.0.2\nHost *\nhost box"),
            ["nas", "pi", "box"]
        );
        assert_eq!(config_path(&None), Ok(None));
        assert_eq!(config_path(&Some("  ".into())), Ok(None));
        assert!(config_path(&Some("Z:/no/such/config".into())).is_err());
        assert_eq!(
            config_path(&Some("Cargo.toml".into())),
            Ok(Some(PathBuf::from("Cargo.toml")))
        );
    }
}
