#[allow(dead_code)]
#[path = "../src/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../src/ssh_config.rs"]
mod ssh_config;
#[allow(dead_code)]
#[path = "../src/terminal.rs"]
mod terminal;
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;

use contracts::Target;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::mpsc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;

fn settings() -> Option<(Target, String)> {
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
    let (Some(config), Some(host), Some(base)) = (
        value("NODESCAPE_TEST_SSH_CONFIG"),
        value("NODESCAPE_TEST_HOST"),
        value("NODESCAPE_TEST_DIR"),
    ) else {
        eprintln!("SKIP terminal real SSH: configure NODESCAPE_TEST_SSH_CONFIG, NODESCAPE_TEST_HOST and NODESCAPE_TEST_DIR");
        return None;
    };
    assert!(contracts::valid_host(&host), "invalid test host");
    assert!(
        contracts::valid_remote_path(&base),
        "invalid test directory"
    );
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = format!(
        "{}/terminal-{}-{unique}",
        base.trim_end_matches('/'),
        std::process::id()
    );
    assert!(contracts::valid_remote_path(&dir));
    Some((
        Target {
            host,
            config: Some(config),
        },
        dir,
    ))
}
fn quote(path: &str) -> String {
    assert!(contracts::valid_remote_path(path));
    format!("'{}'", path.replace('\'', "'\\''"))
}
#[derive(Deserialize)]
struct Event {
    kind: String,
    id: String,
    data: Option<Vec<u8>>,
    code: Option<u32>,
}
struct Session {
    id: String,
    rx: mpsc::Receiver<Event>,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = terminal::close(&self.id);
    }
}
impl Session {
    fn send(&self, text: &str) -> Result<(), String> {
        terminal::input(&self.id, text).map_err(|e| format!("terminal input: {:?}", e.kind))
    }
    fn until(&self, marker: &str) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut bytes = Vec::new();
        loop {
            let event = self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| {
                    format!(
                        "terminal marker {marker:?} timed out; got {:?}",
                        String::from_utf8_lossy(&bytes)
                            .chars()
                            .rev()
                            .take(400)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect::<String>()
                    )
                })?;
            if event.kind == "exit" {
                return Err(format!("terminal exited early: {:?}", event.code));
            }
            if let Some(data) = event.data {
                terminal::ack(&event.id, data.len()).map_err(|_| "terminal ack failed")?;
                // Answer cursor-position queries (ConPTY sends one at startup) like xterm.js does.
                if data.windows(4).any(|w| w == b"\x1b[6n") {
                    self.send("\x1b[1;1R")?;
                }
                bytes.extend(data);
            }
            let text = String::from_utf8_lossy(&bytes);
            if text.contains(marker) {
                return Ok(text.into_owned());
            }
        }
    }
    fn scenario(&self, dir: &str) -> Result<(), String> {
        self.send(&format!(
            "mkdir -p -- {} && cd -- {} && export HOME=\"$PWD\" XDG_CONFIG_HOME=\"$PWD\" HISTFILE=\"$PWD/history\" PS1='NS_PROMPT> ' && printf 'NS_%s\\n' READY\r",
            quote(dir),
            quote(dir)
        ))?;
        self.until("NS_READY")?;
        self.send(
            "printf 'caf\\303\\251 \\346\\274\\242\\n'; stty size; printf 'NS_%s\\n' SIZE1\r",
        )?;
        let output = self.until("NS_SIZE1")?;
        if !output.contains("café 漢") || !output.contains("24 80") {
            return Err("UTF-8 or initial stty size missing".into());
        }
        terminal::resize(&self.id, 120, 40).map_err(|_| "terminal resize failed")?;
        self.send("stty size; printf 'NS_%s\\n' SIZE2\r")?;
        if !self.until("NS_SIZE2")?.contains("40 120") {
            return Err("resized stty size missing".into());
        }
        self.send("sleep 30\r")?;
        std::thread::sleep(Duration::from_millis(300));
        self.send("\x03")?;
        self.until("NS_PROMPT> ")?;
        self.send("printf 'NS_%s\\n' INTERRUPTED\r")?;
        self.until("NS_INTERRUPTED")?;
        self.send("if command -v htop >/dev/null 2>&1; then printf 'NS_%s\\n' HTOP; htop; else printf 'NS_%s\\n' NO_HTOP; fi\r")?;
        self.until("NS_HTOP")?;
        std::thread::sleep(Duration::from_millis(500));
        self.send("q")?;
        self.until("NS_PROMPT> ")?;
        self.send("printf 'NS_%s\\n' HTOP_DONE\r")?;
        self.until("NS_HTOP_DONE")?;
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires the configured test host and htop"]
async fn interactive_utf8_resize_interrupt_htop_and_close() {
    let Some((target, dir)) = settings() else {
        return;
    };
    let (tx, rx) = mpsc::channel();
    let channel = Channel::new(move |body| {
        let event = body.deserialize::<Event>().expect("terminal event shape");
        let _ = tx.send(event);
        Ok(())
    });
    let id = terminal::open(target.clone(), 80, 24, channel)
        .await
        .unwrap_or_else(|e| panic!("terminal open failed: {:?}", e.kind));
    let session = Session { id, rx };
    let result = session.scenario(&dir);
    // The only write/delete target is the validated per-test directory, even after a failed assertion.
    let cleanup = format!("rm -rf -- {}\n", quote(&dir));
    let cleaned = transport::run(&target, &cleanup, transport::RunOpts::default()).await;
    terminal::close(&session.id).expect("close must kill and reap ssh");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let event = session
            .rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("child must exit after close");
        if event.kind == "exit" {
            break;
        }
    }
    assert!(cleaned.is_ok(), "per-test directory cleanup failed");
    assert!(result.is_ok(), "{}", result.unwrap_err());
}
