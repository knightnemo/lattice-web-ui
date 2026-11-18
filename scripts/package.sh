#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
source_checkout="${1:-$root/../lattice-integrated}"
out="${2:-$root/dist}"
release_package="$root/automation/release-package.mjs"
version="$(node "$release_package" version "$root/plugin/lattice-plugin.toml")"
source_pin="$(node "$release_package" source "$source_checkout")"
read -r revision original < <(printf '%s\n' "$source_pin" | paste -sd ' ' -)

mkdir -p "$out"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
kit="$stage/lattice-remote-source-$version"
mkdir -p "$kit"
git -C "$source_checkout" archive --prefix=source/ "$revision" | tar -xf - -C "$kit"
cp "$root/scripts/build-linux.sh" "$kit/build-linux.sh"
cp "$root/README.md" "$kit/README.md"
cp -R "$root/account-gateway" "$kit/account-gateway"
cp -R "$root/device-pairing" "$kit/device-pairing"
cp -R "$root/tailscale-owner" "$kit/tailscale-owner"
mkdir -p "$kit/test"
cp "$root/test/account-gateway.test.mjs" "$kit/test/"
printf '%s\n' "$original" > "$kit/source-revision.txt"

node "$root/scripts/pack-plugin.mjs" "$root/plugin" "$out/remote-workspace-$version.zip"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out/lattice-remote-source-$version.tar.gz" -C "$stage" "lattice-remote-source-$version"
(cd "$out" && shasum -a 256 "remote-workspace-$version.zip" "lattice-remote-source-$version.tar.gz" > SHA256SUMS)
printf '%s\n' "$out/lattice-remote-source-$version.tar.gz"
