// Loaded by lattice-gateway before Lattice's own scripts on the workspace page.
// 1. When Lattice opens another project, it hands the new address to the host's
//    opener instead of this tab. The gateway keeps that address for a minute;
//    the tab the person was just using claims it and follows it.
// 2. A project picked on the gateway's Projects page is opened through Lattice's
//    own "open project in a new window" command once the page is connected.
// 3. A small link to the gateway's Projects and Devices pages.
(() => {
  "use strict";
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

  addEventListener("DOMContentLoaded", () => {
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
