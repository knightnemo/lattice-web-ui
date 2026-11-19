import { BrowserEventRegistry, decodeBridgeValue, encodeBridgeValue, isHeadlessHosted, LOCAL_COMMANDS } from "./browser-runtime";
import { signInPairedDevice, showServerLogin, takePairingCode } from "./headless-login";
import { installSessionRecovery, sessionExpired } from "./headless-session-recovery";
import "./headless.css";

declare global {
  interface Window {
    __LATTICE_HEADLESS_DEVICE_OWNER__?: boolean;
  }
}

/* eslint-disable lingui/no-unlocalized-strings -- transport protocol and diagnostic errors; bootstrap UI lives in headless-login */
type Callback = (value: unknown) => void;
type EventPayload = { event?: string; callback?: number; payload: unknown };
let activeClient: string | undefined;
export interface HeadlessSession {
  headless: boolean;
  authenticated: boolean;
  devicePairing?: boolean;
  canManageDevices?: boolean;
  capabilities?: { commands: string[]; unavailable: string[] };
}

export async function serverRequest<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = body === undefined ? {} : { "Content-Type": "application/json" };
  if (activeClient) headers["X-Lattice-Client"] = activeClient;
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("lattice:session-expired"));
    throw new Error(sessionExpired());
  }
  const value = await response.json();
  if (!response.ok || value.error) {
    throw new Error(value.error?.message ?? `Server request failed (${response.status}).`);
  }
  return value as T;
}

/** A Tauri API adapter, with no native host, loopback URLs or credentials in URLs/storage. */
export function installHeadlessRuntime(session: HeadlessSession): () => void {
  const client = crypto.randomUUID();
  activeClient = client;
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<number, { event: string; callback: number }>();
  let nextId = 1;
  const runCallback = (id: number, payload: unknown) => callbacks.get(id)?.(payload);
  const localEvents = new BrowserEventRegistry(runCallback);
  const openStream = () => new EventSource(`/api/events?${new URLSearchParams({ client })}`, { withCredentials: true });
  let eventSource = openStream();
  let connectedBefore = false;
  let projectRoot: string | undefined;
  let disposed = false;
  const requireLiveClient = () => {
    if (disposed || activeClient !== client) throw new DOMException("The workspace connection closed.", "AbortError");
  };
  const waitForEvents = () => {
    const stream = eventSource;
    if (stream.readyState === 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const opened = () => { clearTimeout(timer); resolve(); };
      const timer = window.setTimeout(() => {
        stream.removeEventListener("open", opened);
        reject(new Error("The server event stream is unavailable. Reconnect before opening a terminal."));
      }, 20_000);
      stream.addEventListener("open", opened, { once: true });
    });
  };
  const handleMessage = (message: MessageEvent) => {
    let value: EventPayload;
    try { value = JSON.parse(message.data) as EventPayload; } catch { return; }
    if (typeof value.callback === "number") {
      runCallback(value.callback, decodeBridgeValue(value.payload as Parameters<typeof decodeBridgeValue>[0]));
      return;
    }
    for (const [id, listener] of listeners) {
      if (listener.event === value.event) runCallback(listener.callback, { event: value.event, id, payload: value.payload });
    }
  };
  const attachStream = () => {
    const stream = eventSource;
    stream.onopen = () => {
      // A deployment can replace the server without an OS/browser "online"
      // event. Both automatic SSE retries and authenticated recovery land here.
      if (connectedBefore) window.dispatchEvent(new Event("lattice:workspace-reconnected"));
      connectedBefore = true;
    };
    stream.onmessage = handleMessage;
    stream.onerror = async () => {
      if (stream.readyState !== EventSource.CLOSED) return;
      stream.onerror = null;
      // EventSource hides the HTTP status. A proxy or terminal-stream failure must not restart a healthy session.
      try {
        const probe = await fetch("/api/capabilities", { credentials: "same-origin", cache: "no-store" });
        if (!disposed && eventSource === stream && probe.status === 401) {
          window.dispatchEvent(new Event("lattice:session-expired"));
        }
      } catch { /* Offline: the next protected request can report an expired session. */ }
    };
  };
  const closeStream = () => {
    eventSource.onopen = null;
    eventSource.onmessage = null;
    eventSource.onerror = null;
    eventSource.close();
  };
  attachStream();
  const recovery = installSessionRecovery(session, closeStream, async (renewed) => {
    if (projectRoot) {
      // A fresh session starts on the host default. Restore the tab before allowing any new commands.
      const restored = await serverRequest<{ result: { root: string } }>("/api/invoke", {
        command: "open_project", args: { path: projectRoot },
      });
      if (restored.result.root !== projectRoot) throw new Error("The server returned a different project.");
    }
    if (disposed) return;
    session = renewed;
    eventSource = openStream();
    attachStream();
  });
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    const local = LOCAL_COMMANDS.get(command);
    if (local) return local(args);
    if (command === "plugin:event|listen") {
      const event = String(args.event);
      const handler = Number(args.handler);
      const localId = localEvents.listen(event, handler);
      if (localId !== null) return localId;
      const id = nextId++;
      listeners.set(id, { event, callback: handler });
      return id;
    }
    if (command === "plugin:event|unlisten") {
      const id = Number(args.eventId);
      localEvents.unregister(String(args.event), id, (callback) => callbacks.delete(callback));
      listeners.delete(id);
      return;
    }
    requireLiveClient();
    if (command === "plugin:opener|open_url") {
      const url = new URL(String(args.url));
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error("Unsupported URL scheme.");
      window.open(url.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (command === "overleaf_open_login_in_browser") {
      const host = new URL(typeof args.host === "string" ? args.host : "https://www.overleaf.com");
      if (!["https:", "http:"].includes(host.protocol) || host.username || host.password || host.search || host.hash) throw new Error("Invalid Overleaf host.");
      host.pathname = `${host.pathname.replace(/\/+$/, "")}/login`;
      // noopener deliberately returns null even when the browser opens it.
      window.open(host.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (command === "plugin:clipboard-manager|write_text") return navigator.clipboard.writeText(String(args.text));
    if (command === "plugin:clipboard-manager|read_text") return navigator.clipboard.readText();
    if (command === "plugin:dialog|open") {
      const { chooseServerProject } = await import("./headless-project-picker");
      requireLiveClient();
      return chooseServerProject();
    }
    recovery.requireConnected();
    if (session.capabilities && !session.capabilities.commands.includes(command)) {
      throw new Error(`${command} is unavailable on this server. See server capabilities.`);
    }
    if (command === "terminal_open" || command === "terminal_run" || command === "terminal_attach") {
      await waitForEvents();
      requireLiveClient();
      recovery.requireConnected();
    }
    const value = await serverRequest<{ result: unknown }>("/api/invoke", { command, args: encodeBridgeValue(args) });
    if ((command === "initial_project" || command === "open_project") && value.result && typeof value.result === "object" &&
        "root" in value.result && typeof value.result.root === "string") projectRoot = value.result.root;
    if (command === "read_compiled_pdf" && Array.isArray(value.result)) return Uint8Array.from(value.result).buffer;
    return decodeBridgeValue(value.result as Parameters<typeof decodeBridgeValue>[0]);
  };
  const runtime = window as unknown as Record<string, unknown>;
  runtime.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback: Callback, once = false) {
      const id = nextId++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        callback?.(payload);
      });
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc(path: string) {
      return `/api/asset?${new URLSearchParams({ path, client })}`;
    },
    metadata: { currentWindow: { label: "headless" }, currentWebview: { label: "headless", windowLabel: "headless" } },
    plugins: { path: { sep: "/", delimiter: ":" } },
  };
  runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, id: number) {
      localEvents.unregister(event, id, (callback) => callbacks.delete(callback));
      listeners.delete(id);
    },
  };
  runtime.__LATTICE_BROWSER_RUNTIME__ = true;
  runtime.__LATTICE_HEADLESS_CLIENT__ = client;
  window.__LATTICE_HEADLESS_DEVICE_OWNER__ = session.devicePairing ? Boolean(session.canManageDevices) : undefined;
  runtime.__LATTICE_HEADLESS_TERMINAL__ = Boolean(session.capabilities?.commands.includes("terminal_open"));
  runtime.isTauri = true;
  return () => {
    disposed = true; recovery.dispose();
    closeStream(); listeners.clear(); callbacks.clear();
    if (activeClient === client) {
      activeClient = undefined;
      delete window.__LATTICE_HEADLESS_DEVICE_OWNER__;
    }
  };
}

export async function initializeHeadlessRuntime(): Promise<void> {
  if (!isHeadlessHosted()) return;
  const code = takePairingCode();
  let session = await serverRequest<HeadlessSession>("/api/session");
  if (!session.authenticated && session.devicePairing) {
    if (!code) session = await serverRequest<HeadlessSession>("/api/devices/resume", {}).catch(() => session);
    if (!session.authenticated) session = await signInPairedDevice(code);
  }
  if (!session.authenticated) session = await showServerLogin(session.devicePairing);
  const dispose = installHeadlessRuntime(session);
  // A back-forward-cache entry retains this document, including its client
  // identity. Only dispose the adapter when the browser discards the entry.
  const leaving = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    dispose();
    window.removeEventListener("pagehide", leaving);
  };
  window.addEventListener("pagehide", leaving);
}
