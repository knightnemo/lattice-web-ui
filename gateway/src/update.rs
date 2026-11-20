//! The owner's update prompt: what lattice-host found, and the owner's answer.
//!
//! lattice-host does the work and the gateway only passes messages, through
//! files in one directory:
//!
//! - `available.json`: written by `lattice-host check-update` (a timer), the
//!   newest stable release and the Lattice version it brings.
//! - `status.json`: written by `lattice-host self-update` while it runs.
//! - `request`: written here when the owner selects Update. A systemd path
//!   unit starts `lattice-host self-update` when it appears, so the update runs
//!   outside the gateway, which it restarts.
//! - `dismissed`: written here when the owner selects Later, the version
//!   whose prompt stays hidden.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A running update that has said nothing for this long has died.
const STALE_SECONDS: u64 = 15 * 60;

pub struct Updates {
    dir: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The version asked for is not the newest stable release, or not newer.
    NotOffered,
    /// An update is already under way.
    Running,
    Io(String),
}

impl Updates {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn read_json(&self, name: &str) -> Option<Value> {
        let text = fs::read_to_string(self.dir.join(name)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn latest(&self) -> Option<Value> {
        self.read_json("available.json").filter(|v| {
            v.get("latest")
                .and_then(Value::as_str)
                .is_some_and(valid_version)
        })
    }

    fn running(&self) -> bool {
        let Some(status) = self.read_json("status.json") else {
            return self.dir.join("request").exists();
        };
        let phase = status.get("phase").and_then(Value::as_str).unwrap_or("");
        let at = status.get("at").and_then(Value::as_u64).unwrap_or(0);
        !matches!(phase, "done" | "failed") && now().saturating_sub(at) < STALE_SECONDS
    }

    /// What the owner's page shows.
    pub fn state(&self, current: &str) -> Value {
        let available = self.latest();
        let latest = available
            .as_ref()
            .and_then(|v| v.get("latest"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let newer = latest.as_deref().is_some_and(|l| is_newer(l, current));
        let dismissed = fs::read_to_string(self.dir.join("dismissed"))
            .ok()
            .map(|s| s.trim().to_string());
        json!({
            "current": current,
            "latest": latest,
            "available": newer,
            "dismissed": newer && dismissed.is_some() && dismissed == latest,
            "lattice": available.as_ref().and_then(|v| v.get("lattice")).cloned(),
            "running": self.running(),
            "status": self.read_json("status.json"),
        })
    }

    /// Ask lattice-host to update to `version`, the newest stable release.
    pub fn request(&self, version: &str, current: &str) -> Result<(), Refusal> {
        let latest = self
            .latest()
            .and_then(|v| v.get("latest").and_then(Value::as_str).map(str::to_string));
        if latest.as_deref() != Some(version) || !is_newer(version, current) {
            return Err(Refusal::NotOffered);
        }
        if self.running() {
            return Err(Refusal::Running);
        }
        // A finished run's status would read as this run's until it starts.
        let _ = fs::remove_file(self.dir.join("status.json"));
        write_private(&self.dir.join("request"), version).map_err(Refusal::Io)
    }

    /// Hide the prompt for `version` until a newer one comes out.
    pub fn dismiss(&self, version: &str) -> Result<(), Refusal> {
        if !valid_version(version) {
            return Err(Refusal::NotOffered);
        }
        write_private(&self.dir.join("dismissed"), version).map_err(Refusal::Io)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

/// `major.minor.patch`, digits only.
pub fn valid_version(version: &str) -> bool {
    parse(version).is_some()
}

fn parse(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let mut out = [0; 3];
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 6 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lattice-update-{}", crate::store::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.8.3", "0.8.3"));
        assert!(!is_newer("0.8.2", "0.8.3"));
        for bad in [
            "0.8",
            "0.8.3.1",
            "v0.8.3",
            "0.8.x",
            "",
            "0..1",
            "0.8.3-beta",
        ] {
            assert!(!valid_version(bad), "{bad}");
            assert!(!is_newer(bad, "0.0.1"), "{bad}");
        }
    }

    #[test]
    fn the_prompt_follows_what_lattice_host_found() {
        let dir = dir();
        let updates = Updates::new(dir.clone());
        // Nothing checked yet.
        assert_eq!(updates.state("0.8.3")["available"], false);
        assert_eq!(updates.request("0.9.0", "0.8.3"), Err(Refusal::NotOffered));

        fs::write(
            dir.join("available.json"),
            r#"{"latest":"0.9.0","tag":"v0.9.0","lattice":{"current":"0.19.0","latest":"0.20.0"}}"#,
        )
        .unwrap();
        let state = updates.state("0.8.3");
        assert_eq!(state["available"], true);
        assert_eq!(state["dismissed"], false);
        assert_eq!(state["lattice"]["latest"], "0.20.0");
        // Already there: nothing to offer.
        assert_eq!(updates.state("0.9.0")["available"], false);

        updates.dismiss("0.9.0").unwrap();
        assert_eq!(updates.state("0.8.3")["dismissed"], true);

        // Only the offered version, and only one run at a time.
        assert_eq!(updates.request("0.9.1", "0.8.3"), Err(Refusal::NotOffered));
        assert_eq!(updates.request("0.9.0", "0.9.0"), Err(Refusal::NotOffered));
        updates.request("0.9.0", "0.8.3").unwrap();
        assert_eq!(fs::read_to_string(dir.join("request")).unwrap(), "0.9.0");
        assert_eq!(updates.state("0.8.3")["running"], true);
        assert_eq!(updates.request("0.9.0", "0.8.3"), Err(Refusal::Running));

        // A finished run allows another; a silent one is given up on.
        fs::remove_file(dir.join("request")).unwrap();
        fs::write(
            dir.join("status.json"),
            format!(r#"{{"phase":"failed","at":{}}}"#, now()),
        )
        .unwrap();
        assert_eq!(updates.state("0.8.3")["running"], false);
        fs::write(
            dir.join("status.json"),
            format!(
                r#"{{"phase":"downloading","at":{}}}"#,
                now() - STALE_SECONDS - 1
            ),
        )
        .unwrap();
        assert_eq!(updates.state("0.8.3")["running"], false);
        fs::write(
            dir.join("status.json"),
            format!(r#"{{"phase":"downloading","at":{}}}"#, now()),
        )
        .unwrap();
        assert_eq!(updates.request("0.9.0", "0.8.3"), Err(Refusal::Running));
    }
}
