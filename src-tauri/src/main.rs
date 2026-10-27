#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod contracts;
mod files;
mod network;
mod onboarding;
mod profiles;
mod services;
mod transfers;
// P05 consumes effective config inspection.
#[allow(dead_code)]
mod ssh_config;
mod sudo;
mod terminal;
mod transport;

use contracts::{valid_unit, AppError, ErrorKind, Target};
use std::path::{Path, PathBuf};

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
echo @disk; df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs --output=size,used,target 2>/dev/null | tail -n +2
echo @temps
if command -v sensors >/dev/null 2>&1; then
    sensors -j 2>/dev/null
else
    for zone in /sys/class/thermal/thermal_zone*; do
        [ -r "$zone/type" ] && [ -r "$zone/temp" ] || continue
        label=$(cat "$zone/type" 2>/dev/null)
        temp=$(cat "$zone/temp" 2>/dev/null)
        [ -n "$label" ] && [ -n "$temp" ] && printf '%s\n%s\n' "$label" "$temp"
    done
fi
echo @groups; id -nG
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

async fn run(
    host: String,
    config: Option<String>,
    script: String,
    operation_id: Option<String>,
) -> Result<String, AppError> {
    let opts = transport::RunOpts {
        operation_id,
        ..Default::default()
    };
    transport::run(&Target { host, config }, &script, opts).await
}

#[tauri::command]
async fn operation_cancel(id: String) -> Result<bool, AppError> {
    transport::operation_cancel(&id).await
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
async fn query(
    host: String,
    what: String,
    config: Option<String>,
    operation_id: Option<String>,
) -> Result<String, AppError> {
    let script = match what.as_str() {
        "snapshot" => SNAPSHOT,
        "processes" => PROCESSES,
        "timers" => TIMERS,
        _ => return Err(AppError::new(ErrorKind::InvalidInput, "unknown query")),
    };
    run(host, config, script.into(), operation_id).await
}

#[tauri::command]
async fn logs(
    host: String,
    unit: Option<String>,
    lines: u32,
    config: Option<String>,
    operation_id: Option<String>,
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
        operation_id,
    )
    .await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            accounts::accounts_read,
            accounts::account_action,
            network::network_read,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_remove,
            ssh_config::ssh_config_save,
            onboarding::environment_check,
            onboarding::public_key_read,
            onboarding::connection_test,
            terminal::terminal_open_kind,
            hosts,
            query,
            logs,
            services::services_read,
            services::service_action,
            operation_cancel,
            terminal::terminal_open,
            terminal::terminal_input,
            terminal::terminal_resize,
            terminal::terminal_ack,
            terminal::terminal_close,
            files::files_home,
            files::files_list,
            files::file_mkdir,
            files::file_create,
            files::file_rename,
            files::file_delete,
            files::file_read_text,
            files::file_write_text,
            transfers::transfer_start
        ])
        .build(tauri::generate_context!())
        .expect("error while building NodeScape")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                terminal::close_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_includes_system_sections() {
        assert!(SNAPSHOT.contains("echo @temps"));
        assert!(SNAPSHOT.contains("sensors -j 2>/dev/null"));
        assert!(SNAPSHOT.contains("/sys/class/thermal/thermal_zone*"));
        assert!(SNAPSHOT.contains("echo @groups; id -nG"));
        assert!(SNAPSHOT.contains("--output=size,used,target"));
    }

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
