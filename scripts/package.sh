#!/usr/bin/env bash
# Build the release assets: the Lattice plugin ZIP and the Linux host kit.
#
#   bash scripts/package.sh [out-dir]
#
# LATTICE_GATEWAY_BINARY may name a prebuilt lattice-gateway; otherwise it is
# built here with the pinned Rust toolchain.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd -P)"
out="${1:-$root/dist}"
version="$(node "$root/automation/release-package.mjs" version "$root/plugin/lattice-plugin.toml")"
arch="$(uname -m)"
[[ "$arch" == x86_64 ]] || { echo "The host kit is built and tested on x86_64 only (Lattice publishes an amd64 AppImage)." >&2; exit 1; }

gateway="${LATTICE_GATEWAY_BINARY:-}"
if [[ -z "$gateway" ]]; then
  cargo build --release --locked --manifest-path "$root/gateway/Cargo.toml"
  gateway="$root/gateway/target/release/lattice-gateway"
fi
[[ -f "$gateway" && ! -L "$gateway" ]] || { echo "Expected a regular lattice-gateway binary: $gateway" >&2; exit 1; }

mkdir -p "$out"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
name="lattice-remote-host-$version"
kit="$stage/$name"
mkdir -p "$kit/bin" "$kit/examples"
install -m 755 "$gateway" "$kit/bin/lattice-gateway"
install -m 755 "$root/host/lattice-host.py" "$kit/lattice-host"
for file in lattice-releases.json README.md; do
  [[ -f "$root/host/$file" && ! -L "$root/host/$file" ]] || { echo "Expected a regular host file: host/$file" >&2; exit 1; }
  install -m 644 "$root/host/$file" "$kit/$file"
done
install -m 644 "$root/host/examples/Caddyfile" "$kit/examples/Caddyfile"
install -m 644 "$root/plugin/LICENSE" "$kit/LICENSE"
# lattice-gateway embeds xterm.js for the owner's terminal.
install -m 644 "$root/gateway/assets/vendor/LICENSE-xterm" "$kit/LICENSE-xterm"
printf '%s\n' "$version" > "$kit/release-version.txt"
tar --owner=0 --group=0 --numeric-owner -czf "$out/$name-linux-$arch.tar.gz" -C "$stage" "$name"

node "$root/scripts/pack-plugin.mjs" "$root/plugin" "$out/remote-workspace-$version.zip" >/dev/null
(
  cd "$out"
  if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
  "${sum[@]}" "remote-workspace-$version.zip" "$name-linux-$arch.tar.gz" > SHA256SUMS
)
printf '%s\n' "$out/remote-workspace-$version.zip" "$out/$name-linux-$arch.tar.gz"
