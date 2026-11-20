// lattice-gateway's own pages: sign-in, pairing, devices, projects, host windows,
// TeX packages and the terminal. They follow the v0.4.x remote-workspace pages
// (src/platform/headless-login.ts, headless-devices.tsx): same layout, same copy.
// No framework and no third-party code except xterm.js on the terminal page.
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
  projects: "项目",
  projectsHint: "选择一个项目，Lattice 会在这个标签页里打开它。",
  noProjects: "项目文件夹里还没有项目。",
  open: "打开",
  noTex: "没有 .tex 文件",
  hostWindows: "主机上的窗口",
  hostWindowsHint: "Lattice 的原生窗口（选择文件夹、Overleaf 登录等）显示在主机的虚拟屏幕上。在这里点击和输入，就是在操作那些窗口。",
  typeText: "输入文字",
  send: "发送",
  texPackages: "TeX 宏包",
  texHint: "输入编译时缺少的文件（如 lipsum.sty）或宏包名，主机会用 tlmgr 安装。",
  texName: "文件或宏包",
  install: "安装",
  installed: (p) => `已安装 ${p}。回到工作区重新编译即可。`,
  choose: (list) => `有多个宏包提供这个文件：${list}。请输入其中一个宏包名。`,
  terminal: "终端",
  terminalHint: "主机上的 shell，以你的用户身份运行。",
  terminalClosed: "终端已关闭。",
  reconnect: "重新连接",
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
  projects: "Projects",
  projectsHint: "Pick a project and Lattice opens it in this tab.",
  noProjects: "The projects folder has no projects yet.",
  open: "Open",
  noTex: "no .tex file",
  hostWindows: "Windows on the host",
  hostWindowsHint: "Lattice's native windows, such as the folder picker and Overleaf sign-in, appear on the host's virtual screen. Click and type here to use them.",
  typeText: "Type text",
  send: "Send",
  texPackages: "TeX packages",
  texHint: "Enter the file a build reported missing (such as lipsum.sty) or a package name, and the host installs it with tlmgr.",
  texName: "File or package",
  install: "Install",
  installed: (p) => `Installed ${p}. Build again in the workspace.`,
  choose: (list) => `Several packages provide this file: ${list}. Enter one of them.`,
  terminal: "Terminal",
  terminalHint: "A shell on the host, running as your user.",
  terminalClosed: "The terminal closed.",
  reconnect: "Reconnect",
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

async function renderProjects() {
  const list = el("ul", { class: "headless-device-list" });
  const status = el("p", { role: "status" });
  let me = { kind: "anonymous" };
  try { me = await call("/__gateway/api/whoami"); } catch { /* signed-in check happens on the server */ }
  try {
    const { projects } = await call("/__gateway/api/projects");
    list.replaceChildren(...(projects.length ? projects.map((project) => el("li", {},
      el("span", {}, project.name, project.hasTex ? null : el("span", { class: "secondary-text" }, ` · ${T.noTex}`)),
      el("button", { onclick: () => {
        // The workspace page opens it with Lattice's own command once it is connected (bridge.js).
        try { sessionStorage.setItem("lattice-gateway.open-project", JSON.stringify({ name: project.name, path: project.path })); }
        catch (e) { status.textContent = e.message; return; }
        location.assign("/");
      } }, T.open))) : [el("li", { class: "secondary-text" }, T.noProjects)]));
  } catch (e) {
    status.textContent = e.message;
  }
  const links = el("div", { class: "actions start" }, backLink());
  if (me.kind === "owner") {
    const config = await call("/__gateway/api/config").catch(() => ({}));
    links.append(el("a", { class: "button ghost", href: "/__gateway/devices" }, T.remoteDevices));
    if (config.screen) links.append(el("a", { class: "button ghost", href: "/__gateway/screen" }, T.hostWindows));
    if (config.tex) links.append(el("a", { class: "button ghost", href: "/__gateway/tex" }, T.texPackages));
    if (config.terminal) links.append(el("a", { class: "button ghost", href: "/__gateway/terminal" }, T.terminal));
  }
  shell("wide", header(T.projects), el("p", { class: "headless-login-hint" }, T.projectsHint), list, status, links);
}

function renderScreen() {
  const status = el("p", { role: "status" });
  const image = el("img", { class: "screen", alt: T.hostWindows, draggable: "false" });
  let lastInput = 0;
  let offset = [0, 0];
  const send = async (input) => {
    status.textContent = "";
    lastInput = Date.now();
    try { await call("/__gateway/api/screen/input", input); refresh(); } catch (e) { status.textContent = e.message; }
  };
  // A folder picked in Lattice's dialog opens in a new workspace; follow it from here.
  (async function follow() {
    if (Date.now() - lastInput < 60000) {
      try {
        const response = await fetch("/__gateway/api/open-request", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (response.status === 200) {
          const { url } = await response.json();
          if (/^\/\?entry=[\w-]+$/.test(url)) { location.assign(url); return; }
        }
      } catch { /* retry */ }
    }
    setTimeout(follow, 1500);
  })();
  image.addEventListener("click", (event) => {
    const box = image.getBoundingClientRect();
    const x = offset[0] + Math.round((event.clientX - box.left) * image.naturalWidth / box.width);
    const y = offset[1] + Math.round((event.clientY - box.top) * image.naturalHeight / box.height);
    send({ type: "click", x, y });
  });
  let timer;
  let shown;
  async function refresh() {
    clearTimeout(timer);
    try {
      const response = await fetch(`/__gateway/api/screen.png?t=${Date.now()}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(T.failed);
      offset = (response.headers.get("x-screen-offset") || "0,0").split(",").map(Number);
      const url = URL.createObjectURL(await response.blob());
      image.src = url;
      if (shown) URL.revokeObjectURL(shown);
      shown = url;
      schedule();
    } catch (e) {
      status.textContent = e.message;
      schedule(2000);
    }
  }
  function schedule(delay = 800) {
    clearTimeout(timer);
    timer = setTimeout(() => (document.visibilityState === "visible" ? refresh() : schedule()), delay);
  }
  const text = el("input", { id: "text", autocomplete: "off", spellcheck: "false" });
  const keys = [["Return", "Enter"], ["Tab", "Tab"], ["Escape", "Esc"], ["BackSpace", "⌫"], ["Up", "↑"], ["Down", "↓"], ["ctrl+a", "Ctrl+A"]]
    .map(([key, label]) => el("button", { onclick: () => send({ type: "key", key }) }, label));
  shell("full", header(T.hostWindows), el("p", { class: "headless-login-hint" }, T.hostWindowsHint), image,
    el("form", { onsubmit: (event) => { event.preventDefault(); if (text.value) send({ type: "text", text: text.value }); text.value = ""; } },
      el("label", { for: "text" }, T.typeText, text), el("button", { type: "submit" }, T.send)),
    el("div", { class: "keys" }, ...keys), status, el("div", { class: "actions start" }, backLink()));
  refresh();
}

function renderTex() {
  const status = el("p", { role: "status" });
  const name = el("input", { id: "name", autocomplete: "off", spellcheck: "false", required: true, value: new URLSearchParams(location.search).get("name") || "" });
  const button = el("button", { type: "submit" }, T.install);
  shell("", header(T.texPackages), el("p", { class: "headless-login-hint" }, T.texHint),
    el("form", { onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true; status.textContent = "…";
      try {
        const value = await call("/__gateway/api/tex-install", { name: name.value.trim() });
        status.textContent = T.installed(value.package);
      } catch (e) {
        status.textContent = e.value?.error?.code === "choose_package" ? T.choose(e.value.error.packages.join(", ")) : e.message;
      }
      button.disabled = false;
    } }, el("label", { for: "name" }, T.texName, name), button, status),
    el("div", { class: "actions start" }, backLink()));
}

function load(tag, attributes) {
  return new Promise((resolve, reject) => {
    const node = Object.assign(document.createElement(tag), attributes);
    node.onload = resolve;
    node.onerror = reject;
    document.head.append(node);
  });
}

async function renderTerminal() {
  const status = el("p", { role: "status" });
  const host = el("div", { class: "terminal" });
  const again = el("button", { hidden: true }, T.reconnect);
  shell("full", header(T.terminal), el("p", { class: "headless-login-hint" }, T.terminalHint), host, status,
    el("div", { class: "actions start" }, again, backLink()));
  await load("link", { rel: "stylesheet", href: "/__gateway/vendor/xterm.css" });
  await load("script", { src: "/__gateway/vendor/xterm.js" });
  await load("script", { src: "/__gateway/vendor/addon-fit.js" });
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const term = new window.Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: "\"Ioskeley Mono\", Menlo, \"SF Mono\", ui-monospace, monospace",
    theme: dark ? { background: "#171718", foreground: "#e9e9e7", cursor: "#e7e7e4" } : { background: "#ffffff", foreground: "#242426", cursor: "#303033", selectionBackground: "#d6d6d8" },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  let socket;
  const send = (message) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  term.onData((data) => send({ type: "input", data }));
  const resize = () => { fit.fit(); send({ type: "resize", cols: term.cols, rows: term.rows }); };
  addEventListener("resize", resize);
  function connect() {
    again.hidden = true;
    status.textContent = "";
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/__gateway/api/terminal`);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => { resize(); term.focus(); };
    socket.onmessage = (event) => term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
    socket.onclose = () => { status.textContent = T.terminalClosed; again.hidden = false; };
  }
  again.addEventListener("click", () => { term.reset(); connect(); });
  connect();
}

({ login: renderLogin, pair: renderPair, devices: renderDevices, projects: renderProjects, screen: renderScreen, tex: renderTex, terminal: renderTerminal }[page] || renderLogin)();
