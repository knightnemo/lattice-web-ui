// lattice-gateway's own pages: sign-in and pairing, nothing else. Phone and app
// is a dialog in the workspace (bridge.js).
// They follow the v0.4.x remote-workspace pages
// (src/platform/headless-login.ts): same layout, same copy.
// No framework and no third-party code.
"use strict";

function interfaceLanguage() {
  // Lattice keeps the chosen interface language in this origin's storage.
  try {
    const saved = JSON.parse(localStorage.getItem("lattice.appearance.v5") || "{}").interfaceLanguage;
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch { /* fall back to the browser */ }
  return /^zh\b/i.test(navigator.language || "") ? "zh-CN" : "en";
}
const zh = interfaceLanguage() === "zh-CN";
document.documentElement.lang = zh ? "zh-CN" : "en";

const T = zh ? {
  openWorkspace: "打开工作区",
  tokenLabel: "服务器访问令牌",
  connect: "连接",
  pairingHint: "在新设备上，请扫描工作区所有者提供的配对码，或打开对方发来的邀请链接。",
  ownerSignIn: "工作区所有者登录",
  connectionFailed: "连接失败。请检查服务器访问令牌后重试。",
  pairThisDevice: "配对此设备",
  deviceName: "设备名称",
  connectThisDevice: "连接此设备",
  invalidInvitation: "这个配对链接无效。请重新扫描二维码，或请所有者再发一次链接。",
  failed: "请求失败，请检查网络后重试。",
} : {
  openWorkspace: "Open workspace",
  tokenLabel: "Server access token",
  connect: "Connect",
  pairingHint: "On a new device, scan the pairing code from the owner's workspace or open their invitation link.",
  ownerSignIn: "Workspace owner sign-in",
  connectionFailed: "Connection failed. Check the server access token and try again.",
  pairThisDevice: "Pair this device",
  deviceName: "Device name",
  connectThisDevice: "Connect this device",
  invalidInvitation: "This pairing link isn't valid. Scan the code again, or ask the owner for a new link.",
  failed: "The request failed. Check the connection and try again.",
};

const root = document.getElementById("app");
const page = document.body.dataset.page;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** The v0.4.x header: the workspace's address above the page title. */
function header(title) {
  return el("header", {}, el("p", { class: "headless-workspace-address" }, location.host), el("h1", {}, title));
}

function shell(variant, ...children) {
  root.className = `headless-login ${variant || ""}`.trim();
  root.replaceChildren(...children);
}

async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value = {};
  try { value = await response.json(); } catch { /* empty body */ }
  if (!response.ok) throw Object.assign(new Error(value?.error?.message || T.failed), { status: response.status, value });
  return value;
}

function nextTarget() {
  const next = new URLSearchParams(location.search).get("next") || "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Linux";
}

function renderLogin() {
  const input = el("input", { id: "token", type: "password", autocomplete: "off", spellcheck: "false", required: true });
  const button = el("button", { type: "submit" }, T.connect);
  const status = el("p", { role: "status" });
  const label = el("label", { for: "token" }, T.tokenLabel, input);
  const owner = el("details", { open: !!new URLSearchParams(location.search).get("next") && new URLSearchParams(location.search).get("next") !== "/" ? true : false },
    el("summary", {}, T.ownerSignIn), label, button, status);
  const form = el("form", { onsubmit: async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await call("/__gateway/api/login", { token: input.value });
      input.value = "";
      location.replace(nextTarget());
    } catch {
      input.value = "";
      status.textContent = T.connectionFailed;
      input.focus();
      button.disabled = false;
    }
  } }, owner);
  shell("", header(T.openWorkspace), el("p", { class: "headless-login-hint" }, T.pairingHint), form);
  owner.addEventListener("toggle", () => { if (owner.open) input.focus(); });
}

function renderPair() {
  const code = location.hash.slice(1);
  // The code stays out of history and of anything that reads the URL later.
  if (code) history.replaceState(null, "", location.pathname);
  if (!/^[0-9a-f]{48}$/.test(code)) {
    shell("", header(T.pairThisDevice), el("p", { role: "status" }, T.invalidInvitation));
    return;
  }
  const input = el("input", { id: "label", maxlength: "48", autocomplete: "off", required: true, value: guessDeviceName() });
  const button = el("button", { type: "submit" }, T.connectThisDevice);
  const status = el("p", { role: "status" });
  const form = el("form", { onsubmit: async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "";
    try {
      await call("/__gateway/api/redeem", { code, label: input.value });
      location.replace("/");
    } catch (e) {
      status.textContent = e.message;
      button.disabled = false;
    }
  } }, el("label", { for: "label" }, T.deviceName, input), button, status);
  shell("", header(T.pairThisDevice), form);
}

({ login: renderLogin, pair: renderPair }[page] || renderLogin)();
