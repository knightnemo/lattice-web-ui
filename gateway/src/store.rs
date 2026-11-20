//! Paired devices and pending invites.
//!
//! The registry keeps only a SHA-256 digest of each device credential, in a
//! private file that is replaced atomically. Invites live in memory: a restart
//! invalidates the unused ones, which is the safe direction.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const INVITE_TTL: Duration = Duration::from_secs(120);
pub const DEVICE_TTL_SECS: u64 = 90 * 24 * 60 * 60;
const MAX_DEVICES: usize = 32;
const MAX_INVITES: usize = 16;
const REGISTRY: &str = "devices.json";

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).expect("the OS random source is unavailable");
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Compare secrets without an early exit on the first differing byte.
pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn valid_label(label: &str) -> bool {
    let trimmed = label.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= 48 && !trimmed.chars().any(char::is_control)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub last_seen_at: u64,
    pub credential_digest: String,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    InvalidInvite,
    InvalidLabel,
    TooMany,
    Storage(String),
}

struct Inner {
    devices: Vec<Device>,
    invites: HashMap<String, Instant>,
    dirty_seen: bool,
}

pub struct Store {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl Store {
    pub fn open(state_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(state_dir).map_err(|e| format!("{}: {e}", state_dir.display()))?;
        fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{}: {e}", state_dir.display()))?;
        let path = state_dir.join(REGISTRY);
        let devices = match fs::symlink_metadata(&path) {
            Ok(meta) => {
                if !meta.is_file()
                    || meta.permissions().mode() & 0o077 != 0
                    || meta.len() > 256 * 1024
                {
                    return Err(format!(
                        "{} must be a private regular file (mode 0600).",
                        path.display()
                    ));
                }
                let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                let devices: Vec<Device> = serde_json::from_slice(&bytes)
                    .map_err(|_| format!("{} is not a device registry.", path.display()))?;
                if devices.len() > MAX_DEVICES
                    || devices
                        .iter()
                        .any(|d| d.credential_digest.len() != 64 || !valid_label(&d.label))
                {
                    return Err(format!("{} has invalid records.", path.display()));
                }
                devices
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self {
            path,
            inner: Mutex::new(Inner {
                devices,
                invites: HashMap::new(),
                dirty_seen: false,
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, devices: &[Device]) -> Result<(), StoreError> {
        let temp = self.path.with_extension(format!("tmp-{}", random_hex(4)));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)?;
            file.write_all(&serde_json::to_vec_pretty(devices).expect("devices serialize"))?;
            file.sync_all()?;
            fs::rename(&temp, &self.path)
        })();
        result.map_err(|e| {
            let _ = fs::remove_file(&temp);
            StoreError::Storage(e.to_string())
        })
    }

    /// Create a single-use invite code that expires after [`INVITE_TTL`].
    pub fn create_invite(&self) -> Result<String, StoreError> {
        let mut inner = self.lock();
        inner
            .invites
            .retain(|_, created| created.elapsed() < INVITE_TTL);
        if inner.invites.len() >= MAX_INVITES {
            return Err(StoreError::TooMany);
        }
        let code = random_hex(24);
        inner.invites.insert(digest(&code), Instant::now());
        Ok(code)
    }

    /// Consume an invite and register a device. Returns the device and its
    /// credential, which only the browser keeps.
    pub fn redeem(&self, code: &str, label: &str) -> Result<(Device, String), StoreError> {
        if !valid_label(label) {
            return Err(StoreError::InvalidLabel);
        }
        let mut inner = self.lock();
        let key = digest(code);
        let fresh = inner
            .invites
            .remove(&key)
            .is_some_and(|created| created.elapsed() < INVITE_TTL);
        if !fresh {
            return Err(StoreError::InvalidInvite);
        }
        let now = now();
        inner.devices.retain(|d| d.expires_at > now);
        if inner.devices.len() >= MAX_DEVICES {
            return Err(StoreError::TooMany);
        }
        let credential = random_hex(32);
        let device = Device {
            id: random_hex(16),
            label: label.trim().to_string(),
            created_at: now,
            expires_at: now + DEVICE_TTL_SECS,
            last_seen_at: now,
            credential_digest: digest(&credential),
        };
        let mut next = inner.devices.clone();
        next.push(device.clone());
        self.save(&next)?;
        inner.devices = next;
        Ok((device, credential))
    }

    /// The device a credential belongs to, if it is still valid.
    pub fn authenticate(&self, credential: &str) -> Option<Device> {
        if credential.len() != 64 || !credential.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let wanted = digest(credential);
        let now = now();
        let mut inner = self.lock();
        let index = inner.devices.iter().position(|d| {
            d.expires_at > now && constant_eq(d.credential_digest.as_bytes(), wanted.as_bytes())
        })?;
        if now.saturating_sub(inner.devices[index].last_seen_at) > 60 {
            inner.devices[index].last_seen_at = now;
            inner.dirty_seen = true;
        }
        Some(inner.devices[index].clone())
    }

    /// Persist last-seen times at most as often as the caller asks.
    pub fn flush_seen(&self) {
        let mut inner = self.lock();
        if inner.dirty_seen {
            inner.dirty_seen = false;
            let devices = inner.devices.clone();
            drop(inner);
            let _ = self.save(&devices);
        }
    }

    pub fn list(&self) -> Vec<Device> {
        let now = now();
        let inner = self.lock();
        inner
            .devices
            .iter()
            .filter(|d| d.expires_at > now)
            .cloned()
            .collect()
    }

    pub fn revoke(&self, id: &str) -> Result<bool, StoreError> {
        let mut inner = self.lock();
        let before = inner.devices.len();
        let next: Vec<Device> = inner
            .devices
            .iter()
            .filter(|d| d.id != id)
            .cloned()
            .collect();
        if next.len() == before {
            return Ok(false);
        }
        self.save(&next)?;
        inner.devices = next;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lattice-gateway-test-{}", random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn invite_is_single_use_and_pairs_a_device() {
        let dir = temp_dir();
        let store = Store::open(&dir).unwrap();
        let code = store.create_invite().unwrap();
        let (device, credential) = store.redeem(&code, "Phone").unwrap();
        assert_eq!(store.redeem(&code, "Again"), Err(StoreError::InvalidInvite));
        assert_eq!(store.authenticate(&credential).unwrap().id, device.id);
        assert!(store.authenticate(&random_hex(32)).is_none());
        let mode = fs::metadata(dir.join(REGISTRY))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        // The registry survives a restart; the credential itself is not stored.
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.authenticate(&credential).unwrap().label, "Phone");
        assert!(!fs::read_to_string(dir.join(REGISTRY))
            .unwrap()
            .contains(&credential));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn revoke_removes_access() {
        let dir = temp_dir();
        let store = Store::open(&dir).unwrap();
        let code = store.create_invite().unwrap();
        let (device, credential) = store.redeem(&code, "Laptop").unwrap();
        assert!(store.revoke(&device.id).unwrap());
        assert!(store.authenticate(&credential).is_none());
        assert!(!store.revoke(&device.id).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_bad_labels_and_world_readable_registry() {
        let dir = temp_dir();
        let store = Store::open(&dir).unwrap();
        let code = store.create_invite().unwrap();
        assert!(matches!(
            store.redeem(&code, "  "),
            Err(StoreError::InvalidLabel)
        ));
        fs::write(dir.join(REGISTRY), "[]").unwrap();
        fs::set_permissions(dir.join(REGISTRY), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Store::open(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
