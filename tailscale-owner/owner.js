"use strict";

const byId = (id) => document.getElementById(id);
const status = byId("status");
const devices = byId("devices");
const workspace = new URL(byId("workspace").href);
const invitation = byId("invitation");
const inviteLink = byId("invite-link");
const expiry = byId("expiry");
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
let countdown;

async function request(path, method = "GET") {
  const response = await fetch(path, {
    method,
    credentials: "omit",
    mode: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function hideInvitation() {
  clearInterval(countdown);
  invitation.hidden = true;
  inviteLink.removeAttribute("href");
  const canvas = byId("qr");
  canvas.width = 0;
  canvas.height = 0;
}

function drawCode(matrix) {
  const canvas = byId("qr");
  const moduleSize = Math.max(1, Math.floor(256 / (matrix.length + 8)));
  canvas.width = canvas.height = (matrix.length + 8) * moduleSize;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111";
  matrix.forEach((row, y) => {
    [...row].forEach((pixel, x) => {
      if (pixel === "1") context.fillRect((x + 4) * moduleSize, (y + 4) * moduleSize, moduleSize, moduleSize);
    });
  });
}

async function showInvitation() {
  hideInvitation();
  const data = await request("/api/devices/invites", "POST");
  const link = new URL(data.url);
  if (link.origin !== workspace.origin || link.pathname !== "/" || link.search ||
      !/^#pair=[A-Za-z0-9_-]{32,128}$/.test(link.hash)) {
    throw new Error("The server returned an invalid pairing link.");
  }
  inviteLink.href = link.href;
  drawCode(data.qr);
  invitation.hidden = false;
  const expiresAt = Date.now() + data.expiresIn * 1000;
  function updateCountdown() {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    expiry.textContent = `Expires in ${seconds} seconds.`;
    if (!seconds) {
      hideInvitation();
      status.textContent = "The pairing code expired. Show a new code to try again.";
    }
  }
  updateCountdown();
  countdown = setInterval(updateCountdown, 1000);
}

function withButton(button, operation) {
  return async () => {
    status.textContent = "";
    button.disabled = true;
    try {
      await operation();
    } catch (error) {
      status.textContent = error.message || "Device management is unavailable.";
    } finally {
      button.disabled = false;
    }
  };
}

async function refreshDevices() {
  const result = await request("/api/devices");
  devices.replaceChildren();
  if (!result.devices.length) {
    const empty = document.createElement("li");
    empty.textContent = "No paired devices.";
    devices.append(empty);
    return;
  }
  for (const device of result.devices) {
    const entry = document.createElement("li");
    const details = document.createElement("span");
    const expiryDate = document.createElement("small");
    const revoke = document.createElement("button");
    details.textContent = device.label;
    expiryDate.textContent = `Expires ${formatter.format(device.expiresAt * 1000)}`;
    details.append(expiryDate);
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", withButton(revoke, async () => {
      if (!window.confirm(`Revoke access for ${device.label}?`)) return;
      await request(`/api/devices/${encodeURIComponent(device.id)}/revoke`, "POST");
      await refreshDevices();
      status.textContent = "Device revoked.";
    }));
    entry.append(details, revoke);
    devices.append(entry);
  }
}

byId("pair").addEventListener("click", withButton(byId("pair"), showInvitation));
byId("refresh").addEventListener("click", withButton(byId("refresh"), refreshDevices));
byId("copy").addEventListener("click", withButton(byId("copy"), async () => {
  await navigator.clipboard.writeText(inviteLink.href);
  status.textContent = "Pairing link copied.";
}));

void withButton(byId("refresh"), refreshDevices)();
