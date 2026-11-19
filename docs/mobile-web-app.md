# Installable mobile workspace

The standalone headless server can serve the regular Lattice frontend over a
private HTTPS origin. Open that address while connected to the server's tailnet,
sign in with the server access token, then use the browser's **Install app** or
**Add to Home Screen** action. Safari on iPhone exposes this under Share; desktop
browsers expose installation in their address bar or menu when available.

On a standalone server, the workspace shows one panel at widths up to 640 CSS
pixels. From 641 to 1024 pixels, it opens the editor and PDF side by side.
The bottom bar highlights the visible panels. Opening a project file brings
its editor forward. Unfolding keeps the current edit and text selection.
Above 1024 pixels the workspace restores the desktop layout.

![Editor and compiled PDF side by side, with both panels highlighted in the navigation](images/mobile-editor-spread.png)

The service worker is registered only on the standalone server, in a secure
context. It is network-only: it does not cache HTML, project data, API responses,
or authentication. When the server cannot be reached, opening the app displays a
reconnection page. Editing requires the live server. Installing the app does not
make the server public or bypass its authentication. Native Tauri windows and
single-use desktop browser handoffs do not register this worker.

Supported operations still depend on the connected server's capabilities.
Installation and a mobile layout do not add a terminal, an AI backend, or a LaTeX
distribution to the server.
