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
- The Linux companion contains the browser editor and server. Make changes in
  the companion source, then propose a pin update here. See how
  [companion snapshots are pinned](docs/releases.md#update-the-companion).

From a full clone, run the portable tests with Node 22, Python 3, and Git installed.

```sh
node --test test/*.test.mjs
```

If you change packaging or the companion pin, build the plugin ZIP and Linux
source kit and verify their checksums. See the [release guide](docs/releases.md)
for the commands.

## Open a pull request

For browser changes, try the action in a standalone workspace with a sample
project. For a change that switches projects, reconnects a session, or
rearranges the editor, start with an unsaved line. Check the caret and verify
the file in the original project after saving. Include the tested browser
and viewport size in the PR. For a companion pin update, link the source diff
between the two snapshots so reviewers can inspect the implementation.

Target `main` and keep the PR to one change. Describe what it fixes, link the
issue if there is one, and list what you tested, including skipped checks.
For visible changes, include a screenshot or short recording. For changes to
sign-in, pairing, or saved state, explain how existing installs are affected.

GitHub requires `Lattice CI passed` before merge. Maintainers squash changes
into `main`, and GitHub deletes merged branches in this repository.
