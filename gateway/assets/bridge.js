// Loaded by lattice-gateway before Lattice's own scripts on the workspace page.
// 1. When Lattice opens another project, it hands the new address to the host's
//    opener instead of this tab. The gateway keeps that address for a minute;
//    the tab the person was just using claims it and follows it.
// 2. A project picked on the gateway's Projects page is opened through Lattice's
//    own "open project in a new window" command once the page is connected.
// 3. Lattice's Agent runs on its own loopback port. The gateway serves it on a
//    second public origin; the address Lattice reports is swapped for that one.
// 4. Lattice has no one-click TeX package install on Linux. For the owner, its
//    install command is answered by the gateway, which runs tlmgr on the host.
// 5. A small link to the gateway's Projects and Devices pages.
(() => {
  "use strict";

  const LOOPBACK_AGENT = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
  let agentConfig;
  const agentOrigin = () => (agentConfig ??= fetch("/__gateway/api/config", { credentials: "same-origin", cache: "no-store" })
    .then((r) => (r.ok ? r.json() : {})).then((c) => c.agentOrigin || null).catch(() => null));
  async function publicAgent(info) {
    const match = info && typeof info.origin === "string" && LOOPBACK_AGENT.exec(info.origin);
    const origin = match && await agentOrigin();
    if (!origin) return info;
    const response = await fetch("/__gateway/api/agent-port", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: Number(match[1]) }),
    });
    return response.ok ? { ...info, origin } : info;
  }
  async function installTexDependency(args, fallback) {
    const name = (args && (args.package || args.missingFile)) || "";
    const response = await fetch("/__gateway/api/tex-install", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    // Not the owner, or no TeX the gateway may change: Lattice answers as it would.
    if (response.status === 401 || response.status === 404) return fallback();
    const value = await response.json().catch(() => ({}));
    if (response.ok) return { kind: "installed" };
    if (value?.error?.code === "choose_package") return { kind: "choosePackage", packages: value.error.packages };
    throw new Error(value?.error?.message || "Installing the TeX package failed.");
  }

  // Lattice installs its IPC adapter on window.__TAURI_INTERNALS__; wrap its invoke as it arrives.
  let internals;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    get: () => internals,
    set(value) {
      if (value && typeof value.invoke === "function" && !value.__latticeGateway) {
        const invoke = value.invoke;
        value.invoke = async (command, args, options) => {
          if (command === "start_tex_dependency_install") {
            return installTexDependency(args, () => invoke(command, args, options));
          }
          const result = await invoke(command, args, options);
          return command === "synara_ensure_ready" ? publicAgent(result) : result;
        };
        value.__latticeGateway = true;
      }
      internals = value;
    },
  });
  let lastInput = 0;
  for (const type of ["pointerdown", "keydown"]) {
    addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
  }

  async function poll() {
    if (document.visibilityState === "visible" && Date.now() - lastInput < 20000) {
      try {
        const response = await fetch("/__gateway/api/open-request", {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: "{}",
        });
        if (response.status === 200) {
          const { url } = await response.json();
          if (typeof url === "string" && /^\/\?entry=[\w-]+$/.test(url)) {
            location.assign(url);
            return;
          }
        }
      } catch { /* the next poll retries */ }
    }
    setTimeout(poll, 1500);
  }
  setTimeout(poll, 1500);

  const PENDING = "lattice-gateway.open-project";
  const pending = (() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(PENDING) || "null");
      sessionStorage.removeItem(PENDING);
      return value && typeof value.path === "string" ? value : null;
    } catch { return null; }
  })();
  if (pending) {
    (async () => {
      const deadline = Date.now() + 30000;
      while (!(window.__LATTICE_BROWSER_RUNTIME__ && window.__TAURI_INTERNALS__)) {
        if (Date.now() > deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // Let the host's copy of localStorage arrive before Lattice opens anything.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      lastInput = Date.now();
      try {
        await window.__TAURI_INTERNALS__.invoke("open_project_window", { path: pending.path });
      } catch (error) {
        console.warn("lattice-gateway: could not open", pending.path, error);
      }
    })();
  }

  // The owner learns when Lattice opens a native window on the host, and can go use it.
  async function watchHostWindows(banner) {
    try {
      const response = await fetch("/__gateway/api/screen/state", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401 || response.status === 404) return; // not the owner, or not shared
      const { windows } = await response.json();
      banner.hidden = !windows;
    } catch { /* retry */ }
    setTimeout(() => watchHostWindows(banner), document.visibilityState === "visible" ? 2500 : 8000);
  }

  addEventListener("DOMContentLoaded", () => {
    const zhBanner = /^zh\b/i.test(navigator.language || "");
    const banner = document.createElement("a");
    banner.href = "/__gateway/screen";
    banner.hidden = true;
    banner.textContent = zhBanner ? "Lattice 在主机上打开了一个窗口，点这里使用它" : "Lattice opened a window on the host. Use it here";
    banner.setAttribute("data-lattice-gateway", "");
    banner.style.cssText = [
      "position:fixed", "z-index:2147483001", "left:50%", "transform:translateX(-50%)",
      "top:max(8px, env(safe-area-inset-top))", "padding:8px 14px", "border-radius:999px",
      "font:600 13px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      "background:#556324", "color:#fff", "text-decoration:none", "box-shadow:0 2px 8px rgba(0,0,0,.25)",
    ].join(";");
    document.body.append(banner);
    watchHostWindows(banner);
    const zh = /^zh\b/i.test(navigator.language || "");
    const link = document.createElement("a");
    link.href = "/__gateway/projects";
    link.title = zh ? "项目与设备" : "Projects and devices";
    link.setAttribute("aria-label", link.title);
    link.setAttribute("data-lattice-gateway", "");
    link.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h16v16H4zM4 12h16M12 4v16"/></svg>';
    link.style.cssText = [
      "position:fixed", "z-index:2147483000", "display:grid", "place-items:center",
      "left:max(6px, env(safe-area-inset-left))", "bottom:max(34px, calc(env(safe-area-inset-bottom) + 34px))",
      "width:26px", "height:26px", "border-radius:999px", "text-decoration:none",
      "background:rgba(85,99,36,.92)", "color:#fff", "opacity:.45", "transition:opacity .15s",
      "box-shadow:0 1px 3px rgba(0,0,0,.25)",
    ].join(";");
    link.addEventListener("mouseenter", () => { link.style.opacity = "1"; });
    link.addEventListener("mouseleave", () => { link.style.opacity = ".45"; });
    link.addEventListener("focus", () => { link.style.opacity = "1"; });
    link.addEventListener("blur", () => { link.style.opacity = ".45"; });
    document.body.append(link);
  });
})();
