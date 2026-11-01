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
#[path = "../src/services.rs"]
mod services;
#[allow(dead_code)]
#[path = "../src/sudo.rs"]
mod sudo;
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;

use contracts::{AppError, Target};
use std::collections::HashMap;
use transport::RunOpts;

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
#[ignore = "requires the test host; read-only services inspection without sudo"]
async fn services_read_returns_system_and_account_scopes() {
    let Some(target) = test_target() else {
        return;
    };
    let result = services::services_read(target, None).await;
    let data = result.unwrap_or_else(|e| panic!("services read failed: {:?}", e.kind));
    assert!(!data.system.units.is_empty(), "expected system services");
    assert!(data
        .system
        .units
        .iter()
        .all(|u| contracts::valid_unit(&u.name)));
    if !data.user.available {
        eprintln!("SKIP user scope: user manager unavailable; login or lingering is required");
        assert!(data.user.reason.is_some());
        assert!(data.user.units.is_empty());
    }
}

#[tokio::test]
#[ignore = "requires the test host and its user manager; only a throwaway transient user unit"]
async fn transient_account_service_can_restart_and_stop_without_sudo() {
    let Some(target) = test_target() else {
        return;
    };
    let data = services::services_read(target.clone(), None)
        .await
        .unwrap_or_else(|e| panic!("services read failed: {:?}", e.kind));
    if !data.user.available {
        eprintln!(
            "SKIP transient user unit: user manager unavailable; login or lingering is required"
        );
        return;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let unit = format!("nodescape-test-{}-{nonce}.service", std::process::id());
    assert!(contracts::valid_unit(&unit));
    let create = format!(
        r#"export LC_ALL=C
runtime_dir=/run/user/$(id -u)
if [ -d "$runtime_dir" ]; then export XDG_RUNTIME_DIR="$runtime_dir"; fi
systemd-run --user --unit='{unit}' -- sleep 120
"#
    );
    let exercise = async {
        transport::run(&target, &create, RunOpts::default()).await?;
        services::service_action(
            target.clone(),
            "user".into(),
            unit.clone(),
            "restart".into(),
            None,
            None,
        )
        .await?;
        let restarted = services::services_read(target.clone(), None).await?;
        let active = restarted
            .user
            .units
            .iter()
            .any(|u| u.name == unit && u.active == "active");
        services::service_action(
            target.clone(),
            "user".into(),
            unit.clone(),
            "stop".into(),
            None,
            None,
        )
        .await?;
        let stopped = services::services_read(target.clone(), None).await?;
        let inactive = !stopped
            .user
            .units
            .iter()
            .any(|u| u.name == unit && u.active != "inactive");
        Ok::<_, AppError>((active, inactive))
    }
    .await;
    // Cleanup failures cannot leave a persistent unit: its sleep expires after 120s.
    if !matches!(&exercise, Ok((_, true))) {
        let cleanup =
            services::service_action(target, "user".into(), unit, "stop".into(), None, None).await;
        if cleanup.is_err() {
            eprintln!(
                "Transient cleanup could not be confirmed; the unit expires after 120 seconds"
            );
        }
    }
    let (active, inactive) =
        exercise.unwrap_or_else(|e| panic!("transient unit exercise failed: {:?}", e.kind));
    assert!(active, "our transient unit was not active after restart");
    assert!(inactive, "our transient unit remained active after stop");
}
