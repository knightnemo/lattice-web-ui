// lattice-gateway behind Tailscale Serve/Funnel: on its Unix socket, a request
// from the owner's tailnet login is the owner with no sign-in; anything else
// (another login, or Funnel traffic from the internet) signs in or pairs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const binary = process.env.LATTICE_GATEWAY_BINARY || new URL("../gateway/target/debug/lattice-gateway", import.meta.url).pathname;
const skip = existsSync(binary) ? false : `build the gateway first (${binary})`;
let gateway, upstream, dir, socket;

const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "lattice-gateway-tailnet-"));
  socket = join(dir, "serve.sock");
  writeFileSync(join(dir, "owner-logins"), "owner@github\n");
  upstream = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(`lattice ${req.url}`); });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  // This test plays tailscaled, so its own UID is the allowed ingress.
  gateway = spawn(binary, [
    "--listen", `127.0.0.1:${await freePort()}`, "--public-origin", "https://w.example.ts.net:8443",
    "--upstream", `127.0.0.1:${upstream.address().port}`, "--state-dir", join(dir, "state"),
    "--token-file", join(dir, "access-token"), "--serve-socket", socket, "--owner-logins", join(dir, "owner-logins"),
    "--ingress-uid", String(process.getuid()),
  ], { stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 100 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50));
});

after(() => {
  gateway?.kill();
  upstream?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function viaTailscale(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path, headers: { Host: "w.example.ts.net:8443", ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the owner's tailnet login opens Lattice with no sign-in", { skip }, async () => {
  const who = await viaTailscale("/__gateway/api/whoami", { "Tailscale-User-Login": "owner@github" });
  assert.equal(JSON.parse(who.body).kind, "owner");
  const page = await viaTailscale("/project", { "Tailscale-User-Login": "owner@github", Accept: "text/html" });
  assert.equal(page.status, 200);
  assert.equal(page.body, "lattice /project");
});

test("another login, or a Funnel request with no login, must pair or sign in", { skip }, async () => {
  const stranger = await viaTailscale("/__gateway/api/whoami", { "Tailscale-User-Login": "someone@else" });
  assert.equal(JSON.parse(stranger.body).kind, "anonymous");
  const funnel = await viaTailscale("/", { Accept: "text/html", "Tailscale-Funnel-Request": "?1" });
  assert.equal(funnel.status, 303);
  assert.match(funnel.headers.location, /^\/__gateway\/login/);
});
