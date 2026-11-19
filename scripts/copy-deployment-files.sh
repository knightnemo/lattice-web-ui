#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?Provide the template directory.}"
destination="${2:?Provide the package directory.}"
mode="${3:?Specify required or optional.}"
[[ "$mode" == required || "$mode" == optional ]] || exit 2

copy_group() {
  local group="$1" file
  shift
  if [[ "$mode" == optional && ! -e "$source_root/$group" && ! -L "$source_root/$group" ]]; then
    return
  fi
  if [[ ! -d "$source_root/$group" || -L "$source_root/$group" ]]; then
    printf 'Expected deployment directory: %s\n' "$group" >&2
    return 1
  fi
  mkdir -p "$destination/$group"
  for file in "$@"; do
    if [[ ! -f "$source_root/$group/$file" || -L "$source_root/$group/$file" ]]; then
      printf 'Expected regular deployment file: %s/%s\n' "$group" "$file" >&2
      return 1
    fi
    cp "$source_root/$group/$file" "$destination/$group/$file"
  done
}

copy_group account-gateway Caddyfile README.md oauth2-proxy.toml
copy_group device-pairing Caddyfile README.md
copy_group tailscale-owner README.md gateway.py index.html owner.css owner.js
