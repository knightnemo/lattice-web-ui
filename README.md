<div align="center">
  <img src="docs/assets/lattice-web-ui.png" alt="" width="96" height="96">
  <h1>Lattice-web-ui</h1>
  <p>Edit LaTeX and preview PDFs from your computer or phone, with the workspace running on a Linux host.</p>
  <p>
    <a href="https://github.com/lattice-writer/lattice-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/lattice-writer/lattice-web-ui?color=4f6456" alt="Latest stable release"></a>
    <a href="#run-your-own-workspace"><img src="https://img.shields.io/badge/Host-Linux-4f6456" alt="Host platform Linux"></a>
    <a href="https://github.com/lattice-writer/lattice-web-ui/blob/main/plugin/LICENSE"><img src="https://img.shields.io/badge/Mac_plugin-MIT-4f6456" alt="Mac plugin license MIT"></a>
    <a href="https://github.com/lattice-writer/lattice-web-ui/blob/6fe84151f216df4057797a5e24982b4613c64868/README.md#license"><img src="https://img.shields.io/badge/Companion-License_notices-4f6456" alt="Companion license notices"></a>
  </p>
</div>

## Watch the setup film

*The Line Stays* (5:59) follows one workspace from its Linux host to a second Mac
and a paired iPhone. It shows how to install the plugin, add the web app to the
Dock or Home Screen, and keep an unsaved edit when the phone unfolds.

https://github.com/user-attachments/assets/8052b304-7d79-45c5-91cb-7ac2d459ffd0

[English transcript and film credits](https://github.com/lattice-writer/lattice-web-ui/blob/main/docs/the-line-stays.md)

## Open a workspace

Open the workspace's HTTPS address. If the workspace uses device pairing, ask
the owner for a QR code or a pairing link. Each invite can be used once and
expires after two minutes. Bookmark the address and keep using the same
browser profile or installed web app. The pairing survives a server restart.
On iPhone, use Safari's **Share → Add to Home Screen** to open it like an app.

### Add a shortcut in Lattice for Mac

1. Open the [latest release](https://github.com/lattice-writer/lattice-web-ui/releases/latest)
   and copy the URL of `remote-workspace-X.Y.Z.zip`. In **Settings → Plugins →
   Install from URL…**, enter that URL and its SHA-256 from the release's checksum
   file. Enable **Lattice-web-ui**.
2. In the command palette, run **Lattice-web-ui: Set workspace address…** and
   enter the same HTTPS address you opened in the browser.
3. Run **Lattice-web-ui: Open remote workspace** to open it in your browser.

To try the source version, [download the repository ZIP](https://github.com/lattice-writer/lattice-web-ui/archive/refs/heads/main.zip)
or clone the repository. Use **Install from folder…** and select its `plugin/`
directory. Keep that directory in place while the plugin is installed.

## Run your own workspace

You need a Linux host and an existing Lattice project. Install Node 22,
pnpm 10.13.1, the Rust toolchain pinned in the kit, a C/C++ toolchain, Python 3,
and LaTeX with `latexmk`.

Download `lattice-remote-source-X.Y.Z.tar.gz` from [Releases](https://github.com/lattice-writer/lattice-web-ui/releases).
If there is no release yet, run `bash scripts/package.sh "$PWD"` in a full clone
to create the kit in `dist/`.

On the Linux host, replace `X.Y.Z` with the version you downloaded or built.

```sh
version=X.Y.Z
tar -xzf "lattice-remote-source-$version.tar.gz"
cd "lattice-remote-source-$version"
./build-linux.sh
tar -xzf "lattice-remote-host-$(uname -m).tar.gz"
cd lattice-remote-host
```

For a private workspace on Tailscale, join the host to your tailnet and set up
[Tailscale operator access and the user service](https://github.com/lattice-writer/lattice-web-ui/blob/6fe84151f216df4057797a5e24982b4613c64868/docs/private-headless-deployment.md).
From the extracted host kit, point the installer at an existing project.

```sh
python3 scripts/install-headless-service.py \
  --binary ./lattice-server --assets ./web \
  --workspace-root "$HOME/lattice-workspaces" \
  --project "$HOME/lattice-workspaces/paper" \
  --port 18482 --https-port 8443 --tailscale
```

Open the HTTPS address shown by `tailscale serve status`. For the token-based
sign-in, use the private `access-token` file in the companion's data directory.
If you sign in with this token, sign in again after the companion restarts.

Add `--managed-updates` to this install command to show an **Update host**
button in the web workspace when a stable Web UI release is ready.
[Requirements and rollout behavior](docs/releases.md#enable-managed-host-updates)

If the editor needs to be reachable without Tailscale, choose one of these setups.

- [Device pairing](device-pairing/README.md) gives the owner a QR code or pairing link to share. Paired browsers can reconnect after the server restarts, and the owner can revoke access.
- [Account sign-in](account-gateway/README.md) gives approved email addresses access through an OAuth gateway.

For the optional Codex runtime, see `docs/headless-agent.md` in the built host
kit. [Agent setup](https://github.com/lattice-writer/lattice-web-ui/blob/6fe84151f216df4057797a5e24982b4613c64868/docs/headless-agent.md)

## Contribute

See the [contributing guide](https://github.com/lattice-writer/lattice-web-ui/blob/main/CONTRIBUTING.md)
for local tests and pull requests, or the [release guide](docs/releases.md)
for packaging and publishing.

The [Mac plugin is MIT-licensed](https://github.com/lattice-writer/lattice-web-ui/blob/main/plugin/LICENSE).
The companion archive includes the original source licenses and notices.
