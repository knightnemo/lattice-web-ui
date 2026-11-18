# Standalone server frontend

Build the regular frontend with `pnpm build` and pass its `dist/` directory to
the standalone server's `--assets` option. The server injects an explicit
headless marker into the entry HTML. Desktop Tauri windows, native-host browser
handoffs and static previews keep their existing transport.

The browser first checks `/api/session`. If needed, a password field collects
the server access token and exchanges it for an HttpOnly session cookie. The
token is cleared after exchange and is never put in a URL, localStorage or
sessionStorage. Subsequent invokes, project choices, events and assets use only
same-origin authenticated requests. Use HTTPS and `--secure-cookies` remotely.

Remote Workspace also packages an account gateway for ordinary HTTPS access.
Run the companion with `--account-gateway`, `--secure-cookies`, and its explicit
HTTPS `--public-origin`. The gateway authorizes all requests before forwarding
them. It supplies the private companion token in `X-Lattice-Account-Proxy`
only on the session bootstrap request, which creates the regular browser
cookie. Keep the backend listener reachable only through the gateway.
The Remote Workspace kit includes the proxy configuration and setup guide.

For trusted personal devices, Remote Workspace also supports owner-issued QR
pairing with `--device-pairing` on a dedicated HTTPS origin. The phone claims a
one-use invite and receives a persistent, individually revocable browser
credential. Keep the paired-device registry outside the project and static
assets. See the Remote Workspace kit's pairing guide for the trust model,
service settings and test commands.

The adapter implements the existing Tauri invoke/listen consumers over HTTP
and SSE, handles browser-local window/clipboard/link actions, and uses a server
project picker rather than the client machine's native filesystem picker.
Server capability checks reject unavailable operations explicitly; native-only
features do not silently succeed. PDF byte ranges use the selected project's
versioned asset endpoint, while compiled PDF replies are decoded as binary.

Each browser session selects its own server project. The server confines those
projects to its configured workspace root. Run and install the standalone
server as described in its own documentation; this frontend does not provide
an AI sidecar, terminal or language server by itself.

## Phone and foldable layouts

The remote workspace opens the active editor as a single pane at widths up to
640 CSS pixels and beside its compiled PDF from 641 to 1024 pixels. This covers
the full-screen outer and inner Safari layouts on iPhone Duo. Above that range
the usual desktop arrangement is used. Project, PDF, and the other tools remain
available from the mobile toolbar.

Switching between one and two panes reuses the document view and its editor.
An unsaved edit, the caret and selection stay in the current session. The mobile
arrangement is temporary and the browser's saved desktop layout remains available.

The browser integration test runs against the server binary, compiled frontend
assets, and a scratch project. It pauses a real write while resizing, checks
the editor, PDF and caret, then releases the write and verifies the saved file.
Use `LATTICE_TEST_BROWSER=webkit` with a Playwright WebKit install, or omit it to
test installed Chrome.

```sh
LATTICE_SERVER_BINARY=server/target/debug/lattice-server \
  LATTICE_WEB_ASSETS=dist node server/tests/remote-workspace.browser.mjs
```
