#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
source_dir="${1:-$root/source}"
out="${2:-$root/lattice-remote-host-$(uname -m).tar.gz}"
if [[ $(uname -s) != Linux ]]; then
  printf '%s\n' 'Build the host on the intended Linux architecture.' >&2
  exit 1
fi
if [[ ! -f "$source_dir/server/Cargo.lock" || ! -f "$source_dir/scripts/install-headless-service.py" ]]; then
  printf '%s\n' 'Pass the extracted companion source directory as the first argument.' >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
kit="$stage/lattice-remote-host"
mkdir -p "$kit/scripts" "$kit/docs"
export CARGO_TARGET_DIR="$stage/cargo-target"
(
  cd "$source_dir"
  pnpm install --frozen-lockfile
  pnpm build
  cargo build --locked --release --manifest-path server/Cargo.toml
)
install -m 755 "$CARGO_TARGET_DIR/release/lattice-server" "$kit/lattice-server"
cp -R "$source_dir/dist" "$kit/web"
cp -R "$source_dir/licenses" "$kit/licenses"
if [[ -d "$root/account-gateway" ]]; then
  cp -R "$root/account-gateway" "$kit/account-gateway"
fi
if [[ -d "$root/device-pairing" ]]; then
  cp -R "$root/device-pairing" "$kit/device-pairing"
fi
for file in LICENSE NOTICE THIRD_PARTY_NOTICES.md; do
  cp "$source_dir/$file" "$kit/"
done
for file in install-headless-service.py prepare-headless-agent.mjs patch-headless-agent.mjs synara-runtime.json; do
  cp "$source_dir/scripts/$file" "$kit/scripts/"
done
for file in headless-server.md headless-agent.md private-headless-deployment.md; do
  cp "$source_dir/docs/$file" "$kit/docs/"
done
if [[ -f "$root/source-revision.txt" ]]; then
  cp "$root/source-revision.txt" "$kit/"
fi
tar -czf "$out" -C "$stage" lattice-remote-host
printf '%s\n' "$out"
