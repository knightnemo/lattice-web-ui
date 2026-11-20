import { invoke } from "@tauri-apps/api/core";
import { useEffect, type RefObject } from "react";
import { beginHeadlessReload } from "./headless-runtime";
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
const HOST_UPDATE_PATH = "/api/host-update";
const HOST_STATUS_PATH = "/lattice-host-update.json";
const HOST_PHASES = ["current", "available", "preparing", "ready", "waiting", "switching", "rolled_back", "failed"] as const;
type HostPhase = typeof HOST_PHASES[number];
type HostRelease = {
  installedVersion: string;
  latestVersion: string;
  notesUrl: string;
  phase: Exclude<HostPhase, "current"> | null;
};

const isActive = (phase: HostRelease["phase"] | undefined) =>
  phase === "preparing" || phase === "waiting" || phase === "switching";

function hostRelease(value: unknown, managed: boolean): HostRelease | null {
  if (!value || typeof value !== "object" || (!managed && Object.keys(value).length !== 3) ||
      !("schema" in value) || value.schema !== 1 || !("installedVersion" in value) || !("latestVersion" in value)) return null;
  const { installedVersion, latestVersion } = value;
  const phase = managed ? HOST_PHASES.find((phase) => "phase" in value && phase === value.phase) : null;
  if (phase === undefined || phase === "current") return null;
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
    return {
      installedVersion, latestVersion, phase,
      notesUrl: `https://github.com/lattice-writer/lattice-web-ui/releases/tag/v${latestVersion}`,
    };
  }
  return null;
}

export function canRequestHostUpdate(phase: HostRelease["phase"] | undefined): boolean {
  return phase === "available" || phase === "ready" || phase === "failed" || phase === "rolled_back";
}

const changes = new EventTarget();

// The standalone server serves one copy of its entry HTML until it restarts.
// Read the stamp from the same page a reload will actually receive.
const revision = (doc: Document) => doc.querySelector<HTMLMetaElement>('meta[name="lattice-web-build"]')?.content;
type WebUpdate = {
  loaded: string;
  served: string;
  release: HostRelease | null;
  requesting: boolean;
  requestFailed: boolean;
  requestHost: () => Promise<void>;
  check: () => Promise<boolean>;
  reload: () => Promise<boolean>;
  showNotice: () => void;
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
  let nextHostCheck = 0;
  const fetchStatus = (url: URL | string, init?: RequestInit) => fetch(url, {
    cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal, ...init,
  });

  function publish(patch: Partial<WebUpdate>) {
    if (stopped || !update) return;
    update = { ...update, ...patch };
    changes.dispatchEvent(new Event("change"));
  }

  function applyHostRelease(release: HostRelease | null) {
    if (update?.release?.latestVersion === release?.latestVersion &&
        update?.release?.installedVersion === release?.installedVersion &&
        update?.release?.phase === release?.phase) return;
    publish({ release, requestFailed: false });
  }

  const mediaType = (response: Response) => response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const missing = (response: Response) => response.status === 404 || response.status === 410 ||
    (response.ok && mediaType(response) === "text/html");

  async function readHostRelease() {
    if (window.__LATTICE_HEADLESS_DEVICE_OWNER__ !== false) {
      const response = await fetchStatus(HOST_UPDATE_PATH);
      if (response.ok && mediaType(response) === "application/json") {
        applyHostRelease(hostRelease(await response.json(), true));
        return;
      }
      if (!missing(response) && response.status !== 405) return;
    }
    const response = await fetchStatus(HOST_STATUS_PATH);
    if (missing(response)) {
      // Most installations omit the optional timer. A manual check can find
      // a newly enabled updater without waiting for the idle polling backoff.
      retryMissingHostAfter = Date.now() + 60 * 60_000;
      applyHostRelease(null);
    } else if (response.ok) {
      applyHostRelease(mediaType(response) === "application/json" ? hostRelease(await response.json().catch(() => null), false) : null);
    }
  }

  function checkHost() {
    if (!document.hidden && Date.now() >= retryMissingHostAfter && !update?.requesting) {
      pendingHost ??= readHostRelease().catch(() => {}).finally(() => {
        pendingHost = undefined;
        nextHostCheck = Date.now() + (isActive(update?.release?.phase) ? 5_000 : 60_000);
      });
    }
  }

  async function requestHost() {
    const release = update?.release;
    if (stopped || update?.requesting || !release || !canRequestHostUpdate(release.phase) ||
        window.__LATTICE_HEADLESS_DEVICE_OWNER__ === false) return;
    publish({ requesting: true, requestFailed: false });
    let failed = false;
    try {
      await pendingHost;
      if (stopped || update?.release?.latestVersion !== release.latestVersion ||
          !canRequestHostUpdate(update?.release?.phase)) return;
      const response = await fetchStatus(HOST_UPDATE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: release.latestVersion }),
      });
      failed = !response.ok;
      if (response.ok) {
        const status = mediaType(response) === "application/json" ? await response.json().catch(() => null) : null;
        applyHostRelease(hostRelease(status, true) ?? { ...release, phase: "waiting" });
      }
    } catch {
      // Keep the banner available after a failed or interrupted request.
      failed = true;
    } finally {
      publish({ requesting: false, requestFailed: failed });
      checkHost();
    }
  }

  function offer(failed = false) {
    if (stopped || !update || update.served === loaded) return;
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
  update = { loaded, served: loaded, release: null, requesting: false, requestFailed: false, requestHost, check: () => {
    retryMissingHostAfter = 0;
    return check();
  }, reload, showNotice: offer };
  checkHost();
  changes.dispatchEvent(new Event("change"));
  let lastReconnectCheck = -Infinity;
  function onReconnect() {
    if (document.hidden || Date.now() - lastReconnectCheck < 15_000) return;
    lastReconnectCheck = Date.now();
    void check();
  }
  let nextBuildCheck = Date.now() + 5 * 60_000;
  const interval = window.setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    if (isActive(update?.release?.phase) || now >= nextBuildCheck) {
      nextBuildCheck = now + 5 * 60_000;
      void check();
    } else if (now >= nextHostCheck) checkHost();
  }, 5_000);
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
    update = null;
    changes.dispatchEvent(new Event("change"));
  };
}

/** A deployment can remove the old Settings chunk before this tab has ever opened it. */
export async function recoverHostedSettings(error: unknown) {
  if (update && update.loaded === update.served) await update.check();
  if (!update || update.loaded === update.served) throw error;
  return { default: ReturnToWorkspaceUpdate };
}

function ReturnToWorkspaceUpdate({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    onClose();
    update?.showNotice();
  }, [onClose]);
  return null;
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
    beginHeadlessReload();
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
