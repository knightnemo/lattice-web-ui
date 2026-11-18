# Lattice-web-ui

A Lattice plugin that opens a Linux-hosted workspace. Open the same HTTPS
address from the Mac plugin or a phone browser. The Linux companion supports
private Tailscale access, QR pairing for trusted devices, and an HTTPS account
gateway with an email allowlist.

## Install the Mac plugin

Use a macOS Lattice build with **Settings → Plugins** (Plugin API 1).
Choose **Install from folder…** and select this repository's `plugin/` directory.
Enable **Lattice-web-ui**, then run **Lattice-web-ui: Set workspace address…**
from the command palette. Enter the HTTPS workspace origin supplied by your
deployment.

**Lattice-web-ui: Open remote workspace** opens the saved address in your
default browser. Sign in with your allowed account for the account gateway.
With the private Tailscale owner page, the configured owner can authorize
devices using their Tailscale identity. Browsers open the public editor after
pairing once. The server access token remains available for recovery.
The plugin remembers the HTTPS origin in its own data folder and has no
network, project or secret grants. The browser keeps the authentication cookie.
On a phone, open the same address directly.

`dist/remote-workspace-0.4.0.zip` is the corresponding package for **Install from
URL…** when hosted at an HTTPS URL. The 0.4.0 package displays **Remote Workspace**
in Lattice. Its checksum is in `dist/SHA256SUMS`.

## Pair a phone or another computer

From the owner's workspace, open **Devices → Pair a device** and scan the QR
code. The invite works once and expires in two minutes. Later, the owner can
separately revoke that device from the same menu. The QR deployment uses an
ordinary HTTPS origin. See [trusted-device pairing](device-pairing/README.md)
to prepare the companion and ingress.

Open the [private Tailscale owner page](tailscale-owner/README.md) from a
connected Mac to view, pair, or revoke devices using your Tailscale login.
Use the public editor URL on paired devices, including phones without
Tailscale.

## Sign in from any device

The account gateway uses Caddy, OAuth2 Proxy, and the companion's session
bootstrap. An ordinary browser can reach the public HTTPS entrance. Only listed
accounts can read or edit workspace data, including through the API and terminal.
See [account gateway setup](account-gateway/README.md) for the service and OAuth configuration.

## Use Lattice-web-ui on iPhone Duo

Open the workspace HTTPS address in Safari and pair the device. To install it
as a web app, use **Install** inside the workspace, or use Safari's
**Share → Add to Home Screen** and enable **Open as Web App** if shown.
Safari 17.2 and later copy the pairing cookies when the app is added.
On desktop, use your browser's corresponding web app install command.

The outer display shows a full-width
editor. Unfold to see the editor and PDF side by side, with your draft and cursor
position intact. When Safari is in a narrow Split View window, the editor uses
the single-pane layout. The mobile toolbar can open the PDF or project files
directly.

The layout is served by the Linux companion. To upgrade an existing server,
build the current source kit and rerun the companion installer with your existing
workspace and service settings. The Mac plugin keeps using the same URL.

## Run the Linux companion

The companion runs independently of the Mac and uses the previously integrated
headless Lattice implementation. It supports editing, LaTeX builds, PDF preview,
and the CLI. The versioned source kit includes the pinned server and web source,
the existing systemd/Tailscale installer, and the optional Codex runtime tooling.

On the Linux host, install Node 22, pnpm 10.13.1, Rust (see
`source/rust-toolchain.toml`), a C/C++ toolchain, Python 3, and LaTeX with
`latexmk`. For Tailscale access, join the authorized tailnet on the host.
Extract the source kit and build it:

```bash
tar -xzf lattice-remote-source-0.4.0.tar.gz
cd lattice-remote-source-0.4.0
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

## Development and releases

The local commit hook checks the staged patch and runs the plugin tests.
Enable it in a new clone with `git config core.hooksPath .githooks`.

1. Describe the requested behavior and acceptance criteria in an issue. The
   repository owner can add `agent-ready` to request one bounded implementation
   attempt. The workflow proposes changes to the plugin, tests, or documentation
   and opens a PR for review.
2. PR CI runs deterministic checks. Packaging-sensitive changes also exercise
   the release archive. The advisory AI review runs separately and reports what
   it reviewed on the exact PR head. Keep decisions and verification on the PR.
3. Bump the plugin version before releasing. An approved `vX.Y.Z` tag builds
   the plugin archive and pinned companion source kit, then publishes a GitHub
   prerelease. Promote the existing prerelease after verification. Keep the
   published artifacts from the previous release for rollback.

Issue implementation uses a project-scoped `OPENAI_API_KEY` in the
`agent-implementation` GitHub Environment, limited to `main`. This
repository uses native Codex PR review with `LATTICE_REVIEW_PROVIDER=codex`.
With a separate GitHub Actions reviewer, configure the `agent-review`
environment and its own key. Local checks, PR CI, and release builds use no
model key.

The companion source is pinned to an immutable commit in the
`companion/0.4.0` snapshot branch. Record the upstream source revision when
importing a new snapshot. Keep the packaged source and the deployable host
build distinct. A GitHub release publishes the package. The 5090 service is
updated through its own deployment process.
