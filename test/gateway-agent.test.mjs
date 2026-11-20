// lattice-gateway's Agent entrance: same sign-in as the workspace, and only a
// port that a process under the configured marker listens on is served.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

const binary = process.env.LATTICE_GATEWAY_BINARY || new URL("../gateway/target/debug/lattice-gateway", import.meta.url).pathname;
const skip = existsSync(binary) ? false : `build the gateway first (${binary})`;
let gateway, synara, stranger, dir, base, agentBase, token;
const seen = [];

const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "lattice-gateway-agent-"));
  // Stands in for Synara: served by this node process, which the marker matches.
  synara = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><head></head><body>agent</body></html>");
  });
  await new Promise((r) => synara.listen(0, "127.0.0.1", r));
  // A service the marker does not match.
  const strangerPort = await freePort();
  stranger = spawn("python3", ["-m", "http.server", String(strangerPort), "--bind", "127.0.0.1"], { stdio: "ignore", cwd: dir });
  stranger.port = strangerPort;
  const [publicPort, agentPort] = [await freePort(), await freePort()];
  base = `http://127.0.0.1:${publicPort}`;
  agentBase = `http://127.0.0.1:${agentPort}`;
  gateway = spawn(binary, [
    "--listen", `127.0.0.1:${publicPort}`, "--public-origin", base, "--upstream", `127.0.0.1:${await freePort()}`,
    "--state-dir", join(dir, "state"), "--token-file", join(dir, "access-token"), "--insecure-dev-cookies",
    "--agent-listen", `127.0.0.1:${agentPort}`, "--agent-origin", agentBase, "--agent-process-marker", dirname(process.execPath),
  ], { stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/__gateway/health`); await fetch(`http://127.0.0.1:${strangerPort}/`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  token = readFileSync(join(dir, "access-token"), "utf8").trim();
});

after(() => {
  gateway?.kill();
  stranger?.kill();
  synara?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const post = (path, body, cookie) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

test("serves Lattice's Agent on its own origin to signed-in browsers only", { skip }, async () => {
  const owner = (await post("/__gateway/api/login", { token })).headers.get("set-cookie").split(";")[0];
  const config = await (await fetch(`${base}/__gateway/api/config`, { headers: { Cookie: owner } })).json();
  assert.equal(config.agentOrigin, agentBase);
  assert.equal((await fetch(`${agentBase}/thread`, { headers: { Cookie: owner } })).status, 503, "nothing is served before the page registers the Agent");

  assert.equal((await post("/__gateway/api/agent-port", { port: stranger.port }, owner)).status, 403, "another service is refused");
  assert.equal((await post("/__gateway/api/agent-port", { port: synara.address().port })).status, 401);
  const registered = await post("/__gateway/api/agent-port", { port: synara.address().port }, owner);
  assert.equal(registered.status, 200);
  assert.deepEqual(await registered.json(), { origin: agentBase });

  assert.equal((await fetch(`${agentBase}/thread`)).status, 401, "the Agent needs the same sign-in");
  const page = await fetch(`${agentBase}/thread?embed=1`, { headers: { Cookie: `${owner}; synara=1`, Origin: agentBase } });
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /bridge\.js/, "the Agent page is not the workspace page");
  const forwarded = seen.at(-1);
  assert.equal(forwarded.host, `127.0.0.1:${synara.address().port}`);
  assert.equal(forwarded.origin, `http://127.0.0.1:${synara.address().port}`);
  assert.equal(forwarded.cookie, "synara=1");
  const foreign = await fetch(`${agentBase}/thread`, { headers: { Cookie: owner, Origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
});
