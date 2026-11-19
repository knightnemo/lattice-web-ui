import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { serverRequest, type HeadlessSession } from "./headless-runtime";

function signInHeader(heading: string) {
  const header = document.createElement("header");
  const address = document.createElement("p");
  address.className = "headless-workspace-address";
  address.textContent = window.location.host;
  const title = document.createElement("h1");
  title.textContent = heading;
  header.append(address, title);
  return header;
}

/** Keep the access token in the form only; the server issues an HttpOnly session cookie. */
export function showServerLogin(devicePairing = false, root = document.getElementById("root")!): Promise<HeadlessSession> {
  return new Promise((resolve) => {
    const form = document.createElement("form");
    form.className = "headless-login";
    const landing = root.id === "root";
    const title = signInHeader(i18n._(msg`Open workspace`));
    const label = document.createElement("label");
    label.textContent = i18n._(msg`Server access token`);
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.required = true;
    input.spellcheck = false;
    label.append(input);
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = i18n._(msg`Connect`);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    form.append(title);
    const hint = document.createElement("p");
    hint.className = "headless-login-hint";
    if (devicePairing && landing) {
      hint.textContent = i18n._(msg`On a new device, scan the pairing code from the owner's workspace or open their invitation link.`);
      const owner = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = i18n._(msg`Workspace owner sign-in`);
      owner.append(summary, label, button, status);
      form.append(hint, owner);
    } else {
      hint.textContent = i18n._(msg`Use the access token from the computer hosting this workspace.`);
      form.append(hint, label, button, status);
    }
    root.replaceChildren(form);
    // Keep focus in a recovering editor. A fresh touch session can open its keyboard on demand.
    if (landing && !devicePairing && window.matchMedia("(pointer: fine)").matches) input.focus();
    form.onsubmit = async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        // eslint-disable-next-line lingui/no-unlocalized-strings -- HTTP endpoint, never interface copy
        const session = await serverRequest<HeadlessSession>("/api/session", { token: input.value });
        if (!session.authenticated) throw new Error(i18n._(msg`Could not authenticate with this server.`));
        input.value = "";
        root.replaceChildren();
        resolve(session);
      } catch {
        input.value = "";
        status.textContent = i18n._(msg`Connection failed. Check the server access token and try again.`);
        input.focus();
      } finally {
        button.disabled = false;
      }
    };
  });
}

export function takePairingCode(): string | null {
  if (!window.location.hash.startsWith("#pair=")) return null;
  const code = window.location.hash.slice(6);
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  return /^[a-f0-9]{64}$/i.test(code) ? code : null;
}

/** A focus-existing launch has a target URL but deliberately leaves the editor in place. */
export function watchPairingLaunches(receive: (code: string) => void) {
  const queue = (window as Window & {
    launchQueue?: { setConsumer: (consumer: (params: { targetURL?: string }) => void) => void };
  }).launchQueue;
  let active = true;
  queue?.setConsumer(({ targetURL }) => {
    if (!active || !targetURL) return;
    const url = new URL(targetURL);
    if (url.origin === location.origin && url.pathname === "/" && /^#pair=[a-f0-9]{64}$/i.test(url.hash)) {
      receive(url.hash.slice(6));
    }
  });
  return () => { active = false; };
}

/** An already-open sign-in screen also accepts a new invitation from the installed app. */
export async function signInPairedDevice(initialCode: string | null): Promise<HeadlessSession> {
  let stop: (() => void) | undefined;
  try {
    return await new Promise<HeadlessSession>((resolve, reject) => {
      let latestCode = initialCode;
      const confirm = () => confirmDevicePairing(() => latestCode!, document.getElementById("root")!);
      stop = watchPairingLaunches((code) => {
        const alreadyShowing = Boolean(latestCode);
        latestCode = code;
        if (!alreadyShowing) void confirm().then(resolve, reject);
      });
      const signIn = initialCode ? confirm() : showServerLogin(true);
      void signIn.then(resolve, reject);
    });
  } finally { stop?.(); }
}

/** Camera previews can load the link, but only a deliberate submit redeems it. */
export function confirmDevicePairing(getCode: () => string, root: HTMLElement): Promise<HeadlessSession> {
  return new Promise((resolve) => {
    const form = document.createElement("form");
    form.className = "headless-login";
    const title = signInHeader(i18n._(msg`Pair this device`));
    const label = document.createElement("label");
    label.textContent = i18n._(msg`Device name`);
    const input = document.createElement("input");
    input.required = true;
    input.maxLength = 64;
    input.autocomplete = "off";
    label.append(input);
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = i18n._(msg`Connect this device`);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    form.append(title, label, button, status);
    root.replaceChildren(form);
    let redeemed: string | undefined;
    form.onsubmit = async (event) => {
      event.preventDefault();
      button.disabled = true;
      const code = getCode();
      try {
        /* eslint-disable lingui/no-unlocalized-strings -- transport routes */
        if (redeemed !== code) await serverRequest("/api/devices/pair", { code, label: input.value });
        redeemed = code;
        const session = await serverRequest<HeadlessSession>("/api/devices/resume", {});
        /* eslint-enable lingui/no-unlocalized-strings */
        if (!session.authenticated) throw new Error();
        root.replaceChildren();
        resolve(session);
      } catch {
        status.textContent = redeemed === code
          ? i18n._(msg`Could not start the workspace session. Try again.`)
          : i18n._(msg`Could not pair this device. Check its name or scan a new link.`);
      } finally {
        button.disabled = false;
      }
    };
  });
}
