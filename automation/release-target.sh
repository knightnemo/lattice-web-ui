#!/usr/bin/env bash
set -euo pipefail

tag="${1:?Provide the release tag.}"
expected="${2:-}"
test "${DEFAULT_BRANCH:?Missing the repository default branch.}"
if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  printf '%s\n' "Release tags must use vX.Y.Z." >&2
  exit 1
fi
commit="$(git rev-parse --verify "refs/tags/$tag^{commit}")"
if [[ -n "$expected" ]] && [[ "$commit" != "$(git rev-parse --verify "$expected^{commit}")" ]]; then
  printf '%s\n' "The tag changed since this release was triggered." >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$commit" "refs/remotes/origin/$DEFAULT_BRANCH"; then
  printf '%s\n' "Release tags must point at a commit already on the default branch." >&2
  exit 1
fi
printf '%s\n' "$commit"
