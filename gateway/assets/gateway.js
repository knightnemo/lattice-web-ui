// Sign-in, pairing and device management pages for lattice-gateway.
// No framework and no third-party code: this page decides who reaches the workspace.
"use strict";

const zh = /^zh\b/i.test(navigator.language || "");
const T = zh ? {
  brand: "Lattice 远程工作区",
  loginTitle: "打开这个工作区",
  loginPairHint: "要在这台设备上使用，请让工作区的所有者给你一个配对二维码或链接。",
  ownerHeading: "我是所有者",
  tokenLabel: "恢复令牌",
  tokenHint: "令牌保存在主机上的 access-token 文件里。",
  signIn: "登录",
  pairTitle: "连接这台设备",
  pairCheck: "确认这是你要连接的工作区：",
  deviceName: "设备名称",
  connect: "连接这台设备",
  noCode: "这个链接里没有配对码。请重新扫码，或让所有者再发一次链接。",
  devicesTitle: "已配对的设备",
  none: "还没有配对的设备。",
  lastSeen: "最近使用",
  revoke: "撤销",
  revokeConfirm: "再点一次确认撤销",
  pairNew: "配对新设备",
  scan: "用手机相机扫描，或把链接发到要配对的设备上。链接只能用一次。",
  expiresIn: (s) => `${s} 秒后过期`,
  expired: "已过期，请重新生成。",
  copy: "复制链接",
  copied: "已复制",
  openWorkspace: "打开工作区",
  signOut: "退出登录",
  never: "从未",
  failed: "请求失败，请检查网络后重试。",
  projectsTitle: "在 Lattice 中打开项目",
  projectsHint: "选择一个项目，Lattice 会在这个标签页里打开它。",
  noProjects: "项目文件夹里还没有项目。",
  open: "在 Lattice 中打开",
  noTex: "没有 .tex 文件",
  devices: "设备",
  backToWorkspace: "回到工作区",
  screenTitle: "主机上的窗口",
  screenHint: "Lattice 的原生窗口（选择文件夹、Overleaf 登录等）显示在主机的虚拟屏幕上。在这里点击和输入，就是在操作那些窗口。",
  typeText: "输入文字",
  send: "发送",
  hostWindows: "主机窗口",
  texTitle: "安装 TeX 宏包",
  texHint: "Lattice 在 Linux 上还不能一键补包。输入编译报缺的文件（如 lipsum.sty）或宏包名，网关会在主机上用 tlmgr 安装。Lattice 里的“安装”按钮也会走这里。",
  texName: "文件或宏包",
  install: "安装",
  installed: (p) => `已安装 ${p}。回到工作区重新编译即可。`,
  choose: (list) => `有多个宏包提供这个文件：${list}。请输入其中一个宏包名。`,
  texPackages: "TeX 宏包",
  terminalTitle: "主机终端",
  terminal: "终端",
  terminalHint: "在主机上以你的用户身份运行的 shell。Lattice 自己的终端只在原生窗口里可用；这是网关为 owner 提供的独立终端。",
  terminalClosed: "终端已关闭。",
  reconnect: "重新连接",
} : {
  brand: "Lattice remote workspace",
  loginTitle: "Open this workspace",
  loginPairHint: "To use it on this device, ask the workspace owner for a pairing QR code or link.",
  ownerHeading: "I'm the owner",
  tokenLabel: "Recovery token",
  tokenHint: "The token is in the access-token file on the host.",
  signIn: "Sign in",
  pairTitle: "Connect this device",
  pairCheck: "Check that this is the workspace you mean to connect to:",
  deviceName: "Device name",
  connect: "Connect this device",
  noCode: "This link has no pairing code. Scan the QR code again, or ask the owner for a new link.",
  devicesTitle: "Paired devices",
  none: "No devices are paired yet.",
  lastSeen: "Last used",
  revoke: "Revoke",
  revokeConfirm: "Click again to revoke",
  pairNew: "Pair a device",
  scan: "Scan with the phone's camera, or send the link to the device you're pairing. It works once.",
  expiresIn: (s) => `Expires in ${s} s`,
  expired: "Expired. Create a new one.",
  copy: "Copy link",
  copied: "Copied",
  openWorkspace: "Open workspace",
  signOut: "Sign out",
  never: "never",
  failed: "The request failed. Check the connection and try again.",
  projectsTitle: "Open a project in Lattice",
  projectsHint: "Pick a project and Lattice opens it in this tab.",
  noProjects: "The projects folder has no projects yet.",
  open: "Open in Lattice",
  noTex: "no .tex file",
  devices: "Devices",
  backToWorkspace: "Back to the workspace",
  screenTitle: "Windows on the host",
  screenHint: "Lattice's native windows, such as the folder picker and Overleaf sign-in, appear on the host's virtual screen. Click and type here to use them.",
  typeText: "Type text",
  send: "Send",
  hostWindows: "Host windows",
  texTitle: "Install a TeX package",
  texHint: "Lattice has no one-click package install on Linux yet. Enter the file a build reported missing (such as lipsum.sty) or a package name, and the gateway installs it on the host with tlmgr. Lattice's own Install button uses this too.",
  texName: "File or package",
  install: "Install",
  installed: (p) => `Installed ${p}. Build again in the workspace.`,
  choose: (list) => `Several packages provide this file: ${list}. Enter one of them.`,
  texPackages: "TeX packages",
  terminalTitle: "Terminal on the host",
  terminal: "Terminal",
  terminalHint: "A shell on the host, as your user. Lattice keeps its own terminal to its native window; this one is the gateway's, for the owner.",
  terminalClosed: "The terminal closed.",
  reconnect: "Reconnect",
};
document.documentElement.lang = zh ? "zh-CN" : "en";

const app = document.getElementById("app");
const page = document.body.dataset.page;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function brand() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h16v16H4zM4 12h16M12 4v16"/>';
  return el("div", { class: "brand" }, svg, T.brand);
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
  if (!response.ok) throw new Error(value?.error?.message || T.failed);
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
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}

function renderLogin() {
  const error = el("p", { class: "error", role: "alert" });
  const token = el("input", { id: "token", type: "password", autocomplete: "current-password", spellcheck: "false", required: "" });
  const submit = el("button", { type: "submit" }, T.signIn);
  const form = el("form", {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      try {
        await call("/__gateway/api/login", { token: token.value });
        location.replace(nextTarget());
      } catch (e) {
        error.textContent = e.message;
        submit.disabled = false;
      }
    },
  },
  el("label", { for: "token" }, T.tokenLabel), token, el("p", { class: "muted" }, T.tokenHint), submit, error);
  app.replaceChildren(
    brand(),
    el("h1", {}, T.loginTitle),
    el("p", {}, T.loginPairHint),
    el("hr", { class: "divider" }),
    el("h2", { class: "muted" }, T.ownerHeading),
    form,
  );
}

function renderPair() {
  const code = location.hash.slice(1);
  // The code stays out of history and of anything that reads the URL later.
  if (code) history.replaceState(null, "", location.pathname);
  if (!/^[0-9a-f]{48}$/.test(code)) {
    app.replaceChildren(brand(), el("h1", {}, T.pairTitle), el("p", { class: "error" }, T.noCode));
    return;
  }
  const error = el("p", { class: "error", role: "alert" });
  const name = el("input", { id: "label", maxlength: "48", value: guessDeviceName(), required: "" });
  const submit = el("button", { type: "submit" }, T.connect);
  app.replaceChildren(
    brand(),
    el("h1", {}, T.pairTitle),
    el("p", { class: "muted" }, T.pairCheck),
    el("div", { class: "host" }, location.host),
    el("form", {
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        error.textContent = "";
        try {
          await call("/__gateway/api/redeem", { code, label: name.value });
          location.replace("/");
        } catch (e) {
          error.textContent = e.message;
          submit.disabled = false;
        }
      },
    }, el("label", { for: "label" }, T.deviceName), name, submit, error),
  );
}

function when(seconds) {
  if (!seconds) return T.never;
  return new Date(seconds * 1000).toLocaleString(zh ? "zh-CN" : undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function renderDevices() {
  app.classList.add("wide");
  const error = el("p", { class: "error", role: "alert" });
  const list = el("ul", { class: "devices" });
  const invite = el("div", { class: "stack" });
  let me = { kind: "anonymous" };
  try { me = await call("/__gateway/api/whoami"); } catch { /* shown below */ }
  const onPublic = location.origin === document.body.dataset.origin && me.publicOrigin;

  async function refresh() {
    try {
      const { devices } = await call("/__gateway/api/devices");
      list.replaceChildren(...(devices.length ? devices.map(device) : [el("li", { class: "muted" }, T.none)]));
    } catch (e) {
      error.textContent = e.message;
    }
  }

  function device(d) {
    let armed = false;
    const button = el("button", {
      class: "danger",
      onclick: async () => {
        if (!armed) { armed = true; button.textContent = T.revokeConfirm; setTimeout(() => { armed = false; button.textContent = T.revoke; }, 4000); return; }
        button.disabled = true;
        try { await call(`/__gateway/api/devices/${encodeURIComponent(d.id)}/revoke`, {}); await refresh(); }
        catch (e) { error.textContent = e.message; button.disabled = false; }
      },
    }, T.revoke);
    return el("li", {}, el("div", {}, el("div", { class: "name" }, d.label), el("div", { class: "muted" }, `${T.lastSeen}: ${when(d.lastSeenAt)}`)), button);
  }

  let timer;
  const pair = el("button", {
    onclick: async () => {
      pair.disabled = true;
      clearInterval(timer);
      try {
        const { url, expiresIn, qrSvg } = await call("/__gateway/api/invites", {});
        const left = el("span", { class: "countdown muted" }, T.expiresIn(expiresIn));
        const copy = el("button", { class: "secondary", onclick: async () => {
          try { await navigator.clipboard.writeText(url); copy.textContent = T.copied; } catch { link.select(); }
        } }, T.copy);
        const link = el("input", { readonly: "", value: url, "aria-label": "Pairing link" });
        const img = el("img", { alt: "Pairing QR code", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}` });
        invite.replaceChildren(el("div", { class: "qr" }, img, el("p", { class: "muted" }, T.scan), link, el("div", { class: "row" }, copy), left));
        let remaining = expiresIn;
        timer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) { clearInterval(timer); invite.replaceChildren(el("p", { class: "muted" }, T.expired)); refresh(); return; }
          left.textContent = T.expiresIn(remaining);
          if (remaining % 5 === 0) refresh();
        }, 1000);
      } catch (e) {
        error.textContent = e.message;
      } finally {
        pair.disabled = false;
      }
    },
  }, T.pairNew);

  const actions = el("div", { class: "row" }, pair);
  if (onPublic) {
    actions.append(
      el("a", { class: "button secondary", href: "/" }, T.openWorkspace),
      el("button", { class: "secondary", onclick: async () => { await call("/__gateway/api/logout", {}).catch(() => {}); location.replace("/__gateway/login"); } }, T.signOut),
    );
  }
  app.replaceChildren(brand(), el("h1", {}, T.devicesTitle), list, actions, invite, error);
  await refresh();
}

async function renderProjects() {
  app.classList.add("wide");
  const error = el("p", { class: "error", role: "alert" });
  const list = el("ul", { class: "devices" });
  let me = { kind: "anonymous" };
  try { me = await call("/__gateway/api/whoami"); } catch { /* shown below */ }
  try {
    const { projects } = await call("/__gateway/api/projects");
    list.replaceChildren(...(projects.length ? projects.map((project) => el("li", {},
      el("div", {}, el("div", { class: "name" }, project.name), el("div", { class: "muted" }, project.hasTex ? project.path : `${project.path} · ${T.noTex}`)),
      el("button", { onclick: () => {
        // The workspace page opens it with Lattice's own command once it is connected (bridge.js).
        try { sessionStorage.setItem("lattice-gateway.open-project", JSON.stringify({ name: project.name, path: project.path })); }
        catch (e) { error.textContent = e.message; return; }
        location.assign("/");
      } }, T.open),
    )) : [el("li", { class: "muted" }, T.noProjects)]));
  } catch (e) {
    error.textContent = e.message;
  }
  const actions = el("div", { class: "row" }, el("a", { class: "button secondary", href: "/" }, T.backToWorkspace));
  if (me.kind === "owner") {
    actions.append(el("a", { class: "button secondary", href: "/__gateway/devices" }, T.devices));
    actions.append(el("a", { class: "button secondary", href: "/__gateway/screen" }, T.hostWindows));
    actions.append(el("a", { class: "button secondary", href: "/__gateway/tex" }, T.texPackages));
    const config = await call("/__gateway/api/config").catch(() => ({}));
    if (config.terminal) actions.append(el("a", { class: "button secondary", href: "/__gateway/terminal" }, T.terminal));
  }
  app.replaceChildren(brand(), el("h1", {}, T.projectsTitle), el("p", { class: "muted" }, T.projectsHint), list, actions, error);
}

function renderScreen() {
  app.classList.add("full");
  const error = el("p", { class: "error", role: "alert" });
  const image = el("img", { class: "screen", alt: T.screenTitle, draggable: "false" });
  let lastInput = 0;
  const send = async (input) => {
    error.textContent = "";
    lastInput = Date.now();
    try { await call("/__gateway/api/screen/input", input); refresh(); } catch (e) { error.textContent = e.message; }
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
  let offset = [0, 0];
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
      error.textContent = e.message;
      schedule(2000);
    }
  }
  function schedule(delay = 800) {
    clearTimeout(timer);
    timer = setTimeout(() => (document.visibilityState === "visible" ? refresh() : schedule()), delay);
  }
  const text = el("input", { id: "text", autocomplete: "off", spellcheck: "false" });
  const keys = [["Return", "Enter"], ["Tab", "Tab"], ["Escape", "Esc"], ["BackSpace", "⌫"], ["Up", "↑"], ["Down", "↓"], ["ctrl+a", "Ctrl+A"]]
    .map(([key, label]) => el("button", { class: "secondary", onclick: () => send({ type: "key", key }) }, label));
  app.replaceChildren(
    brand(), el("h1", {}, T.screenTitle), el("p", { class: "muted" }, T.screenHint), image,
    el("form", { class: "row", onsubmit: (event) => { event.preventDefault(); if (text.value) send({ type: "text", text: text.value }); text.value = ""; } },
      el("label", { for: "text", class: "sr" }, T.typeText), text, el("button", { type: "submit" }, T.send)),
    el("div", { class: "row keys" }, ...keys),
    el("div", { class: "row" }, el("a", { class: "button secondary", href: "/" }, T.backToWorkspace)),
    error,
  );
  refresh();
}

function renderTex() {
  const error = el("p", { class: "error", role: "alert" });
  const result = el("p", { class: "muted", role: "status" });
  const name = el("input", { id: "name", autocomplete: "off", spellcheck: "false", required: "", value: new URLSearchParams(location.search).get("name") || "" });
  const submit = el("button", { type: "submit" }, T.install);
  app.replaceChildren(brand(), el("h1", {}, T.texTitle), el("p", { class: "muted" }, T.texHint),
    el("form", { onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true; error.textContent = ""; result.textContent = "…";
      try {
        const response = await fetch("/__gateway/api/tex-install", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.value.trim() }) });
        const value = await response.json().catch(() => ({}));
        if (response.ok) result.textContent = T.installed(value.package);
        else if (value?.error?.code === "choose_package") { result.textContent = ""; error.textContent = T.choose(value.error.packages.join(", ")); }
        else { result.textContent = ""; error.textContent = value?.error?.message || T.failed; }
      } catch (e) { result.textContent = ""; error.textContent = e.message; }
      submit.disabled = false;
    } }, el("label", { for: "name" }, T.texName), name, submit),
    result, error,
    el("div", { class: "row" }, el("a", { class: "button secondary", href: "/" }, T.backToWorkspace)));
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
  app.classList.add("full");
  const status = el("p", { class: "muted", role: "status" });
  const host = el("div", { class: "terminal" });
  const again = el("button", { class: "secondary", hidden: "" }, T.reconnect);
  app.replaceChildren(brand(), el("h1", {}, T.terminalTitle), el("p", { class: "muted" }, T.terminalHint), host, status,
    el("div", { class: "row" }, again, el("a", { class: "button secondary", href: "/" }, T.backToWorkspace)));
  await load("link", { rel: "stylesheet", href: "/__gateway/vendor/xterm.css" });
  await load("script", { src: "/__gateway/vendor/xterm.js" });
  await load("script", { src: "/__gateway/vendor/addon-fit.js" });
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const term = new window.Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, 'DejaVu Sans Mono', monospace",
    theme: dark ? { background: "#151713", foreground: "#e8eae3" } : { background: "#ffffff", foreground: "#1f231c", cursor: "#556324", selectionBackground: "#d9e2b8" },
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
