import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { confirmDevicePairing, showServerLogin, watchPairingLaunches } from "./headless-login";
import { serverRequest, type HeadlessSession } from "./headless-runtime";

export const sessionExpired = () => i18n._(msg`Server session expired. Keep this tab open, reconnect, then try the action again.`);

/** Keep the running editor and its drafts mounted throughout authentication. */
export function installSessionRecovery(
  original: HeadlessSession,
  disconnected: () => void,
  restore: (session: HeadlessSession) => Promise<void>,
) {
  let paused = false;
  let busy = false;
  let disposed = false;
  let previousFocus: HTMLElement | null = null;
  const panel = document.createElement("aside");
  panel.className = "headless-reconnect";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const controls = document.createElement("div");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = i18n._(msg`Reconnect`);
  panel.append(status, controls);

  const paired = Boolean(original.devicePairing && !original.canManageDevices);
  let invite: string | undefined;
  let editingInvite = false;
  let checkAgain = false;
  async function reconnect() {
    if (busy || disposed) return;
    busy = true;
    checkAgain = false;
    retry.disabled = true;
    status.textContent = i18n._(msg`Reconnecting to your workspace…`);
    try {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- HTTP endpoint
      let session = await serverRequest<HeadlessSession>("/api/session");
      if (!session.authenticated && paired && session.devicePairing) {
        if (invite) {
          editingInvite = true;
          session = await confirmDevicePairing(() => invite!, controls);
          invite = undefined;
          editingInvite = false;
        } else {
          // eslint-disable-next-line lingui/no-unlocalized-strings -- HTTP endpoint
          session = await serverRequest<HeadlessSession>("/api/devices/resume", {});
        }
      }
      if (disposed) return;
      if (!session.authenticated && !paired && Boolean(session.devicePairing) === Boolean(original.devicePairing)) {
        status.textContent = i18n._(msg`Sign in to keep editing. Your unsaved changes are still in this tab.`);
        session = await showServerLogin(original.devicePairing, controls);
      }
      if (disposed) return;
      if (!session.authenticated || Boolean(session.devicePairing) !== Boolean(original.devicePairing) ||
          Boolean(session.canManageDevices) !== Boolean(original.canManageDevices)) throw new Error();
      await restore(session);
      if (disposed) return;
      paused = false;
      invite = undefined;
      panel.remove();
      if (document.activeElement === document.body) previousFocus?.focus({ preventScroll: true });
    } catch {
      if (disposed) return;
      status.textContent = paired
        ? i18n._(msg`Could not reconnect. If your device needs pairing, open a new invite in another tab of this browser, then reconnect here. Your edits are still here.`)
        : i18n._(msg`Could not reopen this project. Keep this tab open and reconnect when the workspace is available.`);
      controls.replaceChildren(retry);
    } finally {
      busy = false;
      retry.disabled = false;
      if (paused && checkAgain) void reconnect();
    }
  }
  retry.onclick = () => { void reconnect(); };
  const expired = () => {
    if (paused || disposed) return;
    paused = true;
    disconnected();
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.append(panel);
    void reconnect();
  };
  const stopLaunches = paired ? watchPairingLaunches(async (code) => {
    // A healthy paired device ignores a new invitation, just as opening the
    // same URL in a browser tab does. A revoked device can pair over its editor.
    if (!paused) {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- HTTP endpoint
      const current = await serverRequest<HeadlessSession>("/api/session").catch(() => null);
      if (disposed || !current || current.authenticated || !current.devicePairing) return;
      invite = code;
      expired();
    } else {
      invite = code;
      if (busy && !editingInvite) checkAgain = true;
      else if (!busy) void reconnect();
    }
  }) : undefined;
  window.addEventListener("lattice:session-expired", expired);
  return {
    requireConnected() { if (paused) throw new Error(sessionExpired()); },
    dispose() {
      disposed = true;
      stopLaunches?.();
      window.removeEventListener("lattice:session-expired", expired);
      panel.remove();
    },
  };
}
