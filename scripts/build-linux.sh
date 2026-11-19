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
if [[ -d "$root/tailscale-owner" ]]; then
  cp -R "$root/tailscale-owner" "$kit/tailscale-owner"
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
if [[ ! -f "$root/check-host-update.py" || -L "$root/check-host-update.py" ]]; then
  echo 'Expected a regular host update helper.' >&2
  exit 1
fi
if [[ -f "$root/release-version.txt" && ! -L "$root/release-version.txt" ]]; then
  kit_version="$(cat "$root/release-version.txt")"
  release_guide="$root/docs/releases.md"
elif [[ -f "$root/../plugin/lattice-plugin.toml" ]]; then
  release_guide="$root/../docs/releases.md"
  # The build script also accepts an explicit companion source from a repository checkout.
  kit_version="$(node "$root/../automation/release-package.mjs" version "$root/../plugin/lattice-plugin.toml")"
else
  echo 'Expected a release version in the source kit.' >&2
  exit 1
fi
if ! [[ "$kit_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Expected a release version in X.Y.Z format.' >&2
  exit 1
fi
printf '%s\n' "$kit_version" > "$kit/release-version.txt"
cp "$root/check-host-update.py" "$kit/"
if [[ ! -f "$release_guide" || -L "$release_guide" ]]; then
  echo 'Expected a regular host release guide.' >&2
  exit 1
fi
cp "$release_guide" "$kit/docs/"
tar -czf "$out" -C "$stage" lattice-remote-host
printf '%s\n' "$out"
