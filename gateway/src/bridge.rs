//! Make Lattice's browser-host page work from a public origin, until Lattice
//! supports one itself (leo1oel/lattice#1190).
//!
//! The page refuses to start anywhere but `http://127.0.0.1:18452`, and it
//! builds its session, asset and bridge URLs from that address. The gateway
//! rewrites exactly those expressions in the JavaScript it forwards, and
//! counts each rewrite so that `lattice-host` can check them against the
//! counts pinned for each Lattice release. Lattice itself is not changed.

use regex::Regex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

pub struct Rule {
    pub name: &'static str,
    pattern: &'static str,
    replacement: &'static str,
}

/// The rewrites, in the order they are applied. Each pattern matches a whole
/// expression of the minified bundle, never a fragment of another one.
pub const RULES: &[Rule] = &[
    // `http://127.0.0.1:${port}` inside a template literal: session, asset and reachability URLs.
    Rule {
        name: "http",
        pattern: r"http://127\.0\.0\.1:\$\{[^}`]+\}",
        replacement: "${location.origin}",
    },
    // `ws://127.0.0.1:${port}`: the bridge WebSocket, wss: under https.
    Rule {
        name: "ws",
        pattern: r"ws://127\.0\.0\.1:\$\{[^}`]+\}",
        replacement: r#"${location.protocol==="https:"?"wss:":"ws:"}//${location.host}"#,
    },
    // The loopback-only start check and the fixed-entry check.
    Rule {
        name: "protocol",
        pattern: r"window\.location\.protocol===`http:`",
        replacement: "!0",
    },
    Rule {
        name: "hostname",
        pattern: r"window\.location\.hostname===`127\.0\.0\.1`",
        replacement: "!0",
    },
    Rule {
        name: "port",
        pattern: r"window\.location\.port===[A-Za-z_$][\w$]*",
        replacement: "!0",
    },
];

fn compiled() -> &'static Vec<Regex> {
    static COMPILED: OnceLock<Vec<Regex>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        RULES
            .iter()
            .map(|rule| Regex::new(rule.pattern).expect("rule pattern compiles"))
            .collect()
    })
}

#[derive(Default)]
pub struct Counters([AtomicU64; 5]);

impl Counters {
    pub fn snapshot(&self) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        for (rule, counter) in RULES.iter().zip(&self.0) {
            map.insert(rule.name.into(), counter.load(Ordering::Relaxed).into());
        }
        serde_json::Value::Object(map)
    }
}

/// Rewrite one JavaScript file. Returns the new text and per-rule counts.
pub fn rewrite_js(source: &str) -> (String, [u64; 5]) {
    let mut text = source.to_string();
    let mut counts = [0u64; 5];
    for (index, (rule, regex)) in RULES.iter().zip(compiled()).enumerate() {
        let found = regex.find_iter(&text).count() as u64;
        if found > 0 {
            counts[index] = found;
            text = regex
                .replace_all(&text, regex::NoExpand(rule.replacement))
                .into_owned();
        }
    }
    (text, counts)
}

pub fn record(counters: &Counters, counts: [u64; 5]) {
    for (counter, count) in counters.0.iter().zip(counts) {
        counter.fetch_add(count, Ordering::Relaxed);
    }
}

/// Load the gateway's page script before Lattice's own scripts.
pub fn inject_html(html: &str) -> Option<String> {
    let tag = r#"<script src="/__gateway/bridge.js"></script>"#;
    let at = html.find("<head>").map(|i| i + "<head>".len())?;
    let mut out = String::with_capacity(html.len() + tag.len());
    out.push_str(&html[..at]);
    out.push_str(tag);
    out.push_str(&html[at..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Excerpts of Lattice 0.18.0's built browser runtime and relay.
    const RUNTIME: &str = concat!(
        "let r=new URL(`http://127.0.0.1:${e}/__lattice_session`);",
        "n=window.location.hostname===`127.0.0.1`&&window.location.port===t,",
        "function $r(){return window.location.protocol===`http:`&&(window.location.hostname===`127.0.0.1`||window.location.hostname===`localhost`)}",
        "let t=new URL(`http://127.0.0.1:${Dr.bridgePort}/__lattice_asset`);",
    );
    const RELAY: &str = "let n=new URL(`ws://127.0.0.1:${e.bridgePort}/__lattice_bridge`);";

    #[test]
    fn rewrites_the_loopback_expressions_of_the_runtime() {
        let (text, counts) = rewrite_js(RUNTIME);
        assert_eq!(counts, [2, 0, 1, 2, 1]);
        assert!(text.contains("new URL(`${location.origin}/__lattice_session`)"));
        assert!(text.contains("n=!0&&!0,"));
        assert!(text.contains("return !0&&(!0||window.location.hostname===`localhost`)"));
        assert!(!text.contains("127.0.0.1"));
    }

    #[test]
    fn rewrites_the_bridge_socket_to_the_page_origin() {
        let (text, counts) = rewrite_js(RELAY);
        assert_eq!(counts, [0, 1, 0, 0, 0]);
        assert_eq!(
            text,
            r#"let n=new URL(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/__lattice_bridge`);"#
        );
    }

    #[test]
    fn leaves_other_code_alone() {
        let other = "fetch(`https://example.org/${x}`);if(a.port===b)c();";
        assert_eq!(rewrite_js(other), (other.to_string(), [0; 5]));
    }

    #[test]
    fn injects_the_page_script_first() {
        let html = "<!doctype html><html><head><script type=\"module\" src=\"/assets/app.js\"></script></head></html>";
        let out = inject_html(html).unwrap();
        assert!(out.starts_with("<!doctype html><html><head><script src=\"/__gateway/bridge.js\"></script><script type=\"module\""));
        assert!(inject_html("<html></html>").is_none());
    }
}
