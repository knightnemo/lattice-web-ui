# Pair trusted devices with Remote Workspace

The owner signs in from a Mac using the server's access token and opens
**Devices → Pair a device**. Scan the QR code from the phone, check the displayed
workspace hostname, name the device, and select **Connect this device**. Copying
the pairing link gives the same flow on a computer without a camera. The invite
works once and expires after two minutes. Anyone who obtains the unused link
during that time can pair a device, so keep it private.

The server persists the device's credential digest for up to 90 days. The
browser holds the credential as a Secure, HttpOnly cookie. Its workspace session
can be restored when reopening the workspace, including after a server
restart. **Devices → Revoke** invalidates the chosen browser credential,
closes its sessions and terminals, and leaves other devices signed in.

This mode grants the current workspace capabilities to your own trusted
devices. A paired browser cannot manage the device list through the app.
The underlying workspace features include shell access as the server's OS
user. Run an internet-reachable instance in a dedicated, unprivileged service
account or VM with just the intended projects and tools, without personal SSH
keys, provider credentials or unrelated files. Device revocation prevents
future use of that credential and closes active Lattice sessions. Host changes
already made by a device still exist.

## Configure the Linux companion and HTTPS ingress

Keep the existing tailnet or account deployment on its current origin and data
directory. Use a separate public HTTPS hostname for paired browsers so login
cookies remain isolated. The same hostname can be reached from phones and
computers through a conventional HTTPS reverse proxy or a tunnel. The
companion and owner bootstrap also work behind a private HTTPS entrance when
client Tailscale is acceptable.

From the built host kit, choose a workspace and an unused loopback port.

```bash
origin=https://workspace.example.com
data_dir="$HOME/.local/share/lattice-paired-workspace"
python3 scripts/install-headless-service.py \
  --service-name lattice-paired-workspace --data-dir "$data_dir" \
  --binary ./lattice-server --assets ./web --port 18493 \
  --workspace-root "$HOME/lattice-workspaces" \
  --project "$HOME/lattice-workspaces/paper" \
  --public-origin "$origin" --device-pairing
```

Import the included Caddy site for the same origin. Set
`LATTICE_PAIRING_ORIGIN` to the HTTPS origin and `LATTICE_PAIRING_PORT` to the
loopback port (default `18493`). Configure DNS or your existing HTTPS ingress
to reach that site. Proxy the full hostname, including the event stream. Keep
the workspace backend on loopback. Supply the server access token to the
owner through its private file at `$data_dir/access-token`; the QR code and
paired browser never receive that token.

Open the public origin from a browser outside the tailnet to verify admission
and revocation before putting it into the Mac plugin. The account gateway and
the separate Agent origin are available in their own modes.

## Verify locally

Run from the source checkout with a built `lattice-server` and the compiled
web assets. The browser test starts Caddy with a scratch certificate and uses
isolated owner and phone browsers.

```bash
LATTICE_SERVER_BINARY=/path/to/lattice-server python3 server/tests/device_pairing.py

LATTICE_SERVER_BINARY=/path/to/lattice-server \
  LATTICE_WEB_ASSETS=/path/to/dist \
  LATTICE_PAIRING_CADDYFILE=/path/to/device-pairing/Caddyfile \
  CADDY_BINARY=/path/to/caddy \
  node server/tests/device-pairing.browser.mjs
```

Set `LATTICE_TEST_BROWSER=webkit` with Playwright WebKit installed for the
WebKit run. An optional `LATTICE_QR_DECODER` reads a screenshot path and returns
the decoded QR text, allowing the test to check the rendered code itself.
