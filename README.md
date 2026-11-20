<div align="center">
  <img src="docs/assets/lattice-web-ui.png" alt="" width="96" height="96">
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

- **Lattice, unmodified.** The host runs the Linux AppImage that Lattice publishes,
  checked against a pinned SHA-256. A Lattice update reaches the browser
  without anyone porting code.
- **You decide who connects.** `lattice-gateway` lets in the owner, signed in
  with a recovery token or vouched for by Tailscale, and browsers paired with
  a one-time QR code. Revoking a device cuts it off at once.
- **The parts Linux lacks.** The gateway serves Lattice's Agent on an origin
  of its own. It lets the owner use Lattice's native windows (Overleaf
  sign-in) from the browser, installs missing TeX packages with `tlmgr`, and
  opens projects without the native folder dialog.
- **A command in Lattice.** The plugin opens the workspace and its device page
  from Lattice's command palette.

## Watch the setup film

*The Line Stays* (5:59) follows one workspace from its Linux host to a second Mac
and a paired iPhone. It shows how to install the plugin, add the web app to the
Dock or Home Screen, and keep an unsaved edit when the phone unfolds.

https://github.com/user-attachments/assets/8052b304-7d79-45c5-91cb-7ac2d459ffd0

[English transcript and film credits](https://github.com/lattice-writer/lattice-web-ui/blob/main/docs/the-line-stays.md)

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
./lattice-host install --public-origin https://your-machine.example.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:18490
```

Then open the address, sign in with the token from
`~/.local/share/lattice-host/access-token`, and pair your phone from
**Devices**. The [host guide](host/README.md) covers the owner page on
Tailscale, Caddy without Tailscale, updates and rollback.

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
Lattice, which the host kit downloads at install time, keeps its own license.
