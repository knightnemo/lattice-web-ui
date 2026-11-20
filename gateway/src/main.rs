//! lattice-gateway: who may reach the Lattice running on this host.
//!
//! Lattice's browser host serves the whole app on loopback and trusts whoever
//! connects. This gateway sits in front of it, behind an HTTPS entrance
//! (Tailscale Serve, Caddy or a tunnel), and lets through only:
//!
//! - browsers paired with a one-time invite (a device credential cookie), and
//! - the owner, signed in with the recovery token.
//!
//! An optional owner socket, meant for Tailscale Serve, serves only device
//! management and trusts Serve's identity header for the configured logins.

mod app;
mod bridge;
mod proxy;
mod store;

use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser, Debug)]
#[command(version, about = "Access gateway in front of Lattice's browser host")]
pub struct Args {
    /// Public entrance address (loopback; TLS terminates in front of it).
    #[arg(long, default_value = "127.0.0.1:18490")]
    pub listen: SocketAddr,
    /// The HTTPS origin browsers use, e.g. https://workspace.example.ts.net
    #[arg(long)]
    pub public_origin: String,
    /// Lattice's browser host.
    #[arg(long, default_value = "127.0.0.1:18452")]
    pub upstream: SocketAddr,
    /// Private directory for the paired-device registry.
    #[arg(long)]
    pub state_dir: PathBuf,
    /// File holding the owner's recovery token (created if missing).
    #[arg(long)]
    pub token_file: PathBuf,
    /// Unix socket for the owner page behind Tailscale Serve.
    #[arg(long)]
    pub owner_socket: Option<PathBuf>,
    /// The origin of the owner page, e.g. https://host.example.ts.net:9443
    #[arg(long)]
    pub owner_origin: Option<String>,
    /// File listing Tailscale logins allowed on the owner page, one per line.
    #[arg(long)]
    pub owner_logins: Option<PathBuf>,
    /// UID allowed to connect to the owner socket besides root (tailscaled in a container).
    #[arg(long)]
    pub ingress_uid: Option<u32>,
    /// Rewrite the loopback-only expressions of Lattice's page so it runs at the public origin.
    #[arg(long)]
    pub rewrite_loopback_page: bool,
    /// Directory where Lattice's xdg-open stand-in drops the addresses it was asked to open.
    #[arg(long)]
    pub open_requests: Option<PathBuf>,
    /// Folder whose subfolders the Projects page offers to open in Lattice.
    #[arg(long)]
    pub projects_root: Option<PathBuf>,
    /// Plain-HTTP development only: cookies without Secure or the __Host- prefix.
    #[arg(long)]
    pub insecure_dev_cookies: bool,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let app = match app::App::new(&args) {
        Ok(app) => Arc::new(app),
        Err(message) => {
            eprintln!("lattice-gateway: {message}");
            std::process::exit(2);
        }
    };
    if let Err(message) = app::serve(app, &args).await {
        eprintln!("lattice-gateway: {message}");
        std::process::exit(1);
    }
}
