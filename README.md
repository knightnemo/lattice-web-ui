<div align="center">
  <img src="docs/assets/lattice-web-ui.png" alt="" width="96" height="96">
  <h1>Lattice-web-ui</h1>
  <p>Edit LaTeX and preview PDFs from your computer or phone, with the workspace running on a Linux host.</p>
  <p>
    <a href="#run-your-own-workspace"><img src="https://img.shields.io/badge/Host-Linux-4f6456" alt="Host platform Linux"></a>
    <a href="https://github.com/knightnemo/lattice-web-ui/blob/main/plugin/LICENSE"><img src="https://img.shields.io/badge/Mac_plugin-MIT-4f6456" alt="Mac plugin license MIT"></a>
    <a href="https://github.com/knightnemo/lattice-web-ui/blob/6fe84151f216df4057797a5e24982b4613c64868/README.md#license"><img src="https://img.shields.io/badge/Companion-License_notices-4f6456" alt="Companion license notices"></a>
  </p>
  <p>
    <a href="#open-a-workspace">Open in a browser</a> ·
    <a href="#add-a-shortcut-in-lattice-for-mac">Mac shortcut</a> ·
    <a href="#run-your-own-workspace">Host on Linux</a>
  </p>
</div>

## Open a workspace

Ask the workspace owner for its HTTPS address. Open it in a browser on your
computer or phone. For a paired workspace, scan the owner's QR code or open
the pairing link, check the hostname, and select **Connect this device**.
Each invite works once and expires after two minutes.

Bookmark the workspace address. A paired device can reconnect after a server
restart using the same browser profile or installed web app. On iPhone,
Safari's **Share → Add to Home Screen** adds the workspace to your Home Screen.

### Add a shortcut in Lattice for Mac

1. [Download the repository ZIP](https://github.com/knightnemo/lattice-web-ui/archive/refs/heads/main.zip)
   and unzip it somewhere you can keep it. Lattice runs folder installs in place.
2. In **Settings → Plugins → Install from folder…**, select
   `lattice-web-ui-main/plugin/` and enable **Lattice-web-ui**.
3. Press **⌘K** and run **Lattice-web-ui: Set workspace address…**. Enter only
   the HTTPS origin, such as `https://workspace.example.com`, including a port
   if needed. Use the workspace's permanent address after pairing.
4. Select the **Open remote workspace** result to launch your browser. Next
   time, use **⌘K → Lattice-web-ui: Open remote workspace** and select the result.

## Run your own workspace

Use a Linux host with an existing Lattice project. Building the host kit needs
Node 22, pnpm 10.13.1, the Rust toolchain pinned in `source/rust-toolchain.toml`,
and a C/C++ toolchain. Running the service needs Python 3, systemd user services,
and LaTeX with `latexmk` and a TeX engine to compile papers.

### Get the source kit

From a full Git clone, package the pinned companion source with Bash, Git,
`zip`, `tar`, and `shasum`. If you already have an extracted source kit,
skip to [Build the Linux host](#build-the-linux-host).

```sh
git clone https://github.com/knightnemo/lattice-web-ui.git
cd lattice-web-ui
bash scripts/package.sh "$PWD"
version=$(node automation/release-package.mjs version plugin/lattice-plugin.toml)
cd dist
tar -xzf "lattice-remote-source-$version.tar.gz"
cd "lattice-remote-source-$version"
```

### Build the Linux host

On the target Linux machine, run these commands from the extracted source kit.

```sh
./build-linux.sh
tar -xzf "lattice-remote-host-$(uname -m).tar.gz"
cd lattice-remote-host
```

### Connect over Tailscale

For a private workspace, join the host and client to your tailnet. Set up
[Tailscale operator access and the systemd user service](https://github.com/knightnemo/lattice-web-ui/blob/6fe84151f216df4057797a5e24982b4613c64868/docs/private-headless-deployment.md).
From the extracted host kit, substitute the paths to your existing workspace
directory and the project inside it.

```sh
python3 scripts/install-headless-service.py \
  --binary ./lattice-server --assets ./web \
  --workspace-root "$HOME/lattice-workspaces" \
  --project "$HOME/lattice-workspaces/paper" \
  --port 18482 --https-port 8443 --tailscale
```

Open the HTTPS address shown by `tailscale serve status`. Sign in with the
token in `~/.local/share/lattice-headless/access-token` on the host. Sign in
again after the companion restarts.

### Connect from outside the tailnet

- [Device pairing](device-pairing/README.md) lets an owner invite a trusted browser with a QR code or link and revoke it later. Owners can use the [private Tailscale owner page](tailscale-owner/README.md) to manage devices.
- [Account sign-in](account-gateway/README.md) lets approved email addresses sign in through an OAuth gateway.

For the optional Codex runtime, follow the [agent setup guide](https://github.com/knightnemo/lattice-web-ui/blob/6fe84151f216df4057797a5e24982b4613c64868/docs/headless-agent.md)
or read `docs/headless-agent.md` in the built host kit.

## Contribute

See the [contributing guide](https://github.com/knightnemo/lattice-web-ui/blob/main/CONTRIBUTING.md)
for local tests and pull requests, or the [release guide](docs/releases.md)
for packaging and publishing.

The [Mac plugin is MIT-licensed](https://github.com/knightnemo/lattice-web-ui/blob/main/plugin/LICENSE).
The companion archive includes the original source licenses and notices.
