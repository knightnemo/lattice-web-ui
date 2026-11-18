use crate::device_pairing;
use crate::{
    server_session::*,
    transport::{Server, Session},
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
struct Login {
    token: String,
}

pub(crate) fn read_token(path: &std::path::Path) -> Result<String, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        writeln!(file, "{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
            .map_err(|e| e.to_string())?;
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("Token file must be a regular private file (chmod 600).".into());
    }
    let token = std::fs::read_to_string(path).map_err(|e| e.to_string())?.trim().to_string();
    if token.len() < 32
        || token.len() > 512
        || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Token must contain 32–512 alphanumeric, '-' or '_' characters.".into());
    }
    Ok(token)
}
async fn session(State(state): State<Server>, headers: HeaderMap) -> Response {
    if state.account_gateway
        && headers
            .get("x-lattice-account-proxy")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|token| equal(token, &state.token))
    {
        if !same_origin(&state, &headers) {
            return failure(
                StatusCode::FORBIDDEN,
                "origin_forbidden",
                "Cross-origin requests are not accepted.",
            );
        }
        if !browser_authenticated(&state, &headers) {
            return create_browser_session(&state, None);
        }
    }
    session_response(
        &state,
        authenticated(&state, &headers),
        device_pairing::can_manage_devices(&state, &headers),
    )
}

pub(crate) fn session_response(
    state: &Server, authenticated: bool, can_manage_devices: bool,
) -> Response {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "headless":true,"authenticated":authenticated,
            "devicePairing":state.pairing.is_some(),"canManageDevices":can_manage_devices,
            "capabilities":if authenticated {web_capabilities(state)} else {Value::Null},
        })),
    )
        .into_response()
}
async fn login(
    State(state): State<Server>, headers: HeaderMap, Json(login): Json<Login>,
) -> Response {
    if state.account_gateway {
        return failure(
            StatusCode::METHOD_NOT_ALLOWED,
            "account_gateway_required",
            "Sign in through the account gateway.",
        );
    }
    if state.pairing.is_some() {
        if let Err(error) = device_pairing::mutation_origin(&state, &headers) {
            return error;
        }
    }
    if !same_origin(&state, &headers) || !equal(&login.token, &state.token) {
        let denial = failure(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Invalid server token or request origin.",
        );
        return match &state.pairing {
            Some(pairing) => pairing.failed_admission(denial),
            None => denial,
        };
    }
    let mut response = create_browser_session(&state, None);
    if state.pairing.is_some()
        && response.status().is_success()
        && cookie(&headers, device_pairing::COOKIE).is_some()
    {
        device_pairing::clear_device_cookie(&mut response);
    }
    response
}
pub(crate) fn create_browser_session(state: &Server, device: Option<(String, u64)>) -> Response {
    let now = Instant::now();
    let mut sessions = state.sessions.lock().unwrap();
    sessions.retain(|_, session| session.expires > now);
    if let Some((device_id, _)) = &device {
        // A device can resume after losing its short session cookie. Reuse its
        // live session so repeated resumption cannot consume owner capacity.
        if let Some((id, session)) = sessions
            .iter()
            .find(|(_, session)| session.device_id.as_deref() == Some(device_id.as_str()))
        {
            let seconds = session.expires.saturating_duration_since(now).as_secs().max(1);
            return session_with_cookie(state, id, seconds, false);
        }
    }
    if sessions.len() >= 128 {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "session_limit",
            "Too many active sessions.",
        );
    }
    let owner = state.pairing.is_some() && device.is_none();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let seconds = device.as_ref().map_or(28800, |(_, remaining)| (*remaining).min(28800));
    sessions.insert(
        id.clone(),
        Session {
            expires: now + Duration::from_secs(seconds),
            project: state.initial.clone(),
            projects: HashMap::new(),
            device_id: device.map(|(id, _)| id),
        },
    );
    session_with_cookie(state, &id, seconds, owner)
}

fn session_with_cookie(state: &Server, id: &str, seconds: u64, owner: bool) -> Response {
    let cookie = format!(
        "lattice_session={id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age={seconds}{}",
        if state.secure_cookies { "; Secure" } else { "" }
    );
    let mut response = session_response(state, true, owner);
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    response
}
async fn logout(State(state): State<Server>, headers: HeaderMap) -> Response {
    let allowed = if state.pairing.is_some() {
        device_pairing::mutation_origin(&state, &headers)
    } else {
        authorize(&state, &headers)
    };
    if let Err(error) = allowed {
        return error;
    }
    if let Some(id) = session_id(&headers) {
        state.sessions.lock().unwrap().remove(&id);
        state.terminals.close_session(&id);
        state.agents.close_session(&id);
    }
    let cookie = if state.secure_cookies {
        "lattice_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0; Secure"
    } else {
        "lattice_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0"
    };
    let mut response = ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response();
    if state.pairing.is_some() {
        device_pairing::clear_device_cookie(&mut response);
    }
    response
}

pub(crate) fn routes() -> Router<Server> {
    Router::new()
        .route("/api/session", get(session).post(login).delete(logout))
        .layer(DefaultBodyLimit::max(2048))
}
