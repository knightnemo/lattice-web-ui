use crate::{
    browser_session_routes::{create_browser_session, session_response},
    project_fs::ProjectDir,
    server_session::{browser_authenticated, cookie, failure, same_origin, session_id},
    transport::Server,
};
use axum::{
    extract::{DefaultBodyLimit, Path as RoutePath, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use qrcode::{Color, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const REGISTRY: &str = "paired-devices.json";
pub(crate) const COOKIE: &str = "__Host-lattice_device";
const INVITE_SECONDS: u64 = 120;
const DEVICE_SECONDS: u64 = 90 * 24 * 60 * 60;
const MAX_INVITES: usize = 16;
const MAX_DEVICES: usize = 32;

pub(crate) fn validate_paths(
    workspace: &Path, state: &Path, token: &Path, assets: Option<&Path>,
) -> Result<(), String> {
    let parent =
        token.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let asset_dir =
        assets.map(Path::canonicalize).transpose().map_err(|error| error.to_string())?;
    if parent.starts_with(workspace)
        || asset_dir.is_some_and(|root| parent.starts_with(&root) || state.starts_with(&root))
    {
        return Err("Keep pairing state and credentials outside served files.".into());
    }
    Ok(())
}

fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn valid_secret(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|ch| ch.is_ascii_hexdigit())
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn unix_time() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    label: String,
    expires_at: u64,
    #[serde(rename = "credentialDigest")]
    credential_digest: String,
}

#[derive(Default)]
struct Registry {
    devices: Vec<Device>,
    invites: HashMap<String, Instant>,
}

pub(crate) struct Pairing {
    directory: ProjectDir,
    directory_fd: File,
    _service_lock: File,
    registry: Mutex<Registry>,
    admission_failures: Mutex<(Instant, u32)>,
}

impl Pairing {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let directory = ProjectDir::open_nofollow(path)?;
        let directory_fd = File::open(path).map_err(|error| error.to_string())?;
        let service_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path.join("paired-devices.lock"))
            .map_err(|error| error.to_string())?;
        let metadata = service_lock.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err("Invalid paired-device lock file.".into());
        }
        rustix::fs::flock(&service_lock, rustix::fs::FlockOperation::NonBlockingLockExclusive)
            .map_err(|error| {
                format!("Could not exclusively lock the paired-device store: {error}")
            })?;
        let devices = match path.join(REGISTRY).symlink_metadata() {
            Ok(_) => {
                let file = directory.metadata_file(REGISTRY)?;
                let metadata = file.metadata().map_err(|error| error.to_string())?;
                if !metadata.is_file()
                    || metadata.permissions().mode() & 0o077 != 0
                    || metadata.len() > 65536
                {
                    return Err("Invalid paired-device registry.".into());
                }
                let mut bytes = Vec::new();
                file.take(65537).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
                let devices: Vec<Device> = serde_json::from_slice(&bytes)
                    .map_err(|_| "Unreadable paired-device registry.")?;
                if devices.len() > MAX_DEVICES
                    || devices.iter().any(|entry| {
                        !valid_secret(&entry.credential_digest)
                            || Uuid::parse_str(&entry.id).is_err()
                            || !valid_label(&entry.label)
                    })
                {
                    return Err("Invalid paired-device registry records.".into());
                }
                devices
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            directory,
            directory_fd,
            _service_lock: service_lock,
            registry: Mutex::new(Registry { devices, invites: HashMap::new() }),
            admission_failures: Mutex::new((Instant::now(), 0)),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap()
    }

    fn save(&self, devices: &[Device]) -> Result<(), Response> {
        let bytes = serde_json::to_vec(devices).map_err(|_| storage_error())?;
        self.directory.atomic_write(REGISTRY, &bytes).map_err(|_| storage_error())?;
        self.directory_fd.sync_all().map_err(|_| storage_error())
    }

    /// Bound repeated rejected attempts without locking the owner or a valid device out.
    pub(crate) fn failed_admission(&self, denial: Response) -> Response {
        let mut failures = self.admission_failures.lock().unwrap();
        let elapsed = failures.0.elapsed().as_secs();
        if elapsed >= 60 {
            *failures = (Instant::now(), 1);
        } else if failures.1 >= 30 {
            let mut response = failure(
                StatusCode::TOO_MANY_REQUESTS,
                "admission_limited",
                "Too many unsuccessful sign-in attempts.",
            );
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&(60 - elapsed).to_string()).unwrap(),
            );
            return response;
        } else {
            failures.1 += 1;
        }
        denial
    }
}

fn storage_error() -> Response {
    failure(StatusCode::SERVICE_UNAVAILABLE, "pairing_storage", "Could not save paired devices.")
}

fn invalid_invite() -> Response {
    failure(
        StatusCode::UNAUTHORIZED,
        "invalid_invite",
        "This pairing link has expired or was already used.",
    )
}

fn limit() -> Response {
    failure(
        StatusCode::TOO_MANY_REQUESTS,
        "pairing_limit",
        "Too many paired devices or pending invitations.",
    )
}

fn valid_label(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 64 && !value.chars().any(char::is_control)
}

fn device_cookie(value: &str, seconds: u64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE}={value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={seconds}"
    ))
    .unwrap()
}

pub(crate) fn clear_device_cookie(response: &mut Response) {
    response.headers_mut().append(header::SET_COOKIE, device_cookie("", 0));
}

pub(crate) fn can_manage_devices(state: &Server, headers: &HeaderMap) -> bool {
    state.pairing.is_some()
        && session_id(headers).is_some_and(|id| {
            state.sessions.lock().unwrap().get(&id).is_some_and(|session| {
                session.device_id.is_none() && session.expires > Instant::now()
            })
        })
}

fn owner(state: &Server, headers: &HeaderMap) -> Result<(), Response> {
    if !same_origin(state, headers) || !can_manage_devices(state, headers) {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "owner_required",
            "Only the workspace owner can manage devices.",
        ));
    }
    Ok(())
}

pub(crate) fn mutation_origin(state: &Server, headers: &HeaderMap) -> Result<(), Response> {
    if headers.get(header::ORIGIN).and_then(|value| value.to_str().ok())
        != Some(state.public_origin.as_str())
    {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "origin_forbidden",
            "Open the workspace directly to pair.",
        ));
    }
    Ok(())
}

fn no_store(value: serde_json::Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

async fn invite(State(state): State<Server>, headers: HeaderMap) -> Result<Response, Response> {
    mutation_origin(&state, &headers)?;
    owner(&state, &headers)?;
    let pairing = state.pairing.as_ref().unwrap();
    let mut registry = pairing.lock();
    registry.invites.retain(|_, expiry| *expiry > Instant::now());
    if registry.invites.len() >= MAX_INVITES {
        return Err(limit());
    }
    let code = secret();
    let url = format!("{}/#pair={code}", state.public_origin);
    let qr = QrCode::new(&url).map_err(|_| storage_error())?;
    let width = qr.width();
    let matrix = qr
        .into_colors()
        .chunks(width)
        .map(|row| {
            row.iter()
                .map(|pixel| if *pixel == Color::Dark { '1' } else { '0' })
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    registry.invites.insert(digest(&code), Instant::now() + Duration::from_secs(INVITE_SECONDS));
    Ok(no_store(json!({"url":url,"qr":matrix,"expiresIn":INVITE_SECONDS})))
}

#[derive(Deserialize)]
struct Redemption {
    code: String,
    label: String,
}

async fn redeem(
    State(state): State<Server>, headers: HeaderMap, Json(payload): Json<Redemption>,
) -> Result<Response, Response> {
    mutation_origin(&state, &headers)?;
    let pairing = state.pairing.as_ref().unwrap();
    let label = payload.label.trim();
    if !valid_label(label) || !valid_secret(&payload.code) {
        return Err(pairing.failed_admission(invalid_invite()));
    }
    let mut registry = pairing.lock();
    let hash = digest(&payload.code);
    if !registry.invites.get(&hash).is_some_and(|expiry| *expiry > Instant::now()) {
        return Err(pairing.failed_admission(invalid_invite()));
    }
    let now = unix_time();
    let mut devices = registry
        .devices
        .iter()
        .filter(|device| device.expires_at > now)
        .cloned()
        .collect::<Vec<_>>();
    if devices.len() >= MAX_DEVICES {
        return Err(limit());
    }
    let credential = secret();
    let id = Uuid::new_v4().simple().to_string();
    devices.push(Device {
        id,
        label: label.into(),
        expires_at: now + DEVICE_SECONDS,
        credential_digest: digest(&credential),
    });
    pairing.save(&devices)?;
    registry.invites.remove(&hash);
    registry.devices = devices;
    let mut response = no_store(json!({"paired":true}));
    response.headers_mut().append(header::SET_COOKIE, device_cookie(&credential, DEVICE_SECONDS));
    Ok(response)
}

async fn resume(State(state): State<Server>, headers: HeaderMap) -> Result<Response, Response> {
    mutation_origin(&state, &headers)?;
    let pairing = state.pairing.as_ref().unwrap();
    let credential = cookie(&headers, COOKIE)
        .filter(|value| valid_secret(value))
        .ok_or_else(|| pairing.failed_admission(invalid_invite()))?;
    let registry = pairing.lock();
    let hash = digest(credential);
    let now = unix_time();
    let device = registry
        .devices
        .iter()
        .find(|device| device.credential_digest == hash && device.expires_at > now)
        .ok_or_else(|| pairing.failed_admission(invalid_invite()))?;
    if browser_authenticated(&state, &headers)
        && session_id(&headers).is_some_and(|id| {
            state
                .sessions
                .lock()
                .unwrap()
                .get(&id)
                .is_some_and(|session| session.device_id.as_deref() == Some(&device.id))
        })
    {
        return Ok(session_response(&state, true, false));
    }
    Ok(create_browser_session(&state, Some((device.id.clone(), device.expires_at - now))))
}

async fn list(State(state): State<Server>, headers: HeaderMap) -> Result<Response, Response> {
    owner(&state, &headers)?;
    let registry = state.pairing.as_ref().unwrap().lock();
    let now = unix_time();
    let devices = registry
        .devices
        .iter()
        .filter(|device| device.expires_at > now)
        .map(|device| json!({"id":device.id,"label":device.label,"expiresAt":device.expires_at}))
        .collect::<Vec<_>>();
    Ok(no_store(json!({"devices":devices})))
}

async fn revoke(
    State(state): State<Server>, headers: HeaderMap, RoutePath(id): RoutePath<String>,
) -> Result<Response, Response> {
    mutation_origin(&state, &headers)?;
    owner(&state, &headers)?;
    let pairing = state.pairing.as_ref().unwrap();
    let mut registry = pairing.lock();
    let devices =
        registry.devices.iter().filter(|device| device.id != id).cloned().collect::<Vec<_>>();
    if devices.len() != registry.devices.len() {
        pairing.save(&devices)?;
        registry.devices = devices;
    }
    let mut removed = Vec::new();
    state.sessions.lock().unwrap().retain(|session_id, session| {
        if session.device_id.as_deref() == Some(&id) {
            removed.push(session_id.clone());
            return false;
        }
        true
    });
    drop(registry);
    for session in removed {
        state.terminals.close_session(&session);
        state.agents.close_session(&session);
    }
    Ok(no_store(json!({"revoked":true})))
}

pub(crate) fn routes() -> Router<Server> {
    Router::new()
        .route("/api/devices", get(list))
        .route("/api/devices/{id}/revoke", post(revoke))
        .route("/api/devices/invites", post(invite))
        .route("/api/devices/pair", post(redeem))
        .route("/api/devices/resume", post(resume))
        .layer(DefaultBodyLimit::max(1024))
}
