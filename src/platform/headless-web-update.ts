import { invoke } from "@tauri-apps/api/core";
import type { RefObject } from "react";
import type { ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { showError } from "../app/notify";
import { saveEveryEdit } from "../app/save-every-edit";
import type { ProjectLifecycleDeps } from "../app/use-project-lifecycle";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";

const NOTICE = "headless-web-update";
const HOST_NOTICE = "headless-host-release";
const HOST_STATUS_PATH = "/lattice-host-update.json";
type HostRelease = { installedVersion: string; latestVersion: string; notesUrl: string };

// The optional host timer publishes stable release numbers. Accept only its
// versioned public schema and construct every link from our official repository.
function hostRelease(value: unknown): HostRelease | null {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3 ||
      !("schema" in value) || value.schema !== 1 || !("installedVersion" in value) || !("latestVersion" in value)) return null;
  const { installedVersion, latestVersion } = value;
  const stable = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
  if (typeof installedVersion !== "string" || typeof latestVersion !== "string") return null;
  const installed = stable.exec(installedVersion);
  const latest = stable.exec(latestVersion);
  if (!installed || !latest || installed[0] !== installedVersion || latest[0] !== latestVersion) return null;
  for (let i = 1; i <= 3; i++) {
    if (installed[i] === latest[i]) continue;
    // With no leading zeroes, digit length and then lexical order compare
    // each part exactly, including a number larger than a JS safe integer.
    if (latest[i].length < installed[i].length ||
        (latest[i].length === installed[i].length && latest[i] < installed[i])) return null;
    return { installedVersion, latestVersion, notesUrl: `https://github.com/knightnemo/lattice-web-ui/releases/tag/v${latestVersion}` };
  }
  return null;
}

const changes = new EventTarget();

// The standalone server serves one copy of its entry HTML until it restarts.
// Read the stamp from the same page a reload will actually receive.
const revision = (doc: Document) => doc.querySelector<HTMLMetaElement>('meta[name="lattice-web-build"]')?.content;
type WebUpdate = {
  loaded: string;
  served: string;
  release: HostRelease | null;
  check: () => Promise<boolean>;
  reload: () => Promise<boolean>;
};
let update: WebUpdate | null = null;
export const webUpdateSnapshot = () => update;
export function subscribeWebUpdate(listener: () => void) {
  changes.addEventListener("change", listener);
  return () => changes.removeEventListener("change", listener);
}

/** Observe deployments while this editor is visible. A release never reloads a tab by itself. */
export function watchWebUpdate(saveAndReload: () => Promise<boolean>): () => void {
  const loaded = revision(document);
  if (!loaded) return () => {};
  let stopped = false;
  let pending: Promise<boolean> | undefined;
  let saving = false;
  const controller = new AbortController();
  let pendingHost: Promise<void> | undefined;
  let retryMissingHostAfter = 0;
  const announced = new Set<string>();
  const fetchStatus = (url: URL | string) => fetch(url, {
    cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
  });

  function applyHostRelease(release: HostRelease | null) {
    if (stopped || !update || (update.release?.latestVersion === release?.latestVersion &&
        update.release?.installedVersion === release?.installedVersion)) return;
    update = { ...update, release };
    changes.dispatchEvent(new Event("change"));
    if (!release) {
      dismissAppToastByDedupeKey(HOST_NOTICE);
      return;
    }
    const { latestVersion } = release;
    if (window.__LATTICE_HEADLESS_DEVICE_OWNER__ === false || announced.has(latestVersion)) return;
    announced.add(latestVersion);
    try {
      const key = `lattice:host-release:${latestVersion}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch { /* Storage can be unavailable in a private browsing session. */ }
    notifyInfo(i18n._(msg`App updater`), i18n._(msg`Lattice-web-ui ${latestVersion} is available on GitHub`), {
      dedupeKey: HOST_NOTICE, timeoutMs: 7000,
      primaryAction: {
        label: i18n._(msg`View release notes`),
        // eslint-disable-next-line lingui/no-unlocalized-strings -- browser target and opener isolation flags
        onClick: () => { window.open(release.notesUrl, "_blank", "noopener,noreferrer"); },
      },
    });
  }

  async function readHostRelease() {
    const response = await fetchStatus(HOST_STATUS_PATH);
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (response.status === 404 || response.status === 410 || (response.ok && mediaType === "text/html")) {
      // Most installations omit the optional timer. Check those quietly once
      // an hour; an explicit check in Settings can discover a newly enabled timer.
      retryMissingHostAfter = Date.now() + 60 * 60_000;
      applyHostRelease(null);
    } else if (response.ok) {
      applyHostRelease(mediaType === "application/json" ? hostRelease(await response.json().catch(() => null)) : null);
    }
  }
  function checkHost() {
    if (!document.hidden && Date.now() >= retryMissingHostAfter) {
      pendingHost ??= readHostRelease().catch(() => {}).finally(() => { pendingHost = undefined; });
    }
  }

  function offer(failed = false) {
    notifyInfo(i18n._(msg`App updater`), i18n._(msg`Workspace update available`), {
      dedupeKey: NOTICE,
      timeoutMs: 0,
      detail: failed ? i18n._(msg`Your workspace stayed open. Finish any active edit or sync, then try again.`) : undefined,
      primaryAction: { label: i18n._(msg`Save and reload`), keepOpen: true, onClick: () => { void reload(); } },
    });
  }
  async function reload() {
    if (saving || stopped || !update || update.served === loaded) return false;
    saving = true;
    const saved = await saveAndReload().catch(() => false);
    saving = false;
    if (!saved && !stopped && update.served !== loaded) offer(true);
    return saved;
  }
  async function readBuild() {
    const response = await fetchStatus(new URL("index.html", document.baseURI));
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return false;
    const next = revision(new DOMParser().parseFromString(await response.text(), "text/html"));
    if (stopped || !update || !next || !/^[0-9a-f]{24}$/.test(next)) return false;
    if (next !== update.served) {
      update = { ...update, served: next };
      changes.dispatchEvent(new Event("change"));
      if (next === loaded) dismissAppToastByDedupeKey(NOTICE);
      else offer();
    }
    return true;
  }
  function check() {
    if (stopped || document.hidden) return Promise.resolve(false);
    checkHost();
    // A foreground check joins any online/visibility poll already in flight.
    pending ??= readBuild().catch(() => false).finally(() => { pending = undefined; });
    return pending;
  }
  update = { loaded, served: loaded, release: null, check: () => {
    retryMissingHostAfter = 0;
    return check();
  }, reload };
  checkHost();
  changes.dispatchEvent(new Event("change"));
  let lastReconnectCheck = -Infinity;
  function onReconnect() {
    if (document.hidden || Date.now() - lastReconnectCheck < 15_000) return;
    lastReconnectCheck = Date.now();
    void check();
  }
  const interval = window.setInterval(check, 5 * 60_000);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", check);
  window.addEventListener("lattice:workspace-reconnected", onReconnect);
  return () => {
    stopped = true;
    controller.abort();
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("online", check);
    window.removeEventListener("lattice:workspace-reconnected", onReconnect);
    dismissAppToastByDedupeKey(NOTICE);
    if (update?.release) dismissAppToastByDedupeKey(HOST_NOTICE);
    update = null;
    changes.dispatchEvent(new Event("change"));
  };
}

/** Restore this tab's project and keep its deployed-build observer attached until unmount. */
export async function startHostedWorkspace(
  deps: RefObject<Pick<ProjectLifecycleDeps, "documents" | "projectState" | "overleafSync">>,
  signal: AbortSignal,
): Promise<ProjectSnapshot | null> {
  if (signal.aborted) return null;
  const stop = watchWebUpdate(async () => {
    const { documents, projectState, overleafSync } = deps.current;
    const root = projectState.projectRef.current?.root;
    if (projectState.projectBeforeTransitionRef.current || overleafSync.syncingRef.current) return false;
    const ownsProject = projectState.captureProjectScope();
    const saved = await saveEveryEdit({ ...documents, flushWholeFiles: overleafSync.flushWholeFilesRef.current });
    if (signal.aborted || saved !== "saved" || !ownsProject() || overleafSync.syncingRef.current) return false;
    // Reload creates a fresh server client. Only this history entry inherits the project.
    window.history.replaceState({ ...window.history.state, latticeReloadProject: root }, "");
    window.location.reload();
    return true;
  });
  signal.addEventListener("abort", stop, { once: true });
  const state = window.history.state;
  if (typeof state?.latticeReloadProject === "string") {
    const { latticeReloadProject: path, ...rest } = state;
    window.history.replaceState(rest, "");
    try { return await invoke<ProjectSnapshot>("open_project", { path }); }
    catch (reason) { if (!signal.aborted) showError(toMessage(reason)); }
  }
  return invoke<ProjectSnapshot | null>("initial_project");
}
