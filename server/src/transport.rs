use crate::browser_session_routes::{self, read_token};
use crate::device_pairing;
use crate::dispatch::{self, Core};
use crate::server_session::*;
use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, Subcommand};
use futures_util::stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tower_http::services::ServeDir;

#[derive(Parser)]
#[command(about = "Display-free Lattice shared-core CLI and authenticated web server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Bridge newline-delimited JSON to the sandboxed agent RPC socket. EOF stops the process.
    AgentBridge {
        #[arg(long)]
        runtime: PathBuf,
        #[arg(long)]
        project: PathBuf,
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long, default_value = "/ws")]
        path: String,
    },
    #[command(hide = true)]
    AgentSandbox {
        #[arg(long)]
        policy: PathBuf,
        #[arg(long)]
        program: PathBuf,
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// Print the supported commands and explicit desktop-only limitations.
    Capabilities,
    /// Execute one command. JSON arguments are read from stdin; secrets never enter argv.
    Invoke {
        command: String,
        #[arg(long)]
        project: PathBuf,
        #[arg(long)]
        state_dir: Option<PathBuf>,
    },
    /// Serve one shared project. Bind loopback and use an authenticated HTTPS reverse proxy remotely.
    Serve {
        #[arg(long)]
        workspace_root: PathBuf,
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long)]
        token_file: PathBuf,
        #[arg(long, default_value = "127.0.0.1:18482")]
        listen: SocketAddr,
        #[arg(long)]
        assets: Option<PathBuf>,
        #[arg(long)]
        project: Option<PathBuf>,
        /// Require HTTPS for the authentication cookie behind a TLS reverse proxy.
        #[arg(long)]
        secure_cookies: bool,
        /// Let a trusted HTTPS account gateway bootstrap a browser session.
        #[arg(long)]
        account_gateway: bool,
        /// Enable trusted personal-device pairing on a dedicated HTTPS origin.
        #[arg(long)]
        device_pairing: bool,
        #[arg(long)]
        agent_runtime: Option<PathBuf>,
        #[arg(long)]
        public_origin: Option<String>,
        #[arg(long)]
        agent_public_origin: Option<String>,
        #[arg(long, default_value = "127.0.0.1:18583")]
        agent_listen: SocketAddr,
    },
}
#[derive(Clone)]
pub(crate) struct Session {
    pub(crate) expires: Instant,
    pub(crate) project: PathBuf,
    pub(crate) projects: HashMap<String, PathBuf>,
    pub(crate) device_id: Option<String>,
}
#[derive(Clone)]
pub(crate) struct Server {
    pub(crate) core: Arc<Core>,
    pub(crate) initial: PathBuf,
    pub(crate) cores: Arc<Mutex<HashMap<PathBuf, Arc<Core>>>>,
    pub(crate) token: Arc<String>,
    pub(crate) sessions: Arc<Mutex<HashMap<String, Session>>>,
    pub(crate) secure_cookies: bool,
    pub(crate) account_gateway: bool,
    pub(crate) pairing: Option<Arc<device_pairing::Pairing>>,
    pub(crate) public_origin: String,
    pub(crate) origin_from_host: bool,
    pub(crate) agent_origin: String,
    pub(crate) agents: Arc<crate::agent_runtime::Hub>,
    pub(crate) terminals: Arc<crate::terminal_transport::TerminalHub>,
}
#[derive(Deserialize)]
struct Invoke {
    command: String,
    #[serde(default)]
    args: Value,
}
pub fn main() {
    let cli = Cli::parse();
    if let Command::AgentSandbox { policy, program, args } = &cli.command {
        if let Err(error) =
            crate::agent_sandbox::execute(policy.clone(), program.clone(), args.clone())
        {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let runtime = tokio::runtime::Runtime::new().expect("Could not start async runtime");
    let result = match cli.command {
        Command::AgentSandbox{..}=>unreachable!(),
        Command::AgentBridge{runtime:agent_runtime,project,state_dir,path}=>runtime.block_on(crate::agent_cli::run(agent_runtime,project,state_dir,path)),
        Command::Capabilities => { println!("{}", dispatch::capabilities()); Ok(()) }
        Command::Invoke { command, project, state_dir } => {
            // Domain code includes blocking HTTP and process execution. Keep it outside async tasks.
            let _guard = runtime.enter();
            (|| {
                let mut input = String::new();
                std::io::stdin().take(16*1024*1024).read_to_string(&mut input).map_err(|e|e.to_string())?;
                let args = if input.trim().is_empty() { json!({}) } else { serde_json::from_str(&input).map_err(|e|e.to_string())? };
                let state = state_dir.unwrap_or_else(|| default_state_dir());
                let core = Core::new(&project, &state)?;
                println!("{}", json!({"result":core.invoke(&command,args)?}));
                Ok(())
            })()
        }
        Command::Serve { workspace_root, state_dir, token_file, listen, assets, project, secure_cookies, account_gateway, device_pairing, agent_runtime, public_origin, agent_public_origin, agent_listen } => {
            runtime.block_on(async {
                if !listen.ip().is_loopback() { return Err("Refusing a non-loopback listener. Use an HTTPS reverse proxy or Tailscale Serve.".into()); }
                if account_gateway
                    && (!secure_cookies
                        || !public_origin.as_deref().is_some_and(|origin| origin.starts_with("https://"))
                        || agent_runtime.is_some())
                {
                    return Err("Account gateway mode requires --secure-cookies and an explicit HTTPS --public-origin, with no separate agent listener.".into());
                }
                if device_pairing
                    && (!secure_cookies || account_gateway || agent_runtime.is_some()
                        || !public_origin.as_deref().is_some_and(|origin| origin.starts_with("https://")))
                {
                    return Err("Device pairing requires --secure-cookies and an explicit HTTPS --public-origin, without an account gateway or separate agent listener.".into());
                }
                let listener=tokio::net::TcpListener::bind(listen).await.map_err(|e|e.to_string())?;
                let bound=listener.local_addr().map_err(|e|e.to_string())?;
                let core = Core::new(&workspace_root,&state_dir)?;
                let pairing = if device_pairing {
                    device_pairing::validate_paths(&core.root, &core.state_dir, &token_file, assets.as_deref())?;
                    Some(Arc::new(device_pairing::Pairing::open(&state_dir)?))
                } else { None };
                let token = read_token(&token_file)?;
                let initial = match project { Some(path)=>core.confined(&path.to_string_lossy())?,None=>core.root.clone() };
                if secure_cookies&&agent_runtime.is_some()&&public_origin.is_none(){return Err("Configure --public-origin and --agent-public-origin for HTTPS agent deployments".into());}
                let origin_from_host=agent_runtime.is_none()&&public_origin.is_none();
                let public_origin=crate::agent_listener::origin(&public_origin.unwrap_or_else(||format!("http://{bound}")))?;
                let agent_listener=if agent_runtime.is_some(){Some(crate::agent_listener::bind(agent_listen).await?)}else{None};
                let agent_origin=crate::agent_listener::origin(&agent_public_origin.unwrap_or_else(||format!("http://{}",agent_listener.as_ref().and_then(|listener|listener.local_addr().ok()).unwrap_or(agent_listen))))?;
                if agent_runtime.is_some()&&(public_origin==agent_origin||reqwest::Url::parse(&public_origin).unwrap().scheme()!=reqwest::Url::parse(&agent_origin).unwrap().scheme()||reqwest::Url::parse(&public_origin).unwrap().host_str()!=reqwest::Url::parse(&agent_origin).unwrap().host_str()){return Err("The agent needs a different port with the same hostname and HTTP/HTTPS scheme".into());}
                let agents=Arc::new(crate::agent_runtime::Hub::new(agent_runtime,state_dir.clone())?);
                let state = Server { public_origin, origin_from_host, agent_origin, agents, core, initial, cores:Default::default(), token:Arc::new(token), sessions:Default::default(), secure_cookies, account_gateway, pairing, terminals:Default::default() };
                let reaper=state.clone();
                tokio::spawn(async move {loop {tokio::time::sleep(Duration::from_secs(1)).await;reaper.agents.reap(|session|reaper.sessions.lock().unwrap().get(session).is_some_and(|session|session.expires>Instant::now()));reaper.terminals.reap(|session|reaper.sessions.lock().unwrap().get(session).is_some_and(|session|session.expires>Instant::now()));}});
                let shutdown_state=state.clone();
                let _watcher = watch_projects(&state)?;
                let mut app = Router::new()
                    .route("/api/projects",get(projects)).route("/api/capabilities",get(capabilities)).route("/api/invoke",post(invoke))
                    .route("/api/asset",get(asset)).route("/api/events",get(events))
                    .layer(DefaultBodyLimit::max(16*1024*1024)).merge(browser_session_routes::routes());
                if state.pairing.is_some() {
                    app = app.merge(device_pairing::routes());
                }
                let mut app = app.with_state(state);
                if let Some(assets) = assets {
                    let index = tokio::fs::read_to_string(assets.join("index.html")).await.map_err(|e|e.to_string())?.replacen("<head>","<head><script>window.__LATTICE_HEADLESS__=true</script>",1);
                    let index_copy=index.clone();
                    app = app.route("/",get(move || {let index=index.clone();async move { axum::response::Html(index) }})).route("/index.html",get(move || {let index=index_copy.clone();async move { axum::response::Html(index) }})).fallback_service(ServeDir::new(assets).append_index_html_on_directories(true));
                }
                let (agent_stop,mut agent_stopping)=tokio::sync::watch::channel(false);
                let agent_task=agent_listener.map(|listener|{let router=crate::agent_listener::router(shutdown_state.clone());tokio::spawn(async move{axum::serve(listener,router).with_graceful_shutdown(async move{let _=agent_stopping.wait_for(|stopped|*stopped).await;}).await})});
                eprintln!("Lattice headless listening on http://{} (workspace {}; token file {})",listener.local_addr().map_err(|e|e.to_string())?,workspace_root.display(),token_file.display());
                let result=axum::serve(listener,app).with_graceful_shutdown(async move {
                    let mut terminate=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("Could not handle SIGTERM");
                    tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
                    shutdown_state.sessions.lock().unwrap().clear();
                    shutdown_state.terminals.close_all();
                    shutdown_state.agents.close_all();
                    let _=crate::latex::abort(&shutdown_state.core.active);
                    for core in shutdown_state.cores.lock().unwrap().values() {let _=crate::latex::abort(&core.active);}
                }).await.map_err(|e|e.to_string());
                let _=agent_stop.send(true);
                if let Some(task)=agent_task {let _=tokio::time::timeout(Duration::from_secs(5),task).await;}
                result
            })
        }
    };
    if let Err(error) = result {
        eprintln!(
            "{}",
            json!({"error":{"code":if error.starts_with("unsupported_command:") {"unsupported_command"} else {"operation_failed"},"message":error}})
        );
        std::process::exit(1);
    }
}
fn default_state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local/state")
        })
        .join("lattice")
}
async fn capabilities(State(state): State<Server>, headers: HeaderMap) -> Response {
    if let Err(error) = authorize(&state, &headers) {
        return error;
    }
    Json(web_capabilities(&state)).into_response()
}
async fn invoke(
    State(state): State<Server>, headers: HeaderMap, Json(request): Json<Invoke>,
) -> Response {
    if let Err(error) = authorize(&state, &headers) {
        return error;
    }
    let id = session_id(&headers);
    let client = client_id(&headers).map(str::to_string);
    let root = match selected_project(&state, &headers, client.as_deref()) {
        Some(root) => root,
        None => match request.args.get("projectRoot").and_then(Value::as_str) {
            Some(path) => match state.core.confined(path) {
                Ok(path) => path,
                Err(error) => return failure(StatusCode::BAD_REQUEST, "path_forbidden", &error),
            },
            None => state.initial.clone(),
        },
    };
    if crate::agent_runtime::COMMANDS.contains(&request.command.as_str()) {
        return crate::agent_transport::invoke(
            &state,
            &headers,
            &root,
            &request.command,
            &request.args,
        )
        .await;
    }
    if crate::terminal_transport::COMMANDS.contains(&request.command.as_str()) {
        let owner = match id
            .as_deref()
            .filter(|id| {
                state
                    .sessions
                    .lock()
                    .unwrap()
                    .get(*id)
                    .is_some_and(|session| session.expires > Instant::now())
            })
            .ok_or_else(|| "Terminals require a browser session.".to_string())
            .and_then(|session| {
                crate::terminal_transport::TerminalHub::owner(
                    session,
                    headers
                        .get("x-lattice-client")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or(""),
                )
            }) {
            Ok(owner) => owner,
            Err(error) => return failure(StatusCode::FORBIDDEN, "terminal_forbidden", &error),
        };
        if let Some(pin) = request.args.get("projectRoot").and_then(Value::as_str) {
            if state.core.confined(pin).ok().as_ref() != Some(&root) {
                return failure(
                    StatusCode::CONFLICT,
                    "project_changed",
                    "The terminal project changed.",
                );
            }
        }
        let terminals = state.terminals.clone();
        return match tokio::task::spawn_blocking(move || {
            terminals.invoke(&owner, &root, &request.command, &request.args)
        })
        .await
        {
            Ok(Ok(value)) => ([(header::CACHE_CONTROL, "no-store")], Json(json!({"result":value})))
                .into_response(),
            Ok(Err(error)) => failure(StatusCode::BAD_REQUEST, "terminal_failed", &error),
            Err(_) => failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "terminal_failed",
                "Terminal operation failed.",
            ),
        };
    }
    let selected = if request.command == "open_project" {
        if let (Some(id), Some(client)) = (id.as_ref(), client.as_ref()) {
            if state.sessions.lock().unwrap().get(id).is_some_and(|session| {
                !session.projects.contains_key(client) && session.projects.len() >= 128
            }) {
                return failure(
                    StatusCode::TOO_MANY_REQUESTS,
                    "tab_limit",
                    "Too many project tabs for this session. Sign in again.",
                );
            }
        }
        match request
            .args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "Missing project path".to_string())
            .and_then(|path| state.core.confined(path))
        {
            Ok(path) => path,
            Err(error) => return failure(StatusCode::BAD_REQUEST, "path_forbidden", &error),
        }
    } else {
        root
    };
    let core = {
        let mut cores = state.cores.lock().unwrap();
        match cores.entry(selected.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.get().clone(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let core = match Core::new(&selected, &state.core.state_dir) {
                    Ok(core) => core,
                    Err(error) => {
                        return failure(StatusCode::BAD_REQUEST, "operation_failed", &error)
                    }
                };
                // All projects share the service event stream; payloads carry projectRoot.
                let core = Arc::new(Core {
                    root: core.root.clone(),
                    state_dir: core.state_dir.clone(),
                    active: core.active.clone(),
                    mutations: core.mutations.clone(),
                    events: state.core.events.clone(),
                });
                entry.insert(core).clone()
            }
        }
    };
    let is_open = request.command == "open_project";
    let core = if request.command == "create_project" { state.core.clone() } else { core };
    let result =
        tokio::task::spawn_blocking(move || core.invoke(&request.command, request.args)).await;
    if matches!(result, Ok(Ok(_))) && is_open {
        if let Some(id) = id {
            if let Some(session) = state.sessions.lock().unwrap().get_mut(&id) {
                if let Some(client) = client.as_ref() {
                    session.projects.insert(client.clone(), selected);
                } else {
                    session.project = selected;
                }
            }
            if let Some(client) = client.as_ref() {
                state.terminals.close_client(&id, client);
            }
        }
    }
    match result {
        Ok(Ok(value)) => {
            ([(header::CACHE_CONTROL, "no-store")], Json(json!({"result":value}))).into_response()
        }
        Ok(Err(error)) => failure(
            StatusCode::BAD_REQUEST,
            if error.starts_with("unsupported_command:") {
                "unsupported_command"
            } else {
                "operation_failed"
            },
            &error,
        ),
        Err(_) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The operation could not be completed.",
        ),
    }
}
#[derive(Deserialize)]
struct Asset {
    path: String,
    version: Option<String>,
    start: Option<u64>,
    end: Option<u64>,
    client: Option<String>,
}
async fn asset(
    State(state): State<Server>, headers: HeaderMap, method: Method, Query(query): Query<Asset>,
) -> Response {
    if let Err(error) = authorize(&state, &headers) {
        return error;
    }
    let selected =
        selected_project(&state, &headers, query.client.as_deref().or_else(|| client_id(&headers)))
            .unwrap_or_else(|| state.initial.clone());
    let candidate = if std::path::Path::new(&query.path).is_absolute() {
        PathBuf::from(&query.path)
    } else {
        selected.join(&query.path)
    };
    let path = match state.core.confined(&candidate.to_string_lossy()) {
        Ok(path) => path,
        Err(_) => {
            return failure(
                StatusCode::FORBIDDEN,
                "path_forbidden",
                "Asset is outside the workspace.",
            )
        }
    };
    // Hidden control state and histories must never be served as arbitrary browser assets.
    if path
        .strip_prefix(&state.core.root)
        .unwrap()
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    {
        return failure(
            StatusCode::FORBIDDEN,
            "path_forbidden",
            "Hidden project state is not a browser asset.",
        );
    }
    if query.version.is_some() || query.start.is_some() || query.end.is_some() {
        let (Some(version), Some(start), Some(end)) = (query.version, query.start, query.end)
        else {
            return failure(
                StatusCode::BAD_REQUEST,
                "invalid_range",
                "version, start and end are required together.",
            );
        };
        let relative = match path.strip_prefix(&selected) {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(_) => {
                return failure(
                    StatusCode::FORBIDDEN,
                    "path_forbidden",
                    "Range asset is outside the selected project.",
                )
            }
        };
        return match tokio::task::spawn_blocking(move || {
            crate::project::read_asset_range(&selected, &relative, &version, start, end)
        })
        .await
        {
            Ok(Ok(bytes)) => (
                [
                    (header::CONTENT_TYPE, "application/octet-stream"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                bytes,
            )
                .into_response(),
            _ => failure(
                StatusCode::CONFLICT,
                "asset_changed",
                "This PDF changed or its byte range is invalid. Reopen it and try again.",
            ),
        };
    }
    crate::asset_stream::serve(&state.core.root, &candidate, &headers, method).await
}
#[derive(Deserialize)]
struct EventQuery {
    client: Option<String>,
}
async fn events(
    State(state): State<Server>, headers: HeaderMap, Query(query): Query<EventQuery>,
) -> Response {
    if let Err(error) = authorize(&state, &headers) {
        return error;
    }
    let subscription = match query.client {
        Some(client) => {
            let owner = match session_id(&headers)
                .ok_or_else(|| "Terminal events require a browser session.".to_string())
                .and_then(|session| {
                    crate::terminal_transport::TerminalHub::owner(&session, &client)
                }) {
                Ok(owner) => owner,
                Err(error) => return failure(StatusCode::FORBIDDEN, "terminal_forbidden", &error),
            };
            match state.terminals.subscribe(&owner) {
                Ok(subscription) => Some(subscription),
                Err(error) => {
                    return failure(StatusCode::TOO_MANY_REQUESTS, "terminal_limit", &error)
                }
            }
        }
        None => None,
    };
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("terminal-"))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let stream = stream::unfold(
        (state.core.events.subscribe(), state, headers, subscription, cursor, false),
        |(mut rx, state, headers, mut subscription, mut cursor, ready)| async move {
            if !ready {
                return Some((
                    Ok::<_, std::convert::Infallible>(
                        Event::default()
                            .data(json!({"event":"server-ready","payload":{}}).to_string()),
                    ),
                    (rx, state, headers, subscription, cursor, true),
                ));
            }
            loop {
                if !authenticated(&state, &headers) {
                    return None;
                }
                if let Some(current) = &subscription {
                    if current.stream.is_closed() {
                        return None;
                    }
                    if let Some((id, value)) = current.stream.next(cursor) {
                        cursor = id;
                        return Some((
                            Ok(Event::default()
                                .id(format!("terminal-{id}"))
                                .data(value.to_string())),
                            (rx, state, headers, subscription, cursor, true),
                        ));
                    }
                }
                tokio::select! {
                    value = rx.recv() => {
                        if !authenticated(&state, &headers) {
                            return None;
                        }
                        let value = match value {
                            Ok(value) => value,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                json!({"event":"resync-required","payload":{}})
                            }
                            Err(_) => return None,
                        };
                        let event = Event::default().data(value.to_string());
                        return Some((Ok(event), (rx, state, headers, subscription, cursor, true)));
                    },
                    _=async {match subscription.as_mut(){Some(subscription)=>{let _=subscription.changed.changed().await;},None=>futures_util::future::pending::<()>().await}}=>{},
                    _=tokio::time::sleep(Duration::from_secs(1))=>{},
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(1))).into_response()
}

async fn projects(State(state): State<Server>, headers: HeaderMap) -> Response {
    if let Err(error) = authorize(&state, &headers) {
        return error;
    }
    let mut projects = vec![
        json!({"path":state.core.root,"name":state.core.root.file_name().unwrap_or_default().to_string_lossy()}),
    ];
    if let Ok(entries) = std::fs::read_dir(&state.core.root) {
        for entry in entries.flatten().take(1000) {
            let path = entry.path();
            if path.is_dir()
                && !entry.file_name().to_string_lossy().starts_with('.')
                && state.core.confined(&path.to_string_lossy()).is_ok()
            {
                projects.push(json!({"path":path,"name":entry.file_name().to_string_lossy()}));
            }
        }
    }
    Json(projects).into_response()
}

fn watch_projects(state: &Server) -> Result<notify::RecommendedWatcher, String> {
    use notify::Watcher;
    let cores = state.cores.clone();
    let events = state.core.events.clone();
    let workspace = state.core.root.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            let Ok(event) = event else {
                let _ = events.send(json!({"event":"resync-required","payload":{}}));
                return;
            };
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let roots = cores
                .lock()
                .unwrap()
                .keys()
                .cloned()
                .chain(std::iter::once(workspace.clone()))
                .collect::<std::collections::BTreeSet<_>>();
            for root in roots {
                let paths = event
                    .paths
                    .iter()
                    .filter_map(|path| path.strip_prefix(&root).ok())
                    .filter(|path| !path.starts_with(".research"))
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                if !paths.is_empty() {
                    let _ = events.send(
                        json!({"event":"project-fs-changed","payload":{"root":root,"paths":paths}}),
                    );
                }
            }
        })
        .map_err(|e| e.to_string())?;
    watcher.watch(&state.core.root, notify::RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    Ok(watcher)
}
