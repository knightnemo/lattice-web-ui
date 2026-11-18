# Manage devices using Tailscale

Open the private owner address from a computer connected to Tailscale.
The configured owner can list, pair and revoke devices. A phone can scan
the QR code and open the existing public editor without joining Tailscale.
For another browser on your computer, open the pairing link once in that
browser. The editor remembers the resulting device credential.

The owner page authenticates each request through Tailscale Serve. The
gateway requests and renews its Lattice administrator session on the server.
The browser receives only the public pairing invitation when you create one.
Keep the existing server access token in private storage for recovery.

## Set up the private owner address

Run on Linux with a Tailscale daemon that supports Unix socket Serve targets.
Keep the existing HTTPS public editor and the Lattice companion with device
pairing enabled. Choose a separate, unused HTTPS port for the private page.
Use the Serve hostname and port exactly as they will appear in the browser.

Run the gateway as the user that can read the companion's access-token file.
Create a directory owned by that user with mode 0700. Put the exact owner
Tailscale login returned by Serve in a private file. The file contains one
login and a newline. Use the same paths on every restart.

```sh
owner_dir="$HOME/.local/share/lattice-owner"
install -d -m 700 "$owner_dir"
umask 077
printf '%s\n' 'owner@example.com' > "$owner_dir/owner-login"

python3 tailscale-owner/gateway.py \
  --socket "$owner_dir/owner.sock" \
  --private-origin https://host.example.ts.net:9443 \
  --public-origin https://workspace.example.com \
  --upstream-port 18493 \
  --owner-file "$owner_dir/owner-login" \
  --token-file "$HOME/.local/share/lattice-paired-workspace/access-token"
```

Run that process under your service manager for automatic restarts. Verify
the socket belongs to the gateway and is readable and writable only by its
owner. The gateway expects the Tailscale daemon to connect as root by default.
If your Tailscale daemon runs as an unprivileged container user, pass its
numeric UID with `--ingress-uid` and share the private socket with that user.

In another terminal, configure Tailscale Serve for that socket.

```sh
sudo tailscale serve --bg --https=9443 "unix:$owner_dir/owner.sock"
tailscale serve status
```

Keep this port private to the tailnet. Only the dedicated Unix socket should
receive Serve's identity headers. Keep the socket directory outside the
workspace and inaccessible to project processes. If you use containers,
share the socket mount with the trusted Tailscale daemon and gateway only.
Run the gateway in a network namespace where it can reach the companion
on the configured loopback port. The socket does not need to be mounted
in the companion or exposed over TCP.

From the configured owner's computer, open the private address, create an
invite, pair a test browser at the public editor, and revoke that browser
from the private address. An unlisted Tailscale user should receive a
forbidden response. After a gateway or companion restart, reopen the
private address and check the device list again.

To disable only this entry and leave other Serve routes in place, use
`sudo tailscale serve --https=9443 off` and stop the gateway process.

[Tailscale Serve and trusted identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)
