#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
source_checkout="${1:-$root/../lattice-integrated}"
revision=7664d1ab46f63dbaccc7e9aa4deea2561da174d0
version=0.4.0
out="$root/dist"

if ! git -C "$source_checkout" cat-file -e "$revision^{commit}"; then
  printf '%s\n' "Missing headless source commit $revision in $source_checkout." >&2
  exit 1
fi

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
mkdir -p "$kit/test"
cp "$root/test/account-gateway.test.mjs" "$kit/test/"
printf '%s\n' "$revision" > "$kit/source-revision.txt"

node "$root/scripts/pack-plugin.mjs" "$root/plugin" "$out/remote-workspace-$version.zip"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out/lattice-remote-source-$version.tar.gz" -C "$stage" "lattice-remote-source-$version"
(cd "$out" && shasum -a 256 "remote-workspace-$version.zip" "lattice-remote-source-$version.tar.gz" > SHA256SUMS)
printf '%s\n' "$out/lattice-remote-source-$version.tar.gz"
