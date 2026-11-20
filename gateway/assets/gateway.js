// lattice-gateway's own pages: sign-in, pairing and Remote devices, nothing else.
// They follow the v0.4.x remote-workspace pages
// (src/platform/headless-login.ts, headless-devices.tsx): same layout, same copy.
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
  tokenHint: "请输入托管此工作区的电脑上的访问令牌。",
  pairingHint: "在新设备上，请扫描工作区所有者提供的配对码，或打开对方发来的邀请链接。",
  ownerSignIn: "工作区所有者登录",
  connectionFailed: "连接失败。请检查服务器访问令牌后重试。",
  pairThisDevice: "配对此设备",
  deviceName: "设备名称",
  connectThisDevice: "连接此设备",
  invalidInvitation: "这个配对链接无效。请重新扫描二维码，或请所有者再发一次链接。",
  remoteDevices: "远程设备",
  scanHint: "用另一台设备扫描此二维码。二维码仅可使用一次，两分钟后失效。",
  copyLink: "复制配对链接",
  linkCopied: "已复制配对链接。",
  copyFailed: "无法复制配对链接。",
  revoke: "撤销",
  refresh: "刷新设备列表",
  pairDevice: "配对设备",
  loadFailed: "无法加载已配对设备。",
  inviteFailed: "无法生成配对码。",
  revokeFailed: "无法撤销此设备的访问权限。",
  noDevices: "还没有配对的设备。",
  backToWorkspace: "返回工作区",
  signOut: "退出登录",
  failed: "请求失败，请检查网络后重试。",
} : {
  openWorkspace: "Open workspace",
  tokenLabel: "Server access token",
  connect: "Connect",
  tokenHint: "Use the access token from the computer hosting this workspace.",
  pairingHint: "On a new device, scan the pairing code from the owner's workspace or open their invitation link.",
  ownerSignIn: "Workspace owner sign-in",
  connectionFailed: "Connection failed. Check the server access token and try again.",
  pairThisDevice: "Pair this device",
  deviceName: "Device name",
  connectThisDevice: "Connect this device",
  invalidInvitation: "This pairing link isn't valid. Scan the code again, or ask the owner for a new link.",
  remoteDevices: "Remote devices",
  scanHint: "Scan this code on your other device. It can be used once and expires in two minutes.",
  copyLink: "Copy pairing link",
  linkCopied: "Pairing link copied.",
  copyFailed: "Could not copy the pairing link.",
  revoke: "Revoke",
  refresh: "Refresh devices",
  pairDevice: "Pair a device",
  loadFailed: "Could not load paired devices.",
  inviteFailed: "Could not create a pairing code.",
  revokeFailed: "Could not revoke this device.",
  noDevices: "No devices are paired yet.",
  backToWorkspace: "Back to workspace",
  signOut: "Sign out",
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

function backLink() {
  return el("a", { class: "button ghost", href: "/" }, T.backToWorkspace);
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

async function renderDevices() {
  const list = el("ul", { class: "headless-device-list" });
  const code = el("div", { class: "headless-device-code", hidden: true });
  const status = el("p", { role: "status" });
  let busy = false;
  let expiry;

  async function refresh() {
    try {
      const { devices } = await call("/__gateway/api/devices");
      list.replaceChildren(...devices.map((device) => el("li", {},
        el("span", {}, device.label),
        el("button", { class: "danger", onclick: (event) => revoke(device.id, event.currentTarget) }, T.revoke))));
      if (!devices.length) list.replaceChildren(el("li", { class: "secondary-text" }, T.noDevices));
    } catch {
      status.textContent = T.loadFailed;
    }
  }
  async function revoke(id, button) {
    if (busy) return;
    busy = true; button.disabled = true; status.textContent = "";
    try { await call(`/__gateway/api/devices/${encodeURIComponent(id)}/revoke`, {}); await refresh(); }
    catch { status.textContent = T.revokeFailed; button.disabled = false; }
    busy = false;
  }
  async function invite() {
    if (busy) return;
    busy = true; pair.disabled = true; status.textContent = "";
    clearTimeout(expiry);
    try {
      const { url, expiresIn, qrSvg } = await call("/__gateway/api/invites", {});
      code.replaceChildren(
        el("img", { alt: "", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}` }),
        el("p", {}, T.scanHint),
        el("button", { onclick: async () => {
          try { await navigator.clipboard.writeText(url); status.textContent = T.linkCopied; }
          catch { status.textContent = T.copyFailed; }
        } }, T.copyLink));
      code.hidden = false;
      expiry = setTimeout(() => { code.hidden = true; refresh(); }, expiresIn * 1000);
      // A device that pairs shows up in the list.
      const poll = setInterval(refresh, 5000);
      setTimeout(() => clearInterval(poll), expiresIn * 1000);
    } catch {
      status.textContent = T.inviteFailed;
    }
    busy = false; pair.disabled = false;
  }
  const pair = el("button", { class: "primary", onclick: invite }, T.pairDevice);
  let me = {};
  try { me = await call("/__gateway/api/whoami"); } catch { /* shown as the owner page anyway */ }
  const leading = el("div", { class: "actions start" });
  if (me.publicOrigin && location.origin === document.body.dataset.origin) {
    leading.append(backLink(), el("button", { class: "ghost", onclick: async () => {
      await call("/__gateway/api/logout", {}).catch(() => {});
      location.replace("/__gateway/login");
    } }, T.signOut));
  }
  shell("wide", header(T.remoteDevices), code, list, status,
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: refresh }, T.refresh), pair), leading);
  await refresh();
}

({ login: renderLogin, pair: renderPair, devices: renderDevices }[page] || renderLogin)();
