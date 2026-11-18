import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";

const source = fileURLToPath(new URL("../tailscale-owner/gateway.py", import.meta.url));
const publicOrigin = "https://workspace.example.test";
const ownerOrigin = `${publicOrigin}:9443`;
const ownerHost = new URL(ownerOrigin).host;
const ownerLogin = "owner@example.test";
const token = "0".repeat(64);
const pairFragment = "#pair=" + "a".repeat(64);
const deviceCookie = "__Host-lattice_device=" + "b".repeat(64);
const staleDeviceCookie = "__Host-lattice_device=" + "c".repeat(64);
const deviceId = "a".repeat(32);
const claimedDevice = { id: deviceId, label: "<template>Test Mac", expiresAt: 1800000000 };
const qr = Array.from({ length: 21 }, () => "0".repeat(21));
const headers = {
  Host: "localhost",
  "X-Forwarded-Host": ownerHost,
  "X-Forwarded-Proto": "https",
  "Tailscale-User-Login": ownerLogin,
};
const rawHeaders = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");

function request(socketPath, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path,
      method: options.method ?? "GET",
      headers: options.headers ?? headers,
      agent: false,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { body += part; });
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.once("error", reject);
    });
    req.setTimeout(2500, () => req.destroy(new Error("Fixture request timed out.")));
    req.once("error", reject);
    req.end(options.body);
  });
}

function rawResponse(socketPath, raw) {
  return new Promise((resolve, reject) => {
    const client = createConnection({ path: socketPath });
    let body = "";
    client.setEncoding("utf8");
    client.setTimeout(2500, () => client.destroy(new Error("Fixture request timed out.")));
    client.once("connect", () => client.end(raw));
    client.on("data", (part) => { body += part; });
    client.once("end", () => resolve(body));
    client.once("error", reject);
  });
}

test("Tailscale owner gateway isolates the trusted Unix ingress and upstream pairing session", async (t) => {
  const directory = mkdtempSync("/tmp/lto-");
  const socketPath = join(directory, "owner.sock");
  writeFileSync(join(directory, "owner"), ownerLogin, { mode: 0o600 });
  writeFileSync(join(directory, "token"), token, { mode: 0o600 });
  const sessions = new Set();
  const upstreamRequests = [];
  const children = new Set();
  let logins = 0;
  let inviteOrigin = publicOrigin;
  let devices = [claimedDevice];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    upstreamRequests.push({ path: req.url, method: req.method, headers: req.headers, body });
    const respond = (status, result, extra = {}) => {
      res.writeHead(status, { ...extra, "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    };

    if (req.headers.host !== new URL(publicOrigin).host || req.headers.origin !== publicOrigin) {
      return respond(403, { error: "Wrong origin." });
    }
    if (req.url === "/api/session" && req.method === "POST" && JSON.parse(body).token === token) {
      const sessionId = (++logins).toString(16).padStart(32, "0");
      sessions.add(`lattice_session=${sessionId}`);
      return respond(200, { authenticated: true, devicePairing: true, canManageDevices: true }, {
        "Set-Cookie": `lattice_session=${sessionId}; Path=/api; Secure; HttpOnly`,
      });
    }
    if (req.url === "/api/devices/resume" && req.method === "POST") {
      if (req.headers.cookie !== deviceCookie) return respond(401, { error: "Unknown device." });
      return respond(200, { authenticated: true, devicePairing: true, canManageDevices: false }, {
        "Set-Cookie": `lattice_session=${"d".repeat(32)}; Path=/api; Secure; HttpOnly`,
      });
    }
    if (!sessions.has(req.headers.cookie)) return respond(403, { error: "No session." });
    if (req.url === "/api/devices") return respond(200, { devices });
    if (req.url === "/api/devices/invites") {
      return respond(200, { url: `${inviteOrigin}/${pairFragment}`, qr, expiresIn: 120 });
    }
    if (req.url === `/api/devices/${deviceId}/revoke`) {
      devices = [];
      return respond(200, { revoked: true });
    }
    return respond(404, { error: "Unrecognized route." });
  });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");

  async function start(ingressUid = process.getuid(), privateOrigin = ownerOrigin, listener = socketPath) {
    const child = spawn("python3", [
      source, "--socket", listener, "--owner-file", join(directory, "owner"),
      "--token-file", join(directory, "token"), "--private-origin", privateOrigin,
      "--public-origin", publicOrigin, "--ingress-uid", String(ingressUid),
      "--upstream-port", String(upstream.address().port),
    ], { stdio: "ignore" });
    children.add(child);
    const started = once(child, "spawn");
    await started;
    const deadline = Date.now() + 4000;
    while (!existsSync(listener) || (statSync(listener).mode & 0o777) !== 0o600) {
      assert.equal(child.exitCode, null, "Gateway exited during startup.");
      assert.ok(Date.now() < deadline, "Gateway did not create its private socket.");
      await pause(25);
    }
    return child;
  }

  await start();

  await t.test("rejects unknown origins, identities, duplicates and unmapped requests before contacting Lattice", async () => {
    const { "Tailscale-User-Login": _login, ...anonymous } = headers;
    assert.equal((await request(socketPath, "/", {
      headers: anonymous,
    })).status, 403);
    assert.equal((await request(socketPath, "/", {
      headers: { ...headers, "Tailscale-User-Login": "other@example.test" },
    })).status, 403);
    assert.equal((await request(socketPath, "/", {
      headers: { ...headers, "Tailscale-User-Login": `${ownerLogin}, other@example.test` },
    })).status, 403);
    assert.equal((await request(socketPath, "/", {
      headers: { ...headers, "X-Forwarded-Host": new URL(publicOrigin).host },
    })).status, 403);
    assert.equal((await request(socketPath, "/", {
      headers: { ...headers, "Tailscale-Funnel-Request": "?1" },
    })).status, 403);
    assert.equal((await request(socketPath, "/", {
      headers: { ...headers, "X-Forwarded-Proto": "http" },
    })).status, 403);
    const prefix = `GET / HTTP/1.0\r\n${rawHeaders}`;
    assert.match(await rawResponse(socketPath, `${prefix}Tailscale-User-Login: ${ownerLogin}\r\n\r\n`), /^HTTP\/1\.0 403/);
    assert.match(await rawResponse(socketPath, `${prefix}Host: ${ownerHost}\r\n\r\n`), /^HTTP\/1\.0 403/);
    assert.match(await rawResponse(socketPath, `${prefix}X-Forwarded-Host: ${ownerHost}\r\n\r\n`), /^HTTP\/1\.0 403/);
    for (const path of ["/api/devices/invites", "/api/workspace/open"]) {
      for (const invalid of [undefined, publicOrigin, "https://different.example.test"]) {
        assert.equal((await request(socketPath, path, {
          method: "POST",
          headers: invalid ? { ...headers, Origin: invalid } : headers,
        })).status, 403);
      }
    }
    assert.equal((await request(socketPath, "/api/workspace/open", {
      method: "POST", headers: { ...anonymous, Origin: ownerOrigin, Cookie: deviceCookie },
    })).status, 403);
    for (const path of ["/api/session", "/api/devices/pair", "/api/devices?name=Other", "/api/devices/invalid/revoke", "/api/workspace/open"]) {
      assert.equal((await request(socketPath, path)).status, 404);
    }
    assert.equal((await request(socketPath, "/api/devices/invites", {
      method: "POST", headers: { ...headers, Origin: ownerOrigin, "Content-Length": "1" }, body: "x",
    })).status, 400);
    assert.equal(upstreamRequests.length, 0);
  });

  await t.test("serves the private owner page and keeps credentials server-side", async () => {
    const page = await request(socketPath, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /Signed in with Tailscale/);
    assert.match(page.body, /<button id="open" type="button">Open workspace<\/button>/);
    assert.match(page.body, /<p hidden><a id="workspace"/);
    assert.ok(page.body.includes(`href="${publicOrigin}/"`));
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(page.headers["set-cookie"], undefined);

    const result = await request(socketPath, "/api/devices", {
      headers: { ...headers, Cookie: "lattice_session=arbitrary", "X-Forwarded-For": "198.51.100.3" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { devices: [claimedDevice] });
    assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(result.headers["access-control-allow-origin"], undefined);
    assert.equal(upstreamRequests[0].headers.cookie, undefined);
    assert.equal(upstreamRequests[0].headers["x-forwarded-host"], undefined);
    assert.equal(upstreamRequests[0].headers["x-forwarded-for"], undefined);
    assert.equal(upstreamRequests[0].headers["tailscale-user-login"], undefined);
    assert.equal(logins, 1);
    await request(socketPath, "/api/devices");
    assert.equal(logins, 1, "The server-side session is reused.");
  });

  await t.test("refreshes the session after the Lattice server loses in-memory state", async () => {
    sessions.clear(); // Simulates restarting the public Lattice process.
    const listing = await request(socketPath, "/api/devices");
    assert.equal(listing.status, 200);
    assert.equal(logins, 2);
    assert.equal(listing.headers["set-cookie"], undefined);
    assert.deepEqual(JSON.parse(listing.body).devices, [claimedDevice]);
  });

  const openPath = "/api/workspace/open";
  function openWorkspace(cookie, listener = socketPath, privateOrigin = ownerOrigin) {
    return request(listener, openPath, {
      method: "POST",
      headers: {
        ...headers,
        "X-Forwarded-Host": new URL(privateOrigin).host,
        Origin: privateOrigin,
        ...(cookie && { Cookie: cookie }),
      },
    });
  }

  await t.test("opens an already paired browser with only its device cookie and no new invitation", async () => {
    const before = upstreamRequests.length;
    const result = await openWorkspace(`unrelated=ignored; ${deviceCookie}; lattice_session=ignored`);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { url: `${publicOrigin}/` });
    assert.equal(result.headers["set-cookie"], undefined);
    assert.deepEqual(upstreamRequests.slice(before).map(({ path, method, headers, body }) =>
      [path, method, headers.cookie, body]), [["/api/devices/resume", "POST", deviceCookie, "{}"]]);
    const listing = await request(socketPath, "/api/devices");
    assert.equal(listing.status, 200);
    assert.equal(logins, 2, "A device probe leaves the owner session alone.");
  });

  await t.test("creates an invitation when the browser credential is absent, invalid, ambiguous or stale", async () => {
    for (const cookie of [null, "__Host-lattice_device=no", `${deviceCookie}; ${staleDeviceCookie}`, staleDeviceCookie]) {
      const before = upstreamRequests.length;
      const result = await openWorkspace(cookie);
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.body), { url: `${publicOrigin}/${pairFragment}` });
      assert.equal(result.headers["set-cookie"], undefined);
      const paths = upstreamRequests.slice(before).map(({ path }) => path);
      assert.deepEqual(paths, cookie === staleDeviceCookie
        ? ["/api/devices/resume", "/api/devices/invites"]
        : ["/api/devices/invites"]);
      assert.match(upstreamRequests.at(-1).headers.cookie, /^lattice_session=[a-f0-9]{32}$/);
    }
  });

  await t.test("ignores cookies when owner and editor use different hostnames", async () => {
    const separateOrigin = "https://owner.example.test:9443";
    const separateSocket = join(directory, "other.sock");
    await start(process.getuid(), separateOrigin, separateSocket);
    const page = await request(separateSocket, "/", {
      headers: { ...headers, "X-Forwarded-Host": new URL(separateOrigin).host },
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /<p><a id="workspace"[^>]*>Already paired\? Open directly/);
    const before = upstreamRequests.length;
    const result = await openWorkspace(deviceCookie, separateSocket, separateOrigin);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { url: `${publicOrigin}/${pairFragment}` });
    assert.equal(result.headers["set-cookie"], undefined);
    const requests = upstreamRequests.slice(before);
    assert.deepEqual(requests.map(({ path }) => path), ["/api/session", "/api/devices/invites"]);
    assert.ok(requests.every(({ headers }) => headers.cookie !== deviceCookie));
  });

  await t.test("mints an invitation only for the public origin and supports revoking a device", async () => {
    const post = { method: "POST", headers: { ...headers, Origin: ownerOrigin } };
    const invite = await request(socketPath, "/api/devices/invites", post);
    assert.equal(invite.status, 200);
    assert.equal(invite.headers["referrer-policy"], "no-referrer");
    assert.equal(invite.headers["set-cookie"], undefined);
    assert.deepEqual(JSON.parse(invite.body), { url: `${publicOrigin}/${pairFragment}`, qr, expiresIn: 120 });

    inviteOrigin = "https://unexpected.example.test";
    const rejected = await request(socketPath, "/api/devices/invites", post);
    assert.equal(rejected.status, 502);
    assert.doesNotMatch(rejected.body, /unexpected|#pair=/);
    const revoked = await request(socketPath, `/api/devices/${deviceId}/revoke`, post);
    assert.equal(revoked.status, 200);
    assert.deepEqual(JSON.parse(revoked.body), { revoked: true });
    const listing = await request(socketPath, "/api/devices");
    assert.deepEqual(JSON.parse(listing.body), { devices: [] });
  });

  await t.test("rejects an unexpected Unix peer UID on Linux", { skip: process.platform !== "linux" }, async () => {
    const [child] = children;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    assert.equal(existsSync(socketPath), false);
    await start(process.getuid() + 1);
    const reply = await rawResponse(socketPath, `GET / HTTP/1.0\r\n${rawHeaders}\r\n`).catch((error) => {
      assert.ok(["ECONNRESET", "EPIPE"].includes(error.code));
      return "";
    });
    assert.equal(reply, "", "Kernel credentials should be checked before parsing HTTP.");
  });
});
