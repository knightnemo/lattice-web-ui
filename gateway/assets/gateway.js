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
  if (me.kind === "owner") actions.append(el("a", { class: "button secondary", href: "/__gateway/devices" }, T.devices));
  app.replaceChildren(brand(), el("h1", {}, T.projectsTitle), el("p", { class: "muted" }, T.projectsHint), list, actions, error);
}

({ login: renderLogin, pair: renderPair, devices: renderDevices, projects: renderProjects }[page] || renderLogin)();
