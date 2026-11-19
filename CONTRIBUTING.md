# Contributing to Lattice-web-ui

Bug fixes, docs, and small improvements are welcome. For a larger change,
open an issue first so we can agree on where it belongs and how to test it.

## Report a bug

In [Issues](https://github.com/knightnemo/lattice-web-ui/issues), include what
you expected, what happened, and the shortest steps to reproduce it. Note
your browser and OS and, if relevant, the plugin version, companion version,
and sign-in method. Use a sample project and remove tokens, pairing links,
private hostnames, and project content from screenshots and logs.

## Work on a change

- `plugin/` contains the Mac launcher. In Lattice, choose **Settings →
  Plugins → Install from folder…** and select that directory to try it.
- The Linux companion contains the browser editor and server. Its source is
  on a separate branch and pinned in [`automation/release-source.json`](automation/release-source.json).
  Make companion changes in the companion source, then propose a pin update here.

From a full clone, run the portable tests with Node 22, Python 3, and Git installed.

```sh
node --test test/*.test.mjs
```

If you change packaging or the companion pin, build the plugin ZIP and Linux
source kit and verify their checksums. See the [release guide](docs/releases.md)
for the commands.

## Open a pull request

Target `main` and keep the PR to one change. Describe what it fixes, link the
issue if there is one, and list what you tested, including skipped checks.
For visible changes, include a screenshot or short recording. For changes to
sign-in, pairing, or saved state, explain how existing installs are affected.

GitHub runs the required `Lattice CI passed` check before merge.
