//! Routes, sign-in and the two listeners.

use crate::proxy::{self, empty, full, Body, Bridge, Upstream};
use crate::store::{self, Store, StoreError};
use crate::Args;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::broadcast;

const OWNER_SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_FAILURES: u32 = 20;
const MAX_JSON: usize = 4096;

const PAGE_HTML: &str = include_str!("../assets/page.html");
const PAGE_CSS: &str = include_str!("../assets/gateway.css");
const PAGE_JS: &str = include_str!("../assets/gateway.js");
const BRIDGE_JS: &str = include_str!("../assets/bridge.js");
/// How long an address Lattice asked to open waits for a tab to claim it.
const OPEN_REQUEST_TTL: Duration = Duration::from_secs(60);
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Entrance {
    Public,
    Owner,
}

#[derive(Clone, Debug, PartialEq)]
enum Principal {
    Device { id: String, label: String },
    Owner,
}

impl Principal {
    fn name(&self) -> String {
        match self {
            Principal::Device { id, .. } => format!("device:{id}"),
            Principal::Owner => "owner".into(),
        }
    }
}

pub struct App {
    store: Store,
    upstream: Upstream,
    public_origin: String,
    owner_origin: Option<String>,
    owner_logins: Vec<String>,
    token: String,
    owner_sessions: Mutex<HashMap<String, Instant>>,
    failures: Mutex<(Instant, u32)>,
    revocations: broadcast::Sender<String>,
    device_cookie: &'static str,
    owner_cookie: &'static str,
    secure: bool,
    bridge: Bridge,
    open_requests: Option<std::path::PathBuf>,
    projects_root: Option<std::path::PathBuf>,
}

fn canonical_origin(value: &str, allow_http: bool) -> Result<String, String> {
    let ok_scheme = value.starts_with("https://") || (allow_http && value.starts_with("http://"));
    let rest = value.split_once("://").map(|(_, r)| r).unwrap_or("");
    if !ok_scheme
        || rest.is_empty()
        || rest.contains('/')
        || rest.contains('@')
        || value.ends_with(":443")
    {
        return Err(format!("{value:?} is not an origin like https://workspace.example.ts.net (no path, no default port)."));
    }
    Ok(value.to_ascii_lowercase())
}

fn read_or_create_token(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let mode = fs::metadata(path)
                .map_err(|e| e.to_string())?
                .permissions()
                .mode();
            if mode & 0o077 != 0 {
                return Err(format!("{} must be private (chmod 600).", path.display()));
            }
            let token = text.trim().to_string();
            if token.len() < 32 {
                return Err(format!(
                    "{} holds a token shorter than 32 characters.",
                    path.display()
                ));
            }
            Ok(token)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let token = store::random_hex(32);
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            writeln!(file, "{token}").map_err(|e| e.to_string())?;
            Ok(token)
        }
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

impl App {
    pub fn new(args: &Args) -> Result<Self, String> {
        let public_origin = canonical_origin(&args.public_origin, args.insecure_dev_cookies)?;
        let owner_origin = args
            .owner_origin
            .as_deref()
            .map(|o| canonical_origin(o, args.insecure_dev_cookies))
            .transpose()?;
        if args.owner_socket.is_some() != owner_origin.is_some()
            || args.owner_socket.is_some() != args.owner_logins.is_some()
        {
            return Err("--owner-socket, --owner-origin and --owner-logins go together.".into());
        }
        if owner_origin.as_deref() == Some(public_origin.as_str()) {
            return Err("Give the owner page its own origin, separate from the public one.".into());
        }
        let owner_logins = match &args.owner_logins {
            Some(path) => fs::read_to_string(path)
                .map_err(|e| format!("{}: {e}", path.display()))?
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_string)
                .collect(),
            None => Vec::new(),
        };
        if args.owner_logins.is_some() && owner_logins.is_empty() {
            return Err("The owner logins file lists no login.".into());
        }
        let state_dir = &args.state_dir;
        if !args.upstream.ip().is_loopback() {
            return Err("--upstream must be a loopback address: Lattice's browser host has no authentication of its own.".into());
        }
        let token = read_or_create_token(&args.token_file)?;
        let (revocations, _) = broadcast::channel(64);
        let secure = !args.insecure_dev_cookies;
        Ok(Self {
            store: Store::open(state_dir)?,
            upstream: Upstream::new(args.upstream),
            public_origin,
            owner_origin,
            owner_logins,
            token,
            owner_sessions: Mutex::new(HashMap::new()),
            failures: Mutex::new((Instant::now(), 0)),
            revocations,
            device_cookie: if secure {
                "__Host-lattice_device"
            } else {
                "lattice_device"
            },
            owner_cookie: if secure {
                "__Host-lattice_owner"
            } else {
                "lattice_owner"
            },
            secure,
            bridge: Bridge {
                rewrite: args.rewrite_loopback_page,
                ..Bridge::default()
            },
            open_requests: args.open_requests.clone(),
            projects_root: args.projects_root.clone(),
        })
    }

    fn cookie(&self, headers: &HeaderMap, name: &str) -> Option<String> {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.to_string())
    }

    fn set_cookie(&self, name: &str, value: &str, max_age: Option<u64>) -> HeaderValue {
        let mut cookie = format!("{name}={value}; Path=/; HttpOnly; SameSite=Lax");
        if self.secure {
            cookie.push_str("; Secure");
        }
        if let Some(seconds) = max_age {
            cookie.push_str(&format!("; Max-Age={seconds}"));
        }
        HeaderValue::from_str(&cookie).expect("cookie is ASCII")
    }

    fn principal(&self, entrance: Entrance, headers: &HeaderMap) -> Option<Principal> {
        if entrance == Entrance::Owner {
            let login = headers
                .get("tailscale-user-login")
                .and_then(|v| v.to_str().ok())?;
            return self
                .owner_logins
                .iter()
                .any(|l| l.eq_ignore_ascii_case(login))
                .then_some(Principal::Owner);
        }
        if let Some(session) = self.cookie(headers, self.owner_cookie) {
            let mut sessions = self
                .owner_sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            sessions.retain(|_, created| created.elapsed() < OWNER_SESSION_TTL);
            if sessions
                .keys()
                .any(|k| store::constant_eq(k.as_bytes(), store::digest(&session).as_bytes()))
            {
                return Some(Principal::Owner);
            }
        }
        let credential = self.cookie(headers, self.device_cookie)?;
        self.store
            .authenticate(&credential)
            .map(|d| Principal::Device {
                id: d.id,
                label: d.label,
            })
    }

    /// Count a failed sign-in or invite; true when the caller should be slowed down.
    fn too_many_failures(&self, failed: bool) -> bool {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        if failures.0.elapsed() > FAILURE_WINDOW {
            *failures = (Instant::now(), 0);
        }
        if failed {
            failures.1 += 1;
        }
        failures.1 >= MAX_FAILURES
    }

    fn origin_for(&self, entrance: Entrance) -> &str {
        match entrance {
            Entrance::Public => &self.public_origin,
            Entrance::Owner => self.owner_origin.as_deref().unwrap_or(&self.public_origin),
        }
    }

    /// State-changing requests must come from our own page.
    fn same_origin(&self, entrance: Entrance, headers: &HeaderMap) -> bool {
        headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|o| o.eq_ignore_ascii_case(self.origin_for(entrance)))
    }
}

fn json_response(status: StatusCode, value: Value) -> Response<Body> {
    let mut response = Response::new(full(value.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn error(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    json_response(
        status,
        json!({ "error": { "code": code, "message": message } }),
    )
}

fn page(name: &str, origin: &str) -> Response<Body> {
    let html = PAGE_HTML
        .replace("{{page}}", name)
        .replace("{{origin}}", origin);
    let mut response = Response::new(full(html));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("content-security-policy", HeaderValue::from_static(CSP));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn asset(content_type: &'static str, body: &'static str) -> Response<Body> {
    let mut response = Response::new(full(body));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn redirect(location: &str) -> Response<Body> {
    let mut response = Response::new(empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(location).unwrap_or(HeaderValue::from_static("/")),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn read_json(req: Request<Incoming>) -> Result<Value, Box<Response<Body>>> {
    let too_large = || {
        Box::new(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "The request is too large.",
        ))
    };
    if req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n > MAX_JSON)
    {
        return Err(too_large());
    }
    let limited = http_body_util::Limited::new(req.into_body(), MAX_JSON);
    let bytes = limited.collect().await.map_err(|_| too_large())?.to_bytes();
    serde_json::from_slice(&bytes).map_err(|_| {
        Box::new(error(
            StatusCode::BAD_REQUEST,
            "bad_json",
            "The request body is not JSON.",
        ))
    })
}

fn wants_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/html"))
}

fn device_json(d: &store::Device) -> Value {
    json!({ "id": d.id, "label": d.label, "createdAt": d.created_at, "lastSeenAt": d.last_seen_at, "expiresAt": d.expires_at })
}

fn qr_svg(text: &str) -> String {
    use qrcode::render::svg;
    qrcode::QrCode::new(text.as_bytes())
        .map(|code| {
            code.render::<svg::Color>()
                .min_dimensions(220, 220)
                .quiet_zone(true)
                .build()
        })
        .unwrap_or_default()
}

async fn handle(app: Arc<App>, entrance: Entrance, req: Request<Incoming>) -> Response<Body> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let principal = app.principal(entrance, req.headers());
    let origin = app.origin_for(entrance).to_string();

    match (entrance, &method, path.as_str()) {
        (_, &Method::GET, "/__gateway/gateway.css") => {
            return asset("text/css; charset=utf-8", PAGE_CSS)
        }
        (_, &Method::GET, "/__gateway/gateway.js") => {
            return asset("text/javascript; charset=utf-8", PAGE_JS)
        }
        (_, &Method::GET, "/__gateway/bridge.js") => {
            return asset("text/javascript; charset=utf-8", BRIDGE_JS)
        }
        (_, &Method::GET, "/__gateway/health") => {
            let up = app.upstream.reachable().await;
            let status = if up {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            return json_response(
                status,
                json!({
                    "gateway": "ok",
                    "version": env!("CARGO_PKG_VERSION"),
                    "lattice": up,
                    "rewritePage": app.bridge.rewrite,
                    "rewrites": app.bridge.counters.snapshot(),
                }),
            );
        }
        _ => {}
    }

    if entrance == Entrance::Owner {
        if principal.is_none() {
            return error(
                StatusCode::FORBIDDEN,
                "not_owner",
                "This Tailscale login is not allowed to manage devices.",
            );
        }
        if method == Method::GET && (path == "/" || path == "/__gateway/devices") {
            return page("devices", &origin);
        }
    }

    match (&method, path.as_str()) {
        (&Method::GET, "/__gateway/login") if entrance == Entrance::Public => {
            return page("login", &origin)
        }
        (&Method::GET, "/__gateway/pair") if entrance == Entrance::Public => {
            return page("pair", &origin)
        }
        (&Method::GET, "/__gateway/projects") if entrance == Entrance::Public => {
            return if principal.is_some() {
                page("projects", &origin)
            } else {
                redirect("/__gateway/login?next=/__gateway/projects")
            };
        }
        (&Method::GET, "/__gateway/api/projects") if entrance == Entrance::Public => {
            if principal.is_none() {
                return error(
                    StatusCode::UNAUTHORIZED,
                    "sign_in_required",
                    "Pair this browser or sign in with the owner token.",
                );
            }
            let projects = list_projects(app.projects_root.as_deref());
            return json_response(StatusCode::OK, json!({ "projects": projects }));
        }
        (&Method::GET, "/__gateway/devices") => {
            return if principal == Some(Principal::Owner) {
                page("devices", &origin)
            } else {
                redirect("/__gateway/login?next=/__gateway/devices")
            };
        }
        (&Method::GET, "/__gateway/api/whoami") => {
            return match &principal {
                Some(Principal::Owner) => json_response(
                    StatusCode::OK,
                    json!({ "kind": "owner", "publicOrigin": app.public_origin }),
                ),
                Some(Principal::Device { label, .. }) => {
                    json_response(StatusCode::OK, json!({ "kind": "device", "label": label }))
                }
                None => json_response(StatusCode::OK, json!({ "kind": "anonymous" })),
            };
        }
        (&Method::POST, p) if p.starts_with("/__gateway/api/") => {
            if !app.same_origin(entrance, req.headers()) {
                return error(
                    StatusCode::FORBIDDEN,
                    "cross_origin",
                    "This request did not come from the gateway's own page.",
                );
            }
            return api(app.clone(), entrance, principal, p.to_string(), req).await;
        }
        (&Method::GET, "/__gateway/api/devices") => {
            if principal != Some(Principal::Owner) {
                return error(
                    StatusCode::UNAUTHORIZED,
                    "owner_required",
                    "Sign in as the owner to manage devices.",
                );
            }
            let devices: Vec<Value> = app.store.list().iter().map(device_json).collect();
            return json_response(StatusCode::OK, json!({ "devices": devices }));
        }
        (_, p) if p.starts_with("/__gateway/") => {
            return error(StatusCode::NOT_FOUND, "not_found", "No such gateway page.")
        }
        _ => {}
    }

    if entrance == Entrance::Owner {
        return error(
            StatusCode::NOT_FOUND,
            "management_only",
            "The owner address manages devices. Open the workspace at its public address.",
        );
    }
    let Some(principal) = principal else {
        if method == Method::GET && wants_html(req.headers()) {
            let next = req
                .uri()
                .path_and_query()
                .map(|p| p.as_str())
                .unwrap_or("/");
            let safe = if next.starts_with('/') && !next.starts_with("//") {
                next
            } else {
                "/"
            };
            return redirect(&format!("/__gateway/login?next={}", urlencode(safe)));
        }
        return error(
            StatusCode::UNAUTHORIZED,
            "sign_in_required",
            "Pair this browser or sign in with the owner token.",
        );
    };
    // Cross-site WebSocket hijacking and CSRF: the browser's Origin, when sent,
    // must be ours. Same-origin fetches and navigations pass.
    if let Some(sent) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        if !sent.eq_ignore_ascii_case(&app.public_origin) {
            return error(
                StatusCode::FORBIDDEN,
                "cross_origin",
                "Requests from other sites cannot reach this workspace.",
            );
        }
    }
    proxy::forward(
        req,
        &app.upstream,
        &app.public_origin,
        principal.name(),
        app.revocations.subscribe(),
        &app.bridge,
    )
    .await
}

/// Subfolders of the projects folder, newest first. Symlinks and hidden folders are skipped.
fn list_projects(root: Option<&Path>) -> Vec<Value> {
    let Some(root) = root else { return Vec::new() };
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut projects: Vec<(std::time::SystemTime, Value)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if name.starts_with('.') {
                return None;
            }
            let path = entry.path();
            let has_tex = fs::read_dir(&path)
                .ok()?
                .filter_map(Result::ok)
                .any(|f| f.file_name().to_string_lossy().ends_with(".tex"));
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((
                modified,
                json!({ "name": name, "path": path.to_string_lossy(), "hasTex": has_tex }),
            ))
        })
        .collect();
    projects.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    projects.into_iter().take(100).map(|(_, v)| v).collect()
}

/// Take the newest address Lattice asked to open in the last minute, if any.
/// Only `http://127.0.0.1:18452/?entry=<nonce>` is accepted; it is handed back
/// as a path on the public origin.
fn claim_open_request(dir: Option<&Path>) -> Option<String> {
    let dir = dir?;
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if !meta.is_file()
            || modified
                .elapsed()
                .map_or(true, |age| age > OPEN_REQUEST_TTL)
        {
            let _ = fs::remove_file(&path);
            continue;
        }
        if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
            newest = Some((modified, path));
        }
    }
    let (_, path) = newest?;
    let text = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    let rest = text.trim().strip_prefix("http://127.0.0.1:18452/?entry=")?;
    (!rest.is_empty()
        && rest.len() <= 128
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then(|| format!("/?entry={rest}"))
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn api(
    app: Arc<App>,
    entrance: Entrance,
    principal: Option<Principal>,
    path: String,
    req: Request<Incoming>,
) -> Response<Body> {
    let owner = principal == Some(Principal::Owner);
    match path.as_str() {
        "/__gateway/api/login" if entrance == Entrance::Public => {
            if app.too_many_failures(false) {
                return error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "slow_down",
                    "Too many failed attempts. Wait ten minutes and try again.",
                );
            }
            let body = match read_json(req).await {
                Ok(v) => v,
                Err(r) => return *r,
            };
            let given = body
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if !store::constant_eq(given.as_bytes(), app.token.as_bytes()) {
                app.too_many_failures(true);
                return error(
                    StatusCode::UNAUTHORIZED,
                    "wrong_token",
                    "That token does not match this host's owner token.",
                );
            }
            let session = store::random_hex(32);
            app.owner_sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(store::digest(&session), Instant::now());
            let mut response = json_response(StatusCode::OK, json!({ "kind": "owner" }));
            response.headers_mut().append(
                header::SET_COOKIE,
                app.set_cookie(app.owner_cookie, &session, None),
            );
            response
        }
        "/__gateway/api/logout" => {
            let mut response = json_response(StatusCode::OK, json!({ "kind": "anonymous" }));
            if let Some(session) = app.cookie(req.headers(), app.owner_cookie) {
                app.owner_sessions
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&store::digest(&session));
            }
            response.headers_mut().append(
                header::SET_COOKIE,
                app.set_cookie(app.owner_cookie, "", Some(0)),
            );
            response
        }
        "/__gateway/api/redeem" if entrance == Entrance::Public => {
            if app.too_many_failures(false) {
                return error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "slow_down",
                    "Too many failed attempts. Wait ten minutes and try again.",
                );
            }
            let body = match read_json(req).await {
                Ok(v) => v,
                Err(r) => return *r,
            };
            let code = body.get("code").and_then(Value::as_str).unwrap_or("");
            let label = body.get("label").and_then(Value::as_str).unwrap_or("");
            match app.store.redeem(code, label) {
                Ok((device, credential)) => {
                    let mut response = json_response(
                        StatusCode::OK,
                        json!({ "kind": "device", "label": device.label }),
                    );
                    response.headers_mut().append(
                        header::SET_COOKIE,
                        app.set_cookie(
                            app.device_cookie,
                            &credential,
                            Some(store::DEVICE_TTL_SECS),
                        ),
                    );
                    response
                }
                Err(StoreError::InvalidLabel) => error(
                    StatusCode::BAD_REQUEST,
                    "bad_label",
                    "Name this device with 1 to 48 characters.",
                ),
                Err(StoreError::InvalidInvite) => {
                    app.too_many_failures(true);
                    error(StatusCode::GONE, "invite_used", "This pairing link was already used or has expired. Ask the owner for a new one.")
                }
                Err(StoreError::TooMany) => error(
                    StatusCode::CONFLICT,
                    "too_many_devices",
                    "This workspace already has 32 paired devices. Revoke one first.",
                ),
                Err(StoreError::Storage(e)) => error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "storage",
                    &format!("Could not save the device: {e}"),
                ),
            }
        }
        "/__gateway/api/open-request" if entrance == Entrance::Public && principal.is_some() => {
            match claim_open_request(app.open_requests.as_deref()) {
                Some(url) => json_response(StatusCode::OK, json!({ "url": url })),
                None => {
                    let mut response = Response::new(empty());
                    *response.status_mut() = StatusCode::NO_CONTENT;
                    response
                }
            }
        }
        "/__gateway/api/invites" if owner => match app.store.create_invite() {
            Ok(code) => {
                let url = format!("{}/__gateway/pair#{code}", app.public_origin);
                json_response(
                    StatusCode::OK,
                    json!({ "url": url, "expiresIn": store::INVITE_TTL.as_secs(), "qrSvg": qr_svg(&url) }),
                )
            }
            Err(_) => error(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_invites",
                "Too many open invites. Wait two minutes for them to expire.",
            ),
        },
        p if owner && p.starts_with("/__gateway/api/devices/") && p.ends_with("/revoke") => {
            let id = &p["/__gateway/api/devices/".len()..p.len() - "/revoke".len()];
            match app.store.revoke(id) {
                Ok(true) => {
                    let _ = app.revocations.send(format!("device:{id}"));
                    json_response(StatusCode::OK, json!({ "revoked": id }))
                }
                Ok(false) => error(
                    StatusCode::NOT_FOUND,
                    "no_device",
                    "That device is not paired.",
                ),
                Err(StoreError::Storage(e)) => error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "storage",
                    &format!("Could not save the change: {e}"),
                ),
                Err(_) => error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "storage",
                    "Could not save the change.",
                ),
            }
        }
        _ if !owner => error(
            StatusCode::UNAUTHORIZED,
            "owner_required",
            "Sign in as the owner to do this.",
        ),
        _ => error(
            StatusCode::NOT_FOUND,
            "not_found",
            "No such gateway action.",
        ),
    }
}

fn peer_uid(stream: &tokio::net::UnixStream) -> Option<u32> {
    stream.peer_cred().ok().map(|c| c.uid())
}

pub async fn serve(app: Arc<App>, args: &Args) -> Result<(), String> {
    let public = TcpListener::bind(args.listen)
        .await
        .map_err(|e| format!("{}: {e}", args.listen))?;
    eprintln!(
        "lattice-gateway: {} -> Lattice at {}, public origin {}",
        args.listen, app.upstream.addr, app.public_origin
    );
    {
        let app = app.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                app.store.flush_seen();
            }
        });
    }
    if let Some(socket) = &args.owner_socket {
        if socket.exists() {
            let meta = fs::symlink_metadata(socket).map_err(|e| e.to_string())?;
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return Err(format!("{} exists and is not a socket.", socket.display()));
            }
            fs::remove_file(socket).map_err(|e| e.to_string())?;
        }
        let listener =
            UnixListener::bind(socket).map_err(|e| format!("{}: {e}", socket.display()))?;
        fs::set_permissions(socket, fs::Permissions::from_mode(0o660))
            .map_err(|e| e.to_string())?;
        let allowed = args.ingress_uid;
        let app = app.clone();
        eprintln!("lattice-gateway: owner page on {}", socket.display());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let uid = peer_uid(&stream);
                if !(uid == Some(0) || (allowed.is_some() && uid == allowed)) {
                    continue; // Only the Tailscale daemon may speak for an owner login.
                }
                let app = app.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let app = app.clone();
                        async move {
                            Ok::<_, std::convert::Infallible>(
                                handle(app, Entrance::Owner, req).await,
                            )
                        }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
    }
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            accepted = public.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                let app = app.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let app = app.clone();
                        async move { Ok::<_, std::convert::Infallible>(handle(app, Entrance::Public, req).await) }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).with_upgrades().await;
                });
            }
            _ = &mut shutdown => {
                app.store.flush_seen();
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_must_be_canonical() {
        assert!(canonical_origin("https://w.example.ts.net", false).is_ok());
        assert!(canonical_origin("https://w.example.ts.net:8443", false).is_ok());
        assert!(canonical_origin("https://w.example/path", false).is_err());
        assert!(canonical_origin("https://w.example:443", false).is_err());
        assert!(canonical_origin("http://127.0.0.1:18490", false).is_err());
        assert!(canonical_origin("http://127.0.0.1:18490", true).is_ok());
    }

    #[test]
    fn open_requests_are_claimed_once_and_only_for_entry_addresses() {
        let dir = std::env::temp_dir().join(format!("lattice-open-{}", store::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("1.url"),
            "http://127.0.0.1:18452/?entry=abc_DEF-123\n",
        )
        .unwrap();
        assert_eq!(
            claim_open_request(Some(&dir)).as_deref(),
            Some("/?entry=abc_DEF-123")
        );
        assert_eq!(claim_open_request(Some(&dir)), None);
        fs::write(dir.join("2.url"), "https://evil.example/?entry=x").unwrap();
        assert_eq!(claim_open_request(Some(&dir)), None);
        fs::write(dir.join("3.url"), "http://127.0.0.1:18452/?entry=a&b").unwrap();
        assert_eq!(claim_open_request(Some(&dir)), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lists_project_folders_without_hidden_ones() {
        let dir = std::env::temp_dir().join(format!("lattice-projects-{}", store::random_hex(6)));
        fs::create_dir_all(dir.join("paper")).unwrap();
        fs::write(dir.join("paper/main.tex"), "").unwrap();
        fs::create_dir_all(dir.join(".cache")).unwrap();
        fs::write(dir.join("notes.txt"), "").unwrap();
        let projects = list_projects(Some(&dir));
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0]["name"], "paper");
        assert_eq!(projects[0]["hasTex"], true);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn next_redirects_stay_on_this_site() {
        assert_eq!(urlencode("/a b?x=1"), "/a%20b%3Fx%3D1");
    }
}
