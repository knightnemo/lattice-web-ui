# Lattice-web-ui

Lattice-web-ui opens the Lattice that runs on your Linux host from the command
palette, and pairs your other devices with it. The host runs Lattice's own
Linux release in browser-host mode behind an access gateway. See the
[host setup guide][setup] to set one up, or ask the workspace owner for its
HTTPS address.

1. Run **Lattice-web-ui: Set workspace address…** and enter the workspace's
   HTTPS address, including the port if your host uses one.
2. Run **Lattice-web-ui: Open remote workspace** and select the result to open
   the workspace in your browser. The first time, sign in with the owner token
   or open a pairing link from the owner.
3. Run **Lattice-web-ui: Phone and app** in the workspace. It opens a dialog
   with a QR code for the workspace's address, the steps to install the
   workspace as an app, a one-time pairing code for a phone outside your
   tailnet, and the paired devices, each with Revoke.

## Permissions and data

The plugin saves the address in its own local data directory and uses
Lattice's `openUrl` action to open it in your browser. It requests no project
access, network origins, loopback ports, or secrets. It does not read or send
project contents. Your browser handles the connection and any sign-in.

[setup]: https://github.com/lattice-writer/lattice-web-ui/blob/main/host/README.md
