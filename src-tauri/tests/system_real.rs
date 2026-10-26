#[allow(dead_code)]
#[path = "../src/contracts.rs"]
mod contracts;
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;

use contracts::Target;
use std::collections::HashMap;
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
#[ignore = "requires the test host; read-only system snapshot"]
async fn snapshot_contains_temperatures_and_groups() {
    let Some(target) = test_target() else {
        return;
    };
    let source = include_str!("../src/main.rs");
    let script = source
        .split_once("const SNAPSHOT: &str = r#\"")
        .unwrap()
        .1
        .split_once("\"#;")
        .unwrap()
        .0;
    let output = run(&target, script, RunOpts::default())
        .await
        .unwrap_or_else(|error| panic!("system snapshot failed: {:?}", error.kind));
    let section = |name: &str| {
        output
            .lines()
            .skip_while(|line| *line != name)
            .skip(1)
            .take_while(|line| !line.starts_with('@'))
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
    };
    assert!(output.lines().any(|line| line == "@temps"));
    assert!(output.lines().any(|line| line == "@groups"));
    let groups = section("@groups");
    assert!(!groups.is_empty(), "group membership unavailable");
    assert!(groups
        .join(" ")
        .split_whitespace()
        .all(|group| { !group.is_empty() && !group.chars().any(char::is_control) }));
    let temps = section("@temps");
    // Empty is valid on hosts without sensors; any reported thermal zones must be numeric.
    if temps
        .first()
        .is_some_and(|line| line.trim().starts_with('{'))
    {
        // lm-sensors may print the JSON on one line or many; parse it as a whole.
        let json: serde_json::Value = serde_json::from_str(&temps.join(
            "
",
        ))
        .expect("valid sensors JSON");
        let mut readings = 0;
        for feature in json
            .as_object()
            .unwrap()
            .values()
            .filter_map(|chip| chip.as_object())
        {
            for reading in feature.values().filter_map(|r| r.as_object()) {
                for (key, value) in reading {
                    if key.starts_with("temp") && key.ends_with("_input") {
                        let celsius = value.as_f64().expect("numeric sensor reading");
                        assert!(
                            (-50.0..=150.0).contains(&celsius),
                            "implausible temperature"
                        );
                        readings += 1;
                    }
                }
            }
        }
        assert!(readings > 0, "sensors JSON without temperature readings");
    } else {
        assert_eq!(temps.len() % 2, 0, "incomplete thermal zone pair");
        for pair in temps.chunks_exact(2) {
            let value: f64 = pair[1].parse().expect("non-numeric thermal zone");
            assert!(
                (-273150.0..=500000.0).contains(&value),
                "implausible temperature"
            );
        }
    }
}
