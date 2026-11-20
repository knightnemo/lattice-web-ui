# Lattice host kit

Run the real Lattice on a Linux machine and open it from your phone, tablet or
another computer. The kit runs Lattice's own Linux AppImage in its built-in
browser-host mode, on a private virtual display, and the browser talks to
that Lattice directly. `lattice-gateway` sits in front of it and lets in only
the browsers you pair and the owner.

```
browser ── HTTPS ── Tailscale Serve or Caddy ── lattice-gateway ── Lattice (browser host, 127.0.0.1:18452)
```

## Requirements

- Linux on x86-64 with systemd user services. Run `loginctl enable-linger "$USER"`
  once so the services keep running after you log out.
- Xvfb (`sudo apt install xvfb`). Without sudo, `--fetch-xvfb` unpacks Ubuntu's
  package into the host directory instead.
- `dbus-run-session` (package `dbus`) and the WebKitGTK 4.1 runtime that Lattice's
  AppImage uses (`libwebkit2gtk-4.1-0`).
- TeX with `latexmk` if you compile on this machine. Agent CLIs such as Claude
  Code or Codex must be signed in for the same user.
- An HTTPS entrance: Tailscale Serve, or Caddy with a public hostname.

## Install

From the extracted kit:

```sh
./lattice-host install --public-origin https://workspace.example.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:18490
```

`install` downloads the Lattice release pinned in `lattice-releases.json` and
checks its SHA-256 before anything runs. It also writes and starts three
systemd user services:

| Service | What it runs |
|---|---|
| `lattice-display` | Xvfb on display `:99`, with no TCP listener |
| `lattice-browser-host` | Lattice with `--browser-host`, in a scrubbed environment with its own session bus, so it never touches your desktop session |
| `lattice-gateway` | The access gateway on `127.0.0.1:18490` |

Lattice keeps its settings under `~/.local/share/lattice-host/state`, away
from any Lattice desktop installation. Its `HOME` is yours by default, so
agent CLIs stay signed in. Pass `--home` to use another one.

## Sign in and pair devices

1. Open the public origin and sign in with the owner token. The token is in
   `~/.local/share/lattice-host/access-token`.
2. Open **Devices** at `/__gateway/devices` and select **Pair a device**.
3. Scan the QR code with the phone, check the hostname, name the device and
   select **Connect this device**.

Each invite works once and expires after two minutes. A paired browser stays
signed in for 90 days. **Revoke** cuts off that browser at once, including
its open connections. A paired device can use the workspace but cannot manage
devices.

### Optional: a private owner page on the tailnet

Tailscale can vouch for the owner, so no token is needed on the owner page:

```sh
./lattice-host install --public-origin https://workspace.example.ts.net \
  --owner-origin https://workspace.example.ts.net:9443 --owner-login you@example.com
tailscale serve --bg --https=9443 unix:$HOME/.local/share/lattice-host/owner.sock
```

The owner socket only manages devices. The gateway accepts identity headers
only from a connection made by root (tailscaled) or by `--ingress-uid`.

### Without Tailscale

`examples/Caddyfile` terminates TLS for a public hostname and forwards to the
gateway. Anyone on the internet can then reach the sign-in page. Treat the
host account as exposed: Lattice's terminal and agent run as that user.

## Open projects

Lattice's own "Open folder…" dialog appears on the host's hidden display,
where nobody can use it. Use the gateway's **Projects** page instead:

1. Pass `--projects-root ~/papers` (any folder) to `install`.
2. Open `/__gateway/projects`, or tap the small round button at the lower
   left of the workspace.
3. Pick a project. Lattice opens it with its own "open project" command, and
   the tab follows to it.

When you open a recent project from Lattice's title menu, Lattice tries to
open the new workspace in "the default browser". On the host, that request
goes to the gateway, and the tab you were just using follows it.

## How the page reaches you

Lattice 0.18's browser host only starts at `http://127.0.0.1:18452`. The
gateway rewrites ten loopback-only expressions in the page's scripts while
forwarding them, so that the same page runs at your HTTPS origin. Lattice on
disk is not changed. Each pinned release in `lattice-releases.json` lists how
many rewrites its page needs. `install` and `update` count them again on the
running Lattice and refuse a release whose page differs. The rewrite goes away
once Lattice accepts a public origin itself
([leo1oel/lattice#1190](https://github.com/leo1oel/lattice/issues/1190)).

## Update and roll back

```sh
./lattice-host status
./lattice-host update --to 0.19.0   # a version pinned in lattice-releases.json
./lattice-host rollback
```

`update` stages the new release next to the current one and restarts Lattice.
If Lattice does not answer within 90 seconds, `update` switches back to the
previous release. Paired devices and the token are kept across updates. To
stop everything, run `./lattice-host uninstall`. Add `--purge` to also delete
releases, paired devices and the token.

## Known limits

These come from Lattice 0.18 itself on Linux and from its browser host. They
are tracked in [leo1oel/lattice#1190](https://github.com/leo1oel/lattice/issues/1190).

- **Not on Linux yet:** the Agent, one-click TeX package installs, and the
  terminal in browser tabs. Install missing TeX packages on the host with
  `tlmgr` or your distribution.
- **Native windows:** these open on the hidden display and cannot be used.
  This covers "Open folder…" (use the Projects page instead) and Overleaf
  sign-in.
- **One tab per workspace:** a second tab or device on the same workspace
  takes it over. The first tab then says the workspace is open elsewhere.
  Reload it to get a workspace of its own.
- **Phone layout:** at phone width the editor is hard to reach. Reading the
  PDF works.
- **Unsaved text:** if Lattice restarts, text typed in the last second before
  the restart is lost. Autosave keeps the rest.
- **Memory:** every open workspace keeps a hidden WebKit view on the host,
  about 200 MB each.
