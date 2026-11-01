#[allow(dead_code)]
#[path = "../src/askpass.rs"]
mod askpass;
#[allow(dead_code)]
#[path = "../src/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../src/credentials.rs"]
mod credentials;
#[path = "../src/network.rs"]
mod network;
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;
use contracts::Target;
use std::collections::HashMap;

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
#[ignore = "requires the test host; read-only network inspection"]
async fn network_read_is_redacted_and_has_interfaces_and_ports() {
    let Some(target) = test_target() else {
        return;
    };
    let result = network::network_read(target, Some("network-real-read".into())).await;
    let data = match result {
        Ok(data) => data,
        Err(error) => panic!("network read failed: {:?}", error.kind),
    };
    assert!(
        data.interfaces
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| !items.is_empty()),
        "interfaces missing"
    );
    assert!(
        data.ports.as_ref().is_some_and(|ports| !ports.is_empty()),
        "listeners missing"
    );
    if let Some(tailscale) = data.tailscale {
        let object = tailscale.as_object().unwrap();
        assert!(object
            .keys()
            .all(|key| ["Self", "peers"].contains(&key.as_str())));
        for node in
            std::iter::once(&tailscale["Self"]).chain(tailscale["peers"].as_array().unwrap())
        {
            assert!(
                node.as_object().unwrap().keys().all(|key| [
                    "HostName",
                    "TailscaleIPs",
                    "Online",
                    "OS",
                    "LastSeen"
                ]
                .contains(&key.as_str())),
                "unexpected Tailscale field"
            );
        }
    }
}
