#[allow(dead_code)]
#[path = "../src/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;

use contracts::{ErrorKind, Target};
use std::{collections::HashMap, time::Instant};
use transport::{run, RunOpts};

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
#[ignore = "requires the test host"]
async fn snapshot_succeeds_read_only() {
    let Some(target) = test_target() else {
        return;
    };
    // Use the app's exact collector without importing its command or starting Tauri.
    let source = include_str!("../src/main.rs");
    let script = source
        .split_once("const SNAPSHOT: &str = r#\"")
        .unwrap()
        .1
        .split_once("\"#;")
        .unwrap()
        .0;
    let started = Instant::now();
    let result = run(&target, script, RunOpts::default()).await;
    let elapsed = started.elapsed();
    let output = match result {
        Ok(output) => output,
        Err(error) => panic!("snapshot on the test host failed: {:?}", error.kind),
    };
    for marker in ["@cpu", "@host", "@uptime", "@mem", "@disk"] {
        assert!(output.contains(marker), "snapshot marker missing");
    }
    eprintln!(
        "Real snapshot on the test host: {:.3} s",
        elapsed.as_secs_f64()
    );
}

#[tokio::test]
#[ignore = "requires the test host config"]
async fn unknown_alias_is_a_classified_failure() {
    let Some(mut target) = test_target() else {
        return;
    };
    target.host = "nodescape-unknown-alias.invalid".into();
    let result = run(&target, "true\n", RunOpts::default()).await;
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("unknown alias unexpectedly connected"),
    };
    assert!(
        error.kind != ErrorKind::Internal,
        "unknown alias must have a non-internal kind"
    );
}

#[tokio::test]
#[ignore = "requires the test host; strict unknown-key refusal"]
async fn empty_known_hosts_is_refused_without_writes() {
    let Some(target) = test_target() else {
        return;
    };
    let dir = tempfile::Builder::new()
        .prefix("nodescape trust test ")
        .tempdir()
        .unwrap();
    let known_hosts = dir.path().join("empty known hosts");
    std::fs::write(&known_hosts, "").unwrap();
    let config_before =
        std::fs::read(target.config.as_ref().unwrap()).expect("cannot read test config");
    let options = RunOpts {
        known_hosts_file: Some(known_hosts.clone()),
        ..RunOpts::default()
    };
    let result = run(&target, "true\n", options).await;
    let kind = match result {
        Err(error) => error.kind,
        Ok(_) => panic!("untrusted test host unexpectedly connected"),
    };
    assert_eq!(
        kind,
        ErrorKind::HostKeyUnknown,
        "test host must require an existing trusted key"
    );
    assert_eq!(std::fs::read(&known_hosts).unwrap(), b"");
    assert!(
        std::fs::read(target.config.as_ref().unwrap()).expect("cannot read test config")
            == config_before,
        "test config was modified"
    );
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        1,
        "ssh wrote an unexpected file"
    );
}
