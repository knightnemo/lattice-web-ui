# Releases

Download the Mac plugin and Linux companion source kit from [GitHub Releases](https://github.com/lattice-writer/lattice-web-ui/releases).
Each release has these four assets.

| File | Use it for |
| --- | --- |
| `remote-workspace-X.Y.Z.zip` | Install the launcher from Lattice's Plugins settings. |
| `lattice-remote-source-X.Y.Z.tar.gz` | Build the Linux host kit on the target architecture. |
| `SHA256SUMS-vX.Y.Z.txt` | Check the two downloads with `shasum -a 256 -c` or `sha256sum -c`. |
| `release-vX.Y.Z.json` | Identify the exact release commit, companion snapshot, and asset hashes. |

The [Release workflow](https://github.com/lattice-writer/lattice-web-ui/blob/main/.github/workflows/release.yml) uses a temporary
Actions artifact to pass the verified files from build to publishing. Install
from the release assets. GitHub Packages and GHCR publishing are not configured.

## Check for a host update

Run the check from the extracted Linux host or source kit.

```sh
python3 ./check-host-update.py
```

The command reads the kit's `release-version.txt` and checks the latest
published stable release on GitHub. Run it from the kit serving your workspace.
For an older kit, run the helper from a newer checkout with
`--installed-version X.Y.Z`, using the version in your installed source archive's
name. A connection or rate-limit error exits with status 1 so you can retry.

### Schedule checks for the Linux host

Run the following once, as the unprivileged account that owns the host kit.
Keep the extracted kit at this path while its timer is enabled.

```sh
python3 ./check-host-update.py --install-timer
systemctl --user list-timers lattice-host-update.timer
journalctl --user -u lattice-host-update.service
```

The user timer checks about one minute after activation and every 15 minutes
while the user manager is running, with up to 30 seconds of jitter. Run the
ordinary check command above for an immediate result. Each scheduled check has
a 60-second deadline. Its
journal reports available updates. The last successful result is also stored
in `$XDG_STATE_HOME/lattice-web-ui/lattice-host-update.json` (by default
`~/.local/state/lattice-web-ui/lattice-host-update.json`). A failed network or
release check preserves that result.

To make the same version information available to the web client, explicitly
select the existing web asset directory passed to the companion's `--assets`
option. The standard extracted host kit uses its writable `web` directory.

```sh
python3 ./check-host-update.py --install-timer --public-status-dir ./web
```

The timer atomically publishes `lattice-host-update.json` at that directory's
root. The file is readable by anyone with access to the hosted assets. It
contains exactly the three fields below.

```json
{"schema": 1, "installedVersion": "0.4.3", "latestVersion": "0.5.0"}
```

`latestVersion` is null when GitHub reports no published stable release.
Re-run installation from the new kit after deploying a host update. To remove
the timer and its check service, use the following command.

```sh
python3 ./check-host-update.py --uninstall-timer
```

To withdraw a previously published result, remove `lattice-host-update.json`
from the asset directory you selected. The workspace service continues running
through installation and removal.

### Prepare a verified source kit

To prepare a newer release, choose a staging directory on the build host.

```sh
python3 ./check-host-update.py --prepare "$HOME/lattice-updates"
```

The command downloads the Linux source kit, checks its size and SHA-256 against
GitHub's release assets, and prints the verified archive path. A current or newer
installation needs no download. An existing staged archive stays in place if
you repeat the command. No reader's browser contacts GitHub for this check.

Extract the verified archive in a fresh build directory. Substitute the
printed version for `X.Y.Z`.

```sh
version=X.Y.Z
build_dir="$(mktemp -d)"
tar -xzf "$HOME/lattice-updates/lattice-remote-source-$version.tar.gz" -C "$build_dir"
cd "$build_dir/lattice-remote-source-$version"
./build-linux.sh
```

The host kit in this directory is ready for a separately scheduled rollout.
Keep the current binary, web assets, service settings and project data in place
while building and testing the candidate.

## Build a preview

In a full checkout, run the following from the repository root to create the
ZIP, source kit, and local checksums in `dist/`.

```sh
node --test test/*.test.mjs
bash scripts/package.sh "$PWD"
```

To run the same package checks on GitHub without publishing, open
**Actions → Release → Run workflow** on `main` and choose **verify**. The
verified bundle is available on that run for 14 days.

## Update the companion

The Linux companion is imported as a snapshot. The
[source pin](https://github.com/lattice-writer/lattice-web-ui/blob/main/automation/release-source.json)
records the upstream commit, the imported commit, its tree, and the
`companion/vX.Y.Z` tag that keeps the imported commit available.

1. Verify the imported commit has the same tree as the upstream commit.
2. Publish a new lightweight tag on the imported commit. Set `version` to the
   companion version and `snapshot` to its full imported commit SHA.

   ```sh
   git tag --no-sign "companion/v$version" "$snapshot"
   git push origin "refs/tags/companion/v$version"
   ```

3. Update the source pin in a PR and describe how you tested it with the
   current plugin. CI checks the PR's exact pin against the tag and builds
   both packages. Keep earlier tags so older releases can still be rebuilt.

If you have a shallow clone, run `git fetch origin tag TAG` before building
the kit, using the value of `snapshotTag` from the source pin for `TAG`.

## Publish a release

1. Set the next version in [the plugin manifest](https://github.com/lattice-writer/lattice-web-ui/blob/main/plugin/lattice-plugin.toml)
   and merge the change to `main`. The Release job on `main` updates its notes
   summary with changes since the latest stable release.
2. Tag the merged commit with the exact manifest version prefixed by `v`, then
   push the tag.

   ```sh
   git switch main
   git pull --ff-only
   tag="v$(node automation/release-package.mjs version plugin/lattice-plugin.toml)"
   git tag -a "$tag" -m "$tag"
   git push origin "$tag"
   ```

3. Check the published prerelease and install or build its assets. When ready,
   the repository owner can run **Actions → Release → Run workflow** on
   `main`, choose **promote**, and enter that tag. The workflow verifies the
   commit, manifest digest, and uploaded asset checksums, then marks the same
   release stable without rebuilding.

Keep the previous stable release available for rollback. Releasing on GitHub
publishes downloads. Roll out a new companion build on each host separately.

## Repository rules

- Protect `main` with required PRs, `Lattice CI passed`, and restrictions on
  force pushes and deletion. Use short-lived branches and let GitHub delete
  them after merge.
- Protect `refs/tags/companion/*` from updates and deletion. Review the tag
  and pin together before a maintainer merges a companion update.
- Keep agent proposals in draft PRs and AI reviews advisory. The required
  checks run without publishing credentials. A maintainer decides what to
  merge, when to tag a prerelease, and when to promote that build to stable.
