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
const changes = new EventTarget();

// The standalone server serves one copy of its entry HTML until it restarts.
// Read the stamp from the same page a reload will actually receive.
const revision = (doc: Document) => doc.querySelector<HTMLMetaElement>('meta[name="lattice-web-build"]')?.content;
type WebUpdate = {
  loaded: string;
  served: string;
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
    const response = await fetch(new URL("index.html", document.baseURI), {
      cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
    });
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
    // A foreground check joins any online/visibility poll already in flight.
    pending ??= readBuild().catch(() => false).finally(() => { pending = undefined; });
    return pending;
  }
  update = { loaded, served: loaded, check, reload };
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
