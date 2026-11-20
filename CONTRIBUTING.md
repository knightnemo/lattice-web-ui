# Contributing to Lattice-web-ui

Bug fixes, docs, and small improvements are welcome. For a larger change,
open an issue first so we can agree on where it belongs and how to test it.

## Report a bug

In [Issues](https://github.com/lattice-writer/lattice-web-ui/issues), include what
you expected, what happened, and the shortest steps to reproduce it. Note
your browser and OS and, if relevant, the plugin version, host kit version, Lattice version,
and sign-in method. Use a sample project and remove tokens, pairing links,
private hostnames, and project content from screenshots and logs.

## Work on a change

- `plugin/` contains the Mac launcher. In Lattice, choose **Settings →
  Plugins → Install from folder…** and select that directory to try it.
- `gateway/` is the access gateway (Rust) and `host/` is `lattice-host`, which
  installs Lattice on a Linux host. The browser editor is Lattice itself:
  report editor bugs to [leo1oel/lattice](https://github.com/leo1oel/lattice/issues).

Run the tests from a full clone with the Rust toolchain from
`rust-toolchain.toml`, Node 22, Python 3, Git, Bash, `zip`, `unzip` and `tar`.

```sh
cargo test --manifest-path gateway/Cargo.toml
cargo build --release --manifest-path gateway/Cargo.toml
python3 test/host_kit.py
LATTICE_GATEWAY_BINARY="$PWD/gateway/target/release/lattice-gateway" node --test test/*.test.mjs
```

If you change packaging or `host/lattice-releases.json`, build the plugin ZIP
and the host kit and verify their checksums. New plugin or host kit files must
be listed in `scripts/package.sh` and in the archive test.
See the [release guide](docs/releases.md) for the commands.

## Open a pull request

For browser changes, try the action in a standalone workspace with a sample
project. For a change that switches projects, reconnects a session, or
rearranges the editor, start with an unsaved line. Check the caret and verify
the file in the original project after saving. Include the tested browser
and viewport size in the PR. For a new Lattice pin, say which Lattice release
notes you checked and what you tried through the gateway on that release.

Target `main` and keep the PR to one change. Describe what it fixes, link the
issue if there is one, and list what you tested, including skipped checks.
For visible changes, include a screenshot or short recording. For changes to
sign-in, pairing, or saved state, explain how existing installs are affected.

GitHub requires `Lattice CI passed` before merge. Maintainers squash changes
into `main`, and GitHub deletes merged branches in this repository.
