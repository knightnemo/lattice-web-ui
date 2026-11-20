//! The installer opts in to the updater. HTTP can only approve its advertised version.
use crate::{
    server_session::{browser_authenticated, failure, same_origin},
    transport::Server,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

pub struct HostUpdates {
    directory: PathBuf,
    version: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Status {
    schema: u32,
    installed_version: String,
    latest_version: Option<String>,
    phase: Phase,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Current,
    Available,
    Preparing,
    Ready,
    Waiting,
    Switching,
    RolledBack,
    Failed,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    version: String,
}

fn version(value: &str) -> Option<[u64; 3]> {
    let parts = value
        .split('.')
        .map(|part| {
            if part.len() > 1 && part.starts_with('0')
                || !part.bytes().all(|byte| byte.is_ascii_digit())
            {
                None
            } else {
                part.parse().ok()
            }
        })
        .collect::<Option<Vec<_>>>()?;
    parts.try_into().ok()
}

impl HostUpdates {
    pub fn new(directory: PathBuf, workspace: &Path) -> Result<Self, String> {
        let directory = directory.canonicalize().map_err(|error| error.to_string())?;
        if directory.starts_with(workspace) || workspace.starts_with(&directory) {
            return Err("Host update state must be outside the workspace.".into());
        }
        let executable = std::env::current_exe()
            .and_then(|path| path.canonicalize())
            .map_err(|error| error.to_string())?;
        let release = executable.parent().ok_or("Release directory unavailable.")?;
        if release.starts_with(workspace) || workspace.starts_with(release) {
            return Err("Managed releases must be outside the workspace.".into());
        }
        let installed = fs::read_to_string(release.join("release-version.txt"))
            .map_err(|error| format!("Cannot read managed release version: {error}"))?;
        let installed = installed.trim();
        if version(installed).is_none() {
            return Err(
                "Expected X.Y.Z in release-version.txt beside the managed executable.".into()
            );
        }
        Ok(Self { directory, version: installed.into() })
    }

    fn status(&self) -> Option<Status> {
        let mut raw = String::new();
        File::open(self.directory.join("status.json"))
            .ok()?
            .take(4097)
            .read_to_string(&mut raw)
            .ok()?;
        if raw.len() > 4096 {
            return None;
        }
        let status: Status = serde_json::from_str(&raw).ok()?;
        if status.schema != 1
            || status.installed_version != self.version
            || status.latest_version.as_deref().is_some_and(|latest| version(latest).is_none())
        {
            return None;
        }
        Some(status)
    }

    // Each independent operation opens its own description. The worker takes an exclusive
    // lock on the same inode before switching the release, closing the check/start race.
    pub fn guard(&self) -> Result<File, Response> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.directory.join("work.lock"))
            .map_err(|_| unavailable())?;
        match file.try_lock_shared() {
            Ok(()) if !self.in_trial() => Ok(file),
            Ok(()) | Err(TryLockError::WouldBlock) => Err(switching()),
            Err(TryLockError::Error(_)) => Err(unavailable()),
        }
    }

    pub fn in_trial(&self) -> bool {
        !matches!(fs::symlink_metadata(self.directory.join("trial.json")), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    }

    fn approve(&self, approved: &str) -> std::io::Result<()> {
        let path = self.directory.join(format!(".request-{}", uuid::Uuid::new_v4()));
        {
            let mut temporary =
                OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
            if let Err(error) =
                writeln!(temporary, "{approved}").and_then(|()| temporary.sync_all())
            {
                let _ = fs::remove_file(path);
                return Err(error);
            }
        }
        if let Err(error) = fs::rename(&path, self.directory.join("request")) {
            let _ = fs::remove_file(path);
            return Err(error);
        }
        File::open(&self.directory)?.sync_all()
    }
}

fn unavailable() -> Response {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "host_update_unavailable",
        "The host updater is unavailable.",
    )
}

pub fn switching() -> Response {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "host_updating",
        "The host is switching versions. Retry in a moment.",
    )
}

fn unconfigured() -> Response {
    failure(
        StatusCode::NOT_FOUND,
        "host_updates_unconfigured",
        "Managed host updates are disabled.",
    )
}

fn owner<'a>(state: &'a Server, headers: &HeaderMap) -> Result<&'a HostUpdates, Response> {
    let updater = state.host_updates.as_deref().ok_or_else(unconfigured)?;
    if !same_origin(state, headers)
        || !browser_authenticated(state, headers)
        || (state.pairing.is_some() && !crate::device_pairing::can_manage_devices(state, headers))
    {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "owner_required",
            "Only the workspace owner can update the host.",
        ));
    }
    Ok(updater)
}

async fn status(State(state): State<Server>, headers: HeaderMap) -> Result<Response, Response> {
    let updater = owner(&state, &headers)?;
    let mut status = updater.status().unwrap_or_else(|| Status {
        schema: 1,
        installed_version: updater.version.clone(),
        latest_version: None,
        phase: Phase::Current,
    });
    if matches!(status.phase, Phase::Available | Phase::Ready | Phase::Failed | Phase::RolledBack)
        && status.latest_version.as_deref().is_some_and(|latest| {
            fs::read_to_string(updater.directory.join("request"))
                .is_ok_and(|request| request.trim() == latest)
        })
    {
        status.phase = Phase::Preparing;
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(status)).into_response())
}

async fn approve(
    State(state): State<Server>, headers: HeaderMap, Json(approval): Json<Approval>,
) -> Result<StatusCode, Response> {
    let updater = owner(&state, &headers)?;
    if headers.get(header::ORIGIN).and_then(|value| value.to_str().ok()).is_none() {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "origin_required",
            "Approve the update from the workspace.",
        ));
    }
    let _guard = updater.guard()?;
    let can_approve = updater.status().is_some_and(|status| {
        status.latest_version.as_deref() == Some(approval.version.as_str())
            && version(&approval.version) > version(&updater.version)
            && matches!(
                status.phase,
                Phase::Available
                    | Phase::Preparing
                    | Phase::Ready
                    | Phase::Waiting
                    | Phase::Failed
                    | Phase::RolledBack
            )
    });
    if !can_approve {
        return Err(failure(
            StatusCode::CONFLICT,
            "release_changed",
            "Check for the currently available release.",
        ));
    }
    updater.approve(&approval.version).map_err(|_| unavailable())?;
    Ok(StatusCode::ACCEPTED)
}

async fn health(State(state): State<Server>) -> Result<Response, Response> {
    let updater = state.host_updates.as_deref().ok_or_else(unconfigured)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(json!({ "version": updater.version })))
        .into_response())
}

pub fn routes() -> Router<Server> {
    Router::new()
        .route("/api/host-update", get(status).post(approve))
        .route("/api/host-update/health", get(health))
        .layer(DefaultBodyLimit::max(1024))
}
