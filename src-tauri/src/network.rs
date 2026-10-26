use crate::contracts::{AppError, Target};
use crate::transport::{self, RunOpts};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

// Failed tools emit a sentinel so a successful empty result remains distinguishable.
const SCRIPT: &str = r#"
export LC_ALL=C
echo @addr
ip -j addr 2>/dev/null || echo '!unavailable'
echo @route4
ip -j route 2>/dev/null || echo '!unavailable'
echo @route6
ip -j -6 route 2>/dev/null || echo '!unavailable'
echo @ports
ss -tulnpH 2>/dev/null || echo '!unavailable'
echo @ufw
if command -v ufw >/dev/null 2>&1; then systemctl is-active ufw.service 2>/dev/null || true; fi
echo @nftables
if command -v nft >/dev/null 2>&1; then systemctl is-active nftables.service 2>/dev/null || true; fi
echo @firewalld
if command -v firewall-cmd >/dev/null 2>&1; then systemctl is-active firewalld.service 2>/dev/null || true; fi
echo @firewalldState
firewall-cmd --state 2>/dev/null || true
echo @tailscale
tailscale status --json 2>/dev/null || echo '!unavailable'
true
"#;

#[derive(Debug, Serialize)]
pub struct Port {
    protocol: String,
    state: String,
    local: String,
    peer: String,
    process: String,
}

#[derive(Debug, Serialize)]
pub struct NetworkRead {
    pub interfaces: Option<Value>,
    pub routes4: Option<Value>,
    pub routes6: Option<Value>,
    pub ports: Option<Vec<Port>>,
    pub firewall: BTreeMap<String, Option<String>>,
    pub tailscale: Option<Value>,
}

#[tauri::command]
pub async fn network_read(
    target: Target,
    operation_id: Option<String>,
) -> Result<NetworkRead, AppError> {
    let output = transport::run(
        &target,
        SCRIPT,
        RunOpts {
            operation_id,
            ..Default::default()
        },
    )
    .await
    // SSH may fail after collecting stdout; never expose raw Tailscale JSON in an error.
    .map_err(|error| {
        AppError::new(
            error.kind,
            "Network inspection failed; check the SSH connection and try again.",
        )
    })?;
    Ok(parse_sections(&output))
}

fn node(value: &Value, peer: bool) -> Option<Value> {
    let source = value.as_object()?;
    // HostName is required; never pass nested values through even under allowed keys.
    source.get("HostName")?.as_str()?;
    let mut result = Map::new();
    for key in ["HostName", "OS", "LastSeen"] {
        if key == "LastSeen" && !peer {
            continue;
        }
        if let Some(value) = source.get(key).and_then(Value::as_str) {
            result.insert(key.into(), Value::String(value.into()));
        }
    }
    if let Some(value) = source.get("Online").and_then(Value::as_bool) {
        result.insert("Online".into(), Value::Bool(value));
    }
    if let Some(ips) = source.get("TailscaleIPs").and_then(Value::as_array) {
        result.insert(
            "TailscaleIPs".into(),
            Value::Array(
                ips.iter()
                    .filter_map(Value::as_str)
                    .map(|ip| Value::String(ip.into()))
                    .collect(),
            ),
        );
    }
    Some(Value::Object(result))
}

fn redact_tailscale(raw: &Value) -> Option<Value> {
    if raw
        .get("BackendState")
        .and_then(Value::as_str)
        .is_some_and(|state| state != "Running")
    {
        return None;
    }
    let own = node(raw.get("Self")?, false)?;
    let peers: Vec<_> = raw
        .get("Peer")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|peers| peers.values())
        .filter_map(|peer| node(peer, true))
        .collect();
    Some(serde_json::json!({"Self": own, "peers": peers}))
}

fn parse_sections(output: &str) -> NetworkRead {
    let mut sections: BTreeMap<&str, String> = BTreeMap::new();
    let mut current = None;
    for line in output.lines() {
        if let Some(key) = line.strip_prefix('@') {
            current = Some(key);
            sections.insert(key, String::new());
        } else if let Some(key) = current {
            let section = sections.get_mut(key).expect("section exists");
            section.push_str(line);
            section.push('\n');
        }
    }
    let array = |key| {
        sections
            .get(key)
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .filter(Value::is_array)
    };
    let ports = sections.get("ports").and_then(|text| {
        let mut ports = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 6 || !["tcp", "udp"].contains(&fields[0]) {
                return None;
            }
            ports.push(Port {
                protocol: fields[0].into(),
                state: fields[1].into(),
                local: fields[4].into(),
                peer: fields[5].into(),
                process: fields[6..].join(" "),
            });
        }
        Some(ports)
    });
    let firewall = ["ufw", "nftables", "firewalld", "firewalldState"]
        .into_iter()
        .map(|key| {
            let state = sections
                .get(key)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(String::from);
            (key.into(), state)
        })
        .collect();
    let tailscale = sections
        .get("tailscale")
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|raw| redact_tailscale(&raw));
    NetworkRead {
        interfaces: array("addr"),
        routes4: array("route4"),
        routes6: array("route6"),
        ports,
        firewall,
        tailscale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tailscale_is_an_allowlist_with_typed_fields() {
        let raw = json!({"PrivateKey":"secret", "Self":{"HostName":"self", "TailscaleIPs":["100.64.0.1", {"Key":"secret"}], "Online":true,"OS":"linux","LastSeen":"omit", "PublicKey":"secret","Capabilities":["secret"]}, "Peer":{"secret-id":{"HostName":"peer","TailscaleIPs":["fd7a::1"],"Online":false,"OS":"linux","LastSeen":"yesterday","Token":"secret"}}});
        let safe = redact_tailscale(&raw).unwrap();
        assert_eq!(
            safe,
            json!({"Self":{"HostName":"self","TailscaleIPs":["100.64.0.1"],"Online":true,"OS":"linux"},"peers":[{"HostName":"peer","TailscaleIPs":["fd7a::1"],"Online":false,"OS":"linux","LastSeen":"yesterday"}]})
        );
        assert!(!safe.to_string().contains("secret"));
        let mut stopped = raw;
        stopped["BackendState"] = json!("Stopped");
        assert!(redact_tailscale(&stopped).is_none());
    }

    #[test]
    fn sections_are_independent_and_defensive() {
        let data = parse_sections("banner\n@addr\n[{\"ifname\":\"lo\"}]\n@route4\nnot json\n@route6\n[{\"dst\":\"default\"}]\n@ports\ntcp LISTEN 0 128 [::]:22 [::]:* users:((\"sshd\",pid=1,fd=3))\n@ufw\ninactive\n@tailscale\n{\"BackendState\":\"Stopped\"}\n");
        assert!(data.interfaces.unwrap().is_array());
        assert!(data.routes4.is_none());
        assert_eq!(data.routes6.unwrap()[0]["dst"], "default");
        assert_eq!(data.ports.unwrap()[0].local, "[::]:22");
        assert_eq!(data.firewall["ufw"], Some("inactive".into()));
        assert!(data.tailscale.is_none());
    }

    #[test]
    fn unavailable_empty_and_wrong_shapes() {
        let data = parse_sections("@addr\n{}\n@route4\n[]\n@ports\n\n@tailscale\n{broken\n");
        assert!(data.interfaces.is_none());
        assert_eq!(data.routes4, Some(json!([])));
        assert!(data.ports.unwrap().is_empty());
        assert!(data.tailscale.is_none());
        assert!(parse_sections("@ports\n!unavailable\n").ports.is_none());
        assert!(
            redact_tailscale(&json!({"Self":{"HostName":{"Key":"secret"}},"Peer":[]})).is_none()
        );
    }
}
