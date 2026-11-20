# Releases

Download the plugin and the Linux host kit from
[GitHub Releases](https://github.com/lattice-writer/lattice-web-ui/releases).
Each release has these four assets.

| File | Use it for |
| --- | --- |
| `remote-workspace-X.Y.Z.zip` | Install the plugin in Lattice's **Settings → Plugins → Install from URL…** with the ZIP URL and its SHA-256. |
| `lattice-remote-host-X.Y.Z-linux-x86_64.tar.gz` | Run Lattice on a Linux host with `lattice-host install` ([host guide](../host/README.md)). |
| `SHA256SUMS-vX.Y.Z.txt` | Check the two downloads with `sha256sum -c` or `shasum -a 256 -c`. |
| `release-vX.Y.Z.json` | Identify the exact release commit, the Lattice releases the kit is pinned to, and the asset hashes. |

The [Release workflow](https://github.com/lattice-writer/lattice-web-ui/blob/main/.github/workflows/release.yml)
passes the verified files from build to publishing through a temporary
Actions artifact. Install from the release assets.

## What a release contains

- **The plugin** opens the workspace and its device page from Lattice's
  command palette. Its plugin ID stays `io.github.knightnemo.lattice-remote`.
- **`lattice-gateway`** is a static Rust binary that pairs devices, signs in
  the owner and forwards everyone else's requests to Lattice's browser host.
- **`lattice-host`** installs and updates Lattice on the host.
- **`lattice-releases.json`** pins the Lattice AppImages this kit is tested
  with. Each pin is a version, its GitHub release URL and its SHA-256.

Lattice itself is not rebuilt or modified. The host runs the AppImage that
leo1oel/lattice publishes, after checking it against the pin.

## Move a host to a new Lattice release

1. In a PR, add the release to `host/lattice-releases.json`. Download the
   AppImage, compute its hash with `sha256sum`, and make it the `default`.
   Describe what you tried in the browser on that release.
2. Release the kit, as described below.
3. On each host, extract the new kit and run `./lattice-host update`. Lattice
   restarts on the new release. If it does not answer within 90 seconds,
   `update` switches back to the previous one. Paired devices and the token
   stay as they are. `./lattice-host rollback` returns to the previous release
   at any time.

## Build a preview

From the repository root, run the following. The ZIP, the host kit and their
checksums are written to `dist/`.

```sh
cargo test --manifest-path gateway/Cargo.toml
python3 test/host_kit.py
cargo build --release --manifest-path gateway/Cargo.toml
LATTICE_GATEWAY_BINARY="$PWD/gateway/target/release/lattice-gateway" node --test test/*.test.mjs
bash scripts/package.sh
```

To run the same checks on GitHub without publishing, open
**Actions → Release → Run workflow** on `main` and choose **verify**. The
verified bundle stays on that run for 14 days.

## Publish a release

1. Set the next version in [the plugin manifest](https://github.com/lattice-writer/lattice-web-ui/blob/main/plugin/lattice-plugin.toml)
   and merge the change to `main`. The Release job on `main` updates its notes
   summary with the changes since the latest stable release.
2. Tag the merged commit with the manifest version prefixed by `v`, then push
   the tag.

   ```sh
   git switch main
   git pull --ff-only
   tag="v$(node automation/release-package.mjs version plugin/lattice-plugin.toml)"
   git tag -a "$tag" -m "$tag"
   git push origin "$tag"
   ```

3. Check the published prerelease and install its assets. A repository
   administrator can then run **Actions → Release → Run workflow** on `main`,
   choose **promote** and enter that tag. The workflow checks the account's
   current repository role. It verifies the commit, the manifest digest and the
   uploaded asset checksums before marking that same release stable.

Keep the previous stable release available for rollback. Publishing a release
only publishes downloads. Each host is updated separately with `lattice-host`.

## Repository rules

- Protect `main` with required PRs, `Lattice CI passed`, and restrictions on
  force pushes and deletion. Use short-lived branches and let GitHub delete
  them after merge.
- Keep the existing `companion/*` tags. Releases up to v0.4.7 were built
  from them.
- Keep agent proposals in draft PRs and AI reviews advisory. The required
  checks run without publishing credentials. A maintainer decides what to
  merge, when to tag a prerelease, and when to promote that build to stable.
