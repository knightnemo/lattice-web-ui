<div align="center">
  <img src="gateway/assets/brand/logo.svg" alt="" width="96" height="96">
  <h1>Lattice-web-ui</h1>
  <p>Use the Lattice on your Linux machine from your phone, tablet or another computer.</p>
  <p>
    <a href="https://github.com/lattice-writer/lattice-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/lattice-writer/lattice-web-ui?color=4f6456" alt="Latest stable release"></a>
    <a href="host/README.md"><img src="https://img.shields.io/badge/Host-Linux-4f6456" alt="Host platform Linux"></a>
    <a href="https://github.com/lattice-writer/lattice-web-ui/blob/main/plugin/LICENSE"><img src="https://img.shields.io/badge/License-MIT-4f6456" alt="License MIT"></a>
  </p>
</div>

Lattice-web-ui is a plugin for [Lattice](https://github.com/leo1oel/lattice). It
runs the real Lattice on a Linux host, with your projects, TeX and agent CLIs, and
lets the devices you pair open it in a browser. The browser talks to Lattice
itself, so it gets what Lattice offers on Linux, minus the
[known limits](host/README.md#known-limits).

```
phone / laptop ── HTTPS ── lattice-gateway ── Lattice (browser-host mode) on your Linux host
```

- **Lattice, unmodified.** The host runs Lattice's own Linux AppImage,
  checked against a pinned SHA-256. A Lattice update reaches the browser
  without anyone porting code.
- **One window, nothing added.** Every project opens in the same Lattice
  window. Apart from sign-in, there is no page or control that is not Lattice.
- **Updates from the workspace.** A new release shows up as a Lattice
  notification for the owner. Select **Update**, and the host updates itself,
  and goes back if the new version does not start.
- **Sign-in as in v0.4.x.** On your tailnet, Tailscale vouches for you and
  Lattice opens directly. From the internet, the owner signs in with the access
  token and phones pair by scanning a QR code.

## Watch the film

*One Lattice, Every Screen* (2:13) follows a paper from a phone edit to a
PDF built on the Linux host. It shows Tailscale access, device pairing and
revocation, the phone layout, handing the workspace to another screen, and
updating the host from the browser.

https://github.com/user-attachments/assets/07c4b86b-2a65-447f-a107-54e75da1877e

[English transcript and film credits](https://github.com/lattice-writer/lattice-web-ui/blob/main/docs/one-lattice-every-screen.md)

## Open a workspace

Open the workspace's HTTPS address. The first time, either sign in with the
owner token or open a pairing link from the owner. A pairing link works once
and expires after two minutes. After that, the browser stays signed in for 90
days. On iPhone, use Safari's **Share → Add to Home Screen** to open it like
an app.

### Add the commands to Lattice

1. Open the [latest release](https://github.com/lattice-writer/lattice-web-ui/releases/latest)
   and copy the URL of `remote-workspace-X.Y.Z.zip`. In **Settings → Plugins →
   Install from URL…**, enter that URL and its SHA-256 from the release's
   checksum file. Enable **Lattice-web-ui**.
2. In the command palette, run **Lattice-web-ui: Set workspace address…** and
   enter the workspace's HTTPS address.
3. Run **Lattice-web-ui: Open remote workspace** to open it, or **Pair or revoke
   devices** to manage the devices that can reach it.

## Run your own workspace

You need a Linux x86-64 machine with systemd, Xvfb, TeX with `latexmk`, and an
HTTPS entrance such as Tailscale Serve. Download
`lattice-remote-host-X.Y.Z-linux-x86_64.tar.gz` from
[Releases](https://github.com/lattice-writer/lattice-web-ui/releases), then:

```sh
tar -xzf lattice-remote-host-X.Y.Z-linux-x86_64.tar.gz
cd lattice-remote-host-X.Y.Z
./lattice-host install --tailscale --owner-login you@github \
  --public-origin https://your-machine.example.ts.net:8443 \
  --agent-origin https://your-machine.example.ts.net:10000 --projects-root ~/lattice-projects
tailscale funnel --bg --https=8443  unix:$HOME/.local/share/lattice-host/serve.sock
tailscale funnel --bg --https=10000 unix:$HOME/.local/share/lattice-host/agent.sock
```

On your tailnet the address opens Lattice directly. From anywhere else, sign
in with the token from `~/.local/share/lattice-host/access-token`, or pair a
phone from **Phone and app** in Lattice's Settings. The [host guide](host/README.md) covers Funnel
and Serve, Overleaf, Caddy without Tailscale, updates and rollback.

## Contribute

See the [contributing guide](CONTRIBUTING.md) for tests and pull requests, and
the [release guide](docs/releases.md) for packaging and publishing. Report bugs
in the editor itself to [Lattice](https://github.com/leo1oel/lattice/issues).

Versions up to 0.4.7 shipped a separate copy of the Lattice editor and server,
built from `companion/*` snapshot tags. Starting with 0.5.0, the host runs
Lattice itself, and those tags are kept only so the old releases can still be
rebuilt.

## License

Everything in this repository is MIT-licensed ([plugin/LICENSE](plugin/LICENSE)).
lattice-gateway embeds the [Inter](https://github.com/rsms/inter) typeface, under the SIL Open Font License 1.1
([gateway/assets/vendor/LICENSE-inter](gateway/assets/vendor/LICENSE-inter)).
Lattice, which the host kit downloads at install time, keeps its own license.
