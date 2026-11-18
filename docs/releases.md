# Releases

Download the Mac plugin and Linux companion source kit from [GitHub Releases](https://github.com/knightnemo/lattice-web-ui/releases).
Each release has these four assets.

| File | Use it for |
| --- | --- |
| `remote-workspace-X.Y.Z.zip` | Install the launcher from Lattice's Plugins settings. |
| `lattice-remote-source-X.Y.Z.tar.gz` | Build the Linux host kit on the target architecture. |
| `SHA256SUMS-vX.Y.Z.txt` | Check the two downloads with `shasum -a 256 -c` or `sha256sum -c`. |
| `release-vX.Y.Z.json` | Identify the exact release commit, companion snapshot, and asset hashes. |

The [Release workflow](https://github.com/knightnemo/lattice-web-ui/blob/main/.github/workflows/release.yml) uses a temporary
Actions artifact to pass the verified files from build to publishing. Install
from the release assets. GitHub Packages and GHCR publishing are not configured.

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

## Publish a release

1. Set the next version in [the plugin manifest](https://github.com/knightnemo/lattice-web-ui/blob/main/plugin/lattice-plugin.toml)
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
