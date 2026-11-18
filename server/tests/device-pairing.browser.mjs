/** Exercise owner and phone browsers against the compiled workspace through its HTTPS ingress. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";

const engine = process.env.LATTICE_TEST_BROWSER === "webkit" ? webkit : chromium;
const backend = resolve(process.env.LATTICE_SERVER_BINARY ?? "server/target/debug/lattice-server");
const assets = resolve(process.env.LATTICE_WEB_ASSETS ?? "dist");
const caddy = process.env.CADDY_BINARY ?? "caddy";
const template = process.env.LATTICE_PAIRING_CADDYFILE ?? new URL("../../../device-pairing/Caddyfile", import.meta.url);
const scratch = await mkdtemp(join(tmpdir(), "lattice-pairing-browser-"));
const logs = [];
const processes = [];
let browser;

async function listenPort() {
  const server = createServer();
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const port = server.address().port;
  await new Promise((closed) => server.close(closed));
  return port;
}

function spawnService(binary, args, env = {}) {
  const program = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  const stopped = new Promise((done) => program.once("close", done));
  program.stderr.on("data", (bytes) => logs.push(String(bytes)));
  processes.push({ program, stopped });
}

try {
  const [backendPort, tlsPort] = await Promise.all([listenPort(), listenPort()]);
  const origin = `https://127.0.0.1:${tlsPort}`;
  const tokenFile = join(scratch, "token");
  const workspace = join(scratch, "paper");
  await mkdir(workspace);
  await writeFile(join(workspace, "main.tex"), "\\documentclass{article}\n\\begin{document}\nPaired workspace.\n\\end{document}\n");
  spawnService(backend, [
    "serve", "--workspace-root", workspace, "--state-dir", join(scratch, "state"), "--token-file", tokenFile,
    "--assets", assets, "--listen", `127.0.0.1:${backendPort}`, "--secure-cookies", "--public-origin", origin, "--device-pairing",
  ]);
  const config = join(scratch, "Caddyfile");
  const local = (await readFile(template, "utf8")).replace(
    "{$LATTICE_PAIRING_ORIGIN} {", "{$LATTICE_PAIRING_ORIGIN} {\n\tbind 127.0.0.1\n\ttls internal",
  );
  await writeFile(config, "{\n\tadmin off\n\tauto_https disable_redirects\n\tskip_install_trust\n}\n" + local);
  spawnService(caddy, ["run", "--config", config, "--adapter", "caddyfile"], {
    LATTICE_PAIRING_ORIGIN: origin, LATTICE_PAIRING_PORT: String(backendPort),
    XDG_DATA_HOME: join(scratch, "caddy-data"), XDG_CONFIG_HOME: join(scratch, "caddy-config"),
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/session`);
      ready = response.ok && (await response.json()).devicePairing;
      if (ready) break;
    } catch {
      // Start the browser only after the standalone companion has opened its listener.
    }
    await delay(100);
  }
  assert.ok(ready);
  browser = await engine.launch(engine === chromium ? { channel: "chrome" } : {});
  const owner = await browser.newPage({ viewport: { width: 1300, height: 820 }, ignoreHTTPSErrors: true });
  const errors = [];
  owner.on("pageerror", (error) => errors.push(error.message));
  await owner.goto(origin);
  const token = (await readFile(tokenFile, "utf8")).trim();
  await owner.getByLabel("Server access token").fill(token).catch(() => { throw new Error("Owner sign-in field did not appear."); });
  const login = owner.waitForResponse((response) => response.url() === origin + "/api/session" && response.request().method() === "POST");
  await owner.getByRole("button", { name: "Connect", exact: true }).click();
  const ownerSession = await (await login).json();
  assert.equal(ownerSession.canManageDevices, true);
  const devices = owner.getByRole("button", { name: "Devices", exact: true });
  await devices.waitFor({ timeout: 8000 }).catch(async (error) => {
    console.error(await owner.evaluate(() => ({ secure: isSecureContext, owner: window.__LATTICE_HEADLESS_DEVICE_OWNER__, body: document.body.innerText.slice(0, 500) })));
    console.error(errors);
    throw error;
  });
  const skipTexSetup = owner.getByRole("button", { name: "Continue editing", exact: true });
  if (await skipTexSetup.isVisible()) await skipTexSetup.click();
  await devices.click();
  const inviteResponse = owner.waitForResponse((response) => response.url() === origin + "/api/devices/invites");
  await owner.getByRole("button", { name: "Pair a device", exact: true }).click();
  const { url } = await (await inviteResponse).json();
  const qr = owner.getByRole("img", { name: "Device pairing QR code" });
  await qr.waitFor();
  const richMatrix = await qr.evaluate((canvas) => {
    const bytes = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return bytes.includes(17) && bytes.includes(255);
  });
  assert.ok(richMatrix, "the owner dialog renders the matrix with a light quiet zone");
  if (process.env.LATTICE_QR_DECODER) {
    const image = join(scratch, "fixture-qr.png");
    await qr.screenshot({ path: image });
    const scanned = execFileSync(process.env.LATTICE_QR_DECODER, [image], { encoding: "utf8", timeout: 20000 });
    assert.ok(scanned.trim() === url, "scanning the rendered code returns the exact invite");
  }

  const phone = await browser.newPage({
    viewport: { width: 382, height: 580 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true,
  });
  const redemption = [];
  phone.on("request", (request) => {
    assert.ok(!request.url().includes("#pair="));
    if (request.url() === origin + "/api/devices/pair") redemption.push(request);
  });
  await phone.goto(url);
  await phone.getByRole("heading", { name: "Pair this device" }).waitFor();
  assert.equal(new URL(phone.url()).hash, "");
  assert.equal(redemption.length, 0, "opening the QR link alone does not redeem it");
  await phone.getByLabel("Device name").fill("Test iPhone");
  await phone.getByRole("button", { name: "Connect this device" }).click();
  await phone.locator(".cm-content").first().waitFor();
  assert.equal(redemption.length, 1);
  assert.equal(await phone.getByRole("button", { name: "Devices", exact: true }).count(), 0);
  const phoneCookie = (await phone.context().cookies()).find((value) => value.name === "__Host-lattice_device");
  assert.ok(phoneCookie?.secure && phoneCookie.httpOnly);
  await phone.reload();
  await phone.locator(".cm-content").first().waitFor();

  await owner.getByRole("button", { name: "Refresh devices" }).click();
  await owner.getByText("Test iPhone", { exact: true }).waitFor();
  await owner.getByRole("button", { name: "Revoke", exact: true }).click();
  await owner.getByText("Test iPhone", { exact: true }).waitFor({ state: "hidden" });
  await phone.reload();
  await phone.getByRole("heading", { name: "Workspace owner sign-in" }).waitFor();
  console.log(`${engine.name()}: Mac QR, iPhone confirmation, return session and revocation passed over HTTPS.`);
} catch (error) {
  console.error(logs.join("").slice(-4500));
  throw error;
} finally {
  await browser?.close();
  for (const { program } of processes) program.kill("SIGTERM");
  await Promise.race([Promise.all(processes.map(({ stopped }) => stopped)), delay(5000)]);
  await rm(scratch, { recursive: true, force: true });
}
