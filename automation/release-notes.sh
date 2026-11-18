#!/usr/bin/env bash
set -euo pipefail

commit="${1:?Provide the release or default branch commit.}"
base="${2:-}"
printf '%s\n\n' '## Changes'
if [[ -n "$base" ]] && git show-ref --verify --quiet "refs/tags/$base" && git merge-base --is-ancestor "refs/tags/$base" "$commit"; then
  git log --first-parent --format='- %s (%h)' "refs/tags/$base..$commit"
else
  git log --first-parent --format='- %s (%h)' "$commit"
fi
