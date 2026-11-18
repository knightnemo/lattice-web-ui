# Remote Workspace for Lattice

A Lattice plugin that opens a private Linux-hosted Lattice workspace. The same HTTPS
address opens on a Mac with the plugin, or from the browser on a phone connected
to the authorized Tailscale network.

## Install the Mac plugin

Use a macOS Lattice build with **Settings → Plugins** (Plugin API 1).
Choose **Install from folder…** and select this repository's `plugin/` directory.
Enable **Remote Workspace**, then run **Remote Workspace: Set workspace address…**
from the command palette. Enter the workspace origin shown by Tailscale Serve,
such as `https://your-machine.example.ts.net:8443`.

**Remote Workspace: Open remote workspace** opens the saved address in your
default browser. Enter the workspace access token on the server's login page.
The plugin remembers the HTTPS origin in its own data folder and has no
network, project or secret grants. The browser keeps the authentication cookie.
On a phone, open the same address directly.

`dist/remote-workspace-0.2.0.zip` is the corresponding package for **Install from
URL…** when hosted at an HTTPS URL. Its checksum is in `dist/SHA256SUMS`.

## Use Remote Workspace on iPhone Duo

Open the workspace HTTPS address in Safari. The outer display shows a full-width
editor. Unfold to see the editor and PDF side by side, with your draft and cursor
position intact. When Safari is in a narrow Split View window, the editor uses
the single-pane layout. The mobile toolbar can open the PDF or project files
directly.

The layout is served by the Linux companion. To upgrade an existing server,
build the 0.2.0 source kit and rerun the companion installer with your existing
workspace and service settings. The Mac plugin keeps using the same URL.

## Run the Linux companion

The companion runs independently of the Mac and uses the previously integrated
headless Lattice implementation. It supports editing, LaTeX builds, PDF preview,
and the CLI. The versioned source kit includes the pinned server and web source,
the existing systemd/Tailscale installer, and the optional Codex runtime tooling.

On the Linux host, install Node 22, pnpm 10.13.1, Rust (see
`source/rust-toolchain.toml`), a C/C++ toolchain, Python 3, and LaTeX with
`latexmk`. Join the authorized tailnet. Extract the source kit and build it:

```bash
tar -xzf lattice-remote-source-0.2.0.tar.gz
cd lattice-remote-source-0.2.0
./build-linux.sh
tar -xzf "lattice-remote-host-$(uname -m).tar.gz"
cd lattice-remote-host
```

Choose an existing Linux directory that holds only the projects you want to
serve. For example, with a project already at **~/lattice-workspaces/paper**:

```bash
python3 scripts/install-headless-service.py \
  --binary ./lattice-server --assets ./web \
  --workspace-root "$HOME/lattice-workspaces" \
  --project "$HOME/lattice-workspaces/paper" \
  --port 18482 --https-port 8443 --tailscale
```

Use the HTTPS address shown by `tailscale serve status`. The installer creates
the access token in the service's data directory with private file permissions.
Its default path is `~/.local/share/lattice-headless/access-token`. Enter it in
the workspace sign-in form on each new browser. `lattice-server capabilities`
lists the supported operations, including those available through its
`invoke` CLI.

The existing installer requires a Tailscale operator and systemd user lingering
for a 24/7 deployment. It keeps the server bound to loopback and sets up
private Tailscale Serve. See `docs/private-headless-deployment.md` in the built host kit for exact
requirements and checks. It is under `source/docs/` in the source kit.

## Add Codex

The Linux host kit includes `scripts/prepare-headless-agent.mjs` and
`docs/headless-agent.md`, which is also under `source/docs/` in the source kit. Use a prepared Synara runtime matching
`scripts/synara-runtime.json`. The guide covers the supported Linux kernel,
Codex's device login in a dedicated provider home, and the second private HTTPS
port for the Agent. The installer accepts the runtime and origin options in its
deployment guide. Start the Agent from the remote web workspace, then review and
apply its staged changes there. The plugin never handles provider credentials.

## Build the two release artifacts

```bash
node --test test/plugin.test.mjs
./scripts/package.sh /path/to/lattice-integrated
```

The source kit is made from the pinned Git commit, so local environment files,
account state and build caches are excluded. The Mac plugin reuses Lattice's
MIT-licensed Plugin API 1 SDK. The companion source and bundled third-party
materials carry their original licences and notices.
