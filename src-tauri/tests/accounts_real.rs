#[allow(dead_code)]
#[path = "../src/accounts.rs"]
mod accounts;
#[allow(dead_code)]
#[path = "../src/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../src/sudo.rs"]
mod sudo;
#[allow(dead_code)]
#[path = "../src/askpass.rs"]
mod askpass;
#[allow(dead_code)]
#[path = "../src/credentials.rs"]
mod credentials;
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
#[ignore = "requires the test host; read-only accounts inspection, never mutations"]
async fn accounts_read_has_users_groups_and_current_user() {
    let Some(target) = test_target() else {
        return;
    };
    let data = match accounts::accounts_read(target, Some("accounts-real-read".into())).await {
        Ok(data) => data,
        Err(error) => panic!("accounts read failed: {:?}", error.kind),
    };
    assert!(!data.users.is_empty(), "users missing");
    assert!(!data.groups.is_empty(), "groups missing");
    assert!(
        data.users.iter().any(|user| user.name == data.current_user),
        "current user missing"
    );
}
