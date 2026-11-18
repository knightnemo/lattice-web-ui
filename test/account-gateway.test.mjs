import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const bin = ["LATTICE_SERVER_BINARY", "CADDY_BINARY", "OAUTH2_PROXY_BINARY"]
  .map((name) => process.env[name] && resolve(process.env[name]));
const allowedEmail = "owner@example.test";
const clientId = "lattice-fixture";
const fixture = new URL("../account-gateway/", import.meta.url);

async function listening(server) {
  await new Promise((started) => server.listen(0, "127.0.0.1", started));
  return server.address().port;
}
const closed = (server) => new Promise((done) => server.close(done));
async function freePort() {
  const socket = createServer();
  const port = await listening(socket);
  await closed(socket);
  return port;
}
async function waitFor(action) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

// Local fixture issuer. The real OAuth2 Proxy performs discovery, JWT signature
// validation, state, nonce and email allowlist checks against this issuer.
async function fakeIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "fixture" };
  const issued = new Map();
  let issuer;
  let identity = { email: allowedEmail, verified: true };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (value) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/keys", id_token_signing_alg_values_supported: ["RS256"],
        response_types_supported: ["code"], subject_types_supported: ["public"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/keys") return json({ keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = randomBytes(18).toString("hex");
      if (url.searchParams.get("code_challenge_method") !== "S256") return res.writeHead(400).end();
      issued.set(code, { ...identity, nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") });
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state"));
      return res.writeHead(302, { Location: redirect.href }).end();
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const code = form.get("code");
      const claims = issued.get(code);
      if (!claims) return res.writeHead(400).end();
      issued.delete(code);
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== claims.challenge) return res.writeHead(400).end();
      const iat = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = encode({ alg: "RS256", kid: jwk.kid }) + "." + encode({
        iss: issuer, aud: clientId, sub: claims.email, email: claims.email,
        email_verified: claims.verified, nonce: claims.nonce, iat, exp: iat + 600,
      });
      const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
      return json({ id_token: unsigned + "." + signature, access_token: "fixture-access", token_type: "Bearer", expires_in: 600 });
    }
    res.writeHead(404).end();
  });
  issuer = "http://127.0.0.1:" + await listening(server);
  return { server, issuer, identify(email, verified) { identity = { email, verified }; } };
}

test("HTTPS gateway admits only verified allowlisted accounts and starts a Lattice browser session", {
  skip: bin.every(Boolean) ? false : "Set LATTICE_SERVER_BINARY, CADDY_BINARY, and OAUTH2_PROXY_BINARY.",
  timeout: 45000,
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lattice-account-test-"));
  const [lattice, caddy, oauth] = bin;
  const children = [];
  const logs = [];
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OAUTH2_PROXY_")));
  let provider;
  const start = (binary, args, env = {}) => {
    const proc = spawn(binary, args, { env: { ...environment, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    const exited = new Promise((done) => proc.once("close", done));
    children.push({ proc, exited });
    proc.stderr.on("data", (buffer) => { logs.push(String(buffer)); });
    return proc;
  };
  try {
    provider = await fakeIssuer();
    const [backendPort, authPort, httpsPort] = await Promise.all(Array.from({ length: 3 }, freePort));
    const origin = `https://127.0.0.1:${httpsPort}`;
    const webAssets = join(scratch, "web");
    const projects = join(scratch, "projects");
    const tokenPath = join(scratch, "backend-token");
    const list = join(scratch, "allowlist");
    await mkdir(webAssets);
    await mkdir(projects);
    await writeFile(join(projects, "main.tex"), "Remote account fixture\n");
    await writeFile(join(webAssets, "index.html"), "<html><head></head><body>Lattice fixture</body></html>");
    const token = randomBytes(32).toString("hex");
    await writeFile(tokenPath, token, { mode: 0o600 });
    await writeFile(list, allowedEmail + "\n", { mode: 0o600 });
    start(lattice, ["serve", "--listen", `127.0.0.1:${backendPort}`, "--secure-cookies",
      "--account-gateway", "--public-origin", origin, "--workspace-root", projects,
      "--assets", webAssets, "--state-dir", join(scratch, "state"), "--token-file", tokenPath]);
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/session`, {
        headers: { "X-Lattice-Account-Proxy": "invalid" },
      });
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal((await response.json()).authenticated, false);
    });

    const oauthConfig = join(scratch, "oauth2-proxy.toml");
    await writeFile(oauthConfig, await readFile(new URL("oauth2-proxy.toml", fixture), "utf8"));
    const authProcess = start(oauth, ["--config", oauthConfig], {
      OAUTH2_PROXY_REDIRECT_URL: origin + "/oauth2/callback", OAUTH2_PROXY_OIDC_ISSUER_URL: provider.issuer,
      OAUTH2_PROXY_HTTP_ADDRESS: `127.0.0.1:${authPort}`, OAUTH2_PROXY_CLIENT_ID: clientId,
      OAUTH2_PROXY_CLIENT_SECRET: "fixture-secret", OAUTH2_PROXY_COOKIE_SECRET: randomBytes(32).toString("base64url"),
      OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE: list,
    });
    await waitFor(async () => {
      assert.equal((await fetch(`http://127.0.0.1:${authPort}/ping`)).status, 200);
    });

    const caddyConfig = join(scratch, "Caddyfile");
    const template = await readFile(new URL("Caddyfile", fixture), "utf8");
    await writeFile(caddyConfig, "{\n\tadmin off\n\tauto_https disable_redirects\n\tskip_install_trust\n}\n" +
      template.replace("{$LATTICE_ACCOUNT_ORIGIN} {", "{$LATTICE_ACCOUNT_ORIGIN} {\n\tbind 127.0.0.1\n\ttls internal"));
    const tlsData = join(scratch, "tls");
    start(caddy, ["run", "--config", caddyConfig, "--adapter", "caddyfile"], {
      XDG_DATA_HOME: tlsData, XDG_CONFIG_HOME: scratch, LATTICE_ACCOUNT_ORIGIN: origin,
      LATTICE_OAUTH_PORT: String(authPort), LATTICE_BACKEND_PORT: String(backendPort), LATTICE_BACKEND_TOKEN: token,
    });
    const ca = await waitFor(() => readFile(join(tlsData, "caddy/pki/authorities/local/root.crt")));
    const raw = (path, { method = "GET", headers = {}, body, stream = false } = {}) => new Promise((done, reject) => {
      const req = request(origin + path, { ca, method, headers, timeout: 4000 }, async (res) => {
        if (stream) return done(res);
        let text = "";
        try {
          for await (const chunk of res) text += chunk;
          done({ status: res.statusCode, headers: res.headers, text });
        } catch (error) {
          reject(error);
        }
      });
      req.on("timeout", () => req.destroy(new Error("gateway request timed out")));
      req.on("error", reject);
      req.end(body);
    });
    await waitFor(async () => assert.equal((await raw("/api/session")).status, 401));

    async function signIn(email, verified) {
      provider.identify(email, verified);
      const landing = await raw("/", { headers: { Accept: "text/html" } });
      assert.equal(landing.status, 302);
      const start = await raw(landing.headers.location);
      assert.equal(start.status, 302);
      const csrf = start.headers["set-cookie"].map((value) => value.split(";")[0]).join("; ");
      const authorization = await fetch(start.headers.location, { redirect: "manual" });
      const callback = new URL(authorization.headers.get("location"));
      return raw(callback.pathname + callback.search, { headers: { Cookie: csrf } });
    }

    assert.equal((await raw("/api/session", { headers: { Authorization: "Bearer " + token,
      "X-Lattice-Account-Proxy": token, "X-Auth-Request-Email": allowedEmail } })).status, 401);
    assert.equal((await signIn("unlisted@example.test", true)).status, 403);
    assert.equal((await signIn(allowedEmail, false)).status, 403);

    const signInResult = await signIn(allowedEmail, true);
    assert.equal(signInResult.status, 302);
    const gatewayCookie = signInResult.headers["set-cookie"].find((value) => value.startsWith("__Host-lattice_oidc="));
    assert.match(gatewayCookie, /; Secure/i);
    const authHeaders = { Cookie: gatewayCookie.split(";")[0] };
    assert.match((await raw("/", { headers: authHeaders })).text, /Lattice fixture/);
    const bootstrap = await raw("/api/session", { headers: authHeaders });
    assert.equal(JSON.parse(bootstrap.text).authenticated, true);
    const browserCookie = bootstrap.headers["set-cookie"][0];
    assert.match(browserCookie, /^lattice_session=.*; HttpOnly; SameSite=Strict; Path=\/api; .*; Secure$/);
    const browserHeaders = { Cookie: authHeaders.Cookie + "; " + browserCookie.split(";")[0] };
    assert.equal((await raw("/api/session", { headers: browserHeaders })).headers["set-cookie"], undefined);
    assert.equal((await raw("/api/session", { headers: { Cookie: browserCookie.split(";")[0] } })).status, 401);
    assert.equal((await raw("/api/session", { headers: { ...authHeaders, Origin: "https://elsewhere.example.test" } })).status, 403);
    assert.equal((await raw("/api/projects", { headers: browserHeaders })).status, 200);
    const write = await raw("/api/invoke", { method: "POST", headers: { ...browserHeaders,
      "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ command: "write_project_file",
      args: { path: "main.tex", baseContent: "Remote account fixture\n", content: "Saved by the owner\n" } }) });
    assert.equal(write.status, 200, write.text);
    assert.equal(await readFile(join(projects, "main.tex"), "utf8"), "Saved by the owner\n");
    const tokenLogin = await raw("/api/session", { method: "POST", headers: { ...authHeaders,
      "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token }) });
    assert.equal(tokenLogin.status, 405);
    const events = await raw("/api/events?client=lattice-test-client-123", { headers: browserHeaders, stream: true });
    assert.equal(events.statusCode, 200);
    const firstEvent = await events[Symbol.asyncIterator]().next();
    assert.match(String(firstEvent.value), /server-ready/);
    events.destroy();
    const logout = await raw("/oauth2/sign_out?rd=/oauth2/sign_in", { headers: browserHeaders });
    assert.equal(logout.status, 302);
    assert.ok(logout.headers["set-cookie"].some((cookie) => cookie.startsWith("lattice_session=;")));
    assert.ok(logout.headers["set-cookie"].some((cookie) => cookie.startsWith("__Host-lattice_oidc=;")));

    await writeFile(list, "new-owner@example.test\n");
    await waitFor(async () => assert.equal((await raw("/api/projects", { headers: browserHeaders })).status, 401));
    authProcess.kill("SIGTERM");
    await waitFor(async () => assert.equal((await raw("/api/projects", { headers: browserHeaders })).status, 502));
  } catch (error) {
    console.error(logs.join("").slice(-6000));
    throw error;
  } finally {
    for (const { proc } of children) proc.kill("SIGTERM");
    await Promise.all(children.map(({ exited }) => exited));
    if (provider) await closed(provider.server);
    await rm(scratch, { recursive: true, force: true });
  }
});
