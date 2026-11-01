// Run explicitly by the architect; these tests never generate or install keys.
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
#[path = "../src/onboarding.rs"]
mod onboarding;
#[allow(dead_code)]
#[path = "../src/profiles.rs"]
mod profiles;
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
use std::{
    collections::HashMap,
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
fn test_target() -> Option<Target> {
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
        eprintln!("SKIP real SSH: set NODESCAPE_TEST_SSH_CONFIG, NODESCAPE_TEST_HOST and NODESCAPE_TEST_DIR or use ../.env.test.local");
        return None;
    };
    assert!(contracts::valid_host(&host), "invalid test host alias");
    assert!(contracts::valid_remote_path(&dir), "invalid test directory");
    Some(Target {
        host,
        config: Some(config),
    })
}

#[tokio::test]
#[ignore = "requires the configured test host"]
async fn connection_test_succeeds() {
    let Some(target) = test_target() else {
        return;
    };
    let result =
        onboarding::connection_test(target, Some("onboarding-real-connection".into())).await;
    assert!(
        result.is_ok(),
        "connection_test failed: {:?}",
        result.err().map(|e| e.kind)
    );
}
#[tokio::test]
#[ignore = "requires local OpenSSH"]
async fn environment_check_finds_ssh() {
    let result = onboarding::environment_check().await.unwrap();
    let result = serde_json::to_value(result).unwrap();
    assert!(result["ssh"]["version"].is_string());
    assert!(result["ssh"]["error"].is_null());
}
#[derive(serde::Deserialize)]
struct Event {
    kind: String,
    id: String,
    data: Option<Vec<u8>>,
}
struct Session(String);
impl Drop for Session {
    fn drop(&mut self) {
        let _ = terminal::close(&self.0);
    }
}
#[tokio::test]
#[ignore = "requires the configured test host; fingerprint refusal in PTY"]
async fn trust_prompt_refusal_writes_nothing() {
    let Some(mut target) = test_target() else {
        return;
    };
    let dir = tempfile::Builder::new()
        .prefix("onboarding trust ")
        .tempdir()
        .unwrap();
    let known = dir.path().join("known_hosts");
    std::fs::write(&known, "").unwrap();
    let original = target.config.take().unwrap();
    let before = std::fs::read(&original).unwrap();
    let config = dir.path().join("ssh_config");
    let quote = |p: &str| {
        assert!(!p.contains(['\r', '\n', '"']));
        format!("\"{}\"", p.replace('\\', "/"))
    };
    // Copy the config instead of `Include`: Windows OpenSSH rejects included files whose ACLs
    // allow other users, while the file passed with -F is accepted. The overrides come first,
    // so they win (first obtained value wins).
    let included = String::from_utf8_lossy(&before);
    std::fs::write(&config,format!("Host *\n  UserKnownHostsFile {}\n  GlobalKnownHostsFile none\n  KnownHostsCommand none\n  VerifyHostKeyDNS no\n\n{included}\n",quote(&known.to_string_lossy()))).unwrap();
    profiles::private_file(&config).unwrap();
    target.config = Some(config.to_string_lossy().into());
    let (tx, rx) = mpsc::channel();
    let channel = Channel::new(move |body| {
        let _ = tx.send(body.deserialize::<Event>().unwrap());
        Ok(())
    });
    let id = terminal::terminal_open_kind(
        target,
        terminal::SessionKind::TrustHost,
        terminal::KindArgs::default(),
        80,
        24,
        channel,
    )
    .await
    .unwrap_or_else(|e| panic!("trust terminal failed: {:?}", e.kind));
    let session = Session(id);
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut bytes = Vec::new();
    let mut refused = false;
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("fingerprint prompt or exit timed out");
        if event.kind == "exit" {
            break;
        }
        if let Some(data) = event.data {
            terminal::ack(&event.id, data.len()).unwrap();
            if data.windows(4).any(|w| w == b"\x1b[6n") {
                terminal::input(&session.0, "\x1b[1;1R").unwrap();
            }
            bytes.extend(data);
            let text = String::from_utf8_lossy(&bytes);
            if !refused && text.contains("fingerprint") && text.contains("yes/no") {
                terminal::input(&session.0, "no\r").unwrap();
                refused = true;
            }
        }
    }
    assert!(refused, "OpenSSH did not present its fingerprint prompt");
    assert!(std::fs::read(&known).unwrap().is_empty());
    assert!(
        std::fs::read(&original).unwrap() == before,
        "original config was modified"
    );
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        2,
        "unexpected trust artifact"
    );
}
