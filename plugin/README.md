# Lattice-web-ui

Lattice-web-ui is an independent macOS plugin that opens your self-hosted
Lattice workspace from the command palette. It requires a running Linux
companion. See the [workspace setup guide][setup] to deploy one or ask your
workspace owner for its HTTPS address.

1. Run **Lattice-web-ui: Set workspace address…** and enter the workspace's
   HTTPS address. Use the hostname and port shown by your host, if it specifies a port.
2. Run **Lattice-web-ui: Open remote workspace** and select the result to open
   the workspace in your browser. Follow your workspace's sign-in flow there.

## Permissions and data

The plugin saves the address in its own local data directory and uses
Lattice's `openUrl` action to open it in your browser. It requests no project
access, network origins, loopback ports, or secrets. It does not read or send
project contents. Your browser handles the connection and any sign-in.

[setup]: https://github.com/lattice-writer/lattice-web-ui#run-your-own-workspace
