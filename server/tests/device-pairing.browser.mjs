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
  const service = { program, stopped };
  processes.push(service);
  return service;
}

try {
  const [backendPort, tlsPort] = await Promise.all([listenPort(), listenPort()]);
  const origin = `https://127.0.0.1:${tlsPort}`;
  const tokenFile = join(scratch, "token");
  const workspace = join(scratch, "projects");
  const paper = join(workspace, "paper");
  const otherPaper = join(workspace, "other");
  const otherText = "Another project with the same filename.";
  await mkdir(paper, { recursive: true });
  await mkdir(otherPaper);
  await writeFile(join(otherPaper, "main.tex"), otherText);
  const main = join(paper, "main.tex");
  await writeFile(main, "\\documentclass{article}\n\\begin{document}\nPaired workspace.\n\\end{document}\n");
  const startBackend = (project) => spawnService(backend, [
    "serve", "--project", project, "--workspace-root", workspace, "--state-dir", join(scratch, "state"), "--token-file", tokenFile,
    "--assets", assets, "--listen", `127.0.0.1:${backendPort}`, "--secure-cookies", "--public-origin", origin, "--device-pairing",
  ]);
  const original = startBackend(paper);
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

  const phoneContext = await browser.newContext({
    viewport: { width: 382, height: 580 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true,
  });
  const phone = await phoneContext.newPage();
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

  await owner.keyboard.press("Escape");
  await owner.getByRole("dialog", { name: "Remote devices" }).waitFor({ state: "hidden" });
  await owner.setViewportSize({ width: 382, height: 580 });
  const editor = owner.locator(".cm-content").first();
  await editor.focus();
  original.program.kill("SIGTERM");
  await original.stopped;
  await owner.keyboard.press("End");
  await owner.keyboard.insertText("OWNER-DRAFT");
  await owner.keyboard.press("ArrowLeft");
  const editorNode = await editor.elementHandle();
  const caret = () => editor.evaluate((node) => {
    const selection = window.getSelection();
    if (!selection?.focusNode || !node.contains(selection.focusNode)) return null;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(selection.focusNode, selection.focusOffset);
    return range.toString().length;
  });
  const offset = await caret();
  assert.ok(offset > 0);
  startBackend(otherPaper);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${backendPort}/api/session`).then((r) => r.ok).catch(() => false)) break;
    await delay(100);
  }
  const save = (page) => page.getByRole("navigation", { name: "Workspace panels" }).getByRole("button", { name: "Save", exact: true });
  await save(owner).dispatchEvent("click");
  await owner.getByLabel("Server access token").fill(token);
  assert.ok(!(await readFile(main, "utf8")).includes("OWNER-DRAFT"));
  await owner.getByRole("button", { name: "Connect", exact: true }).click();
  await owner.locator(".headless-reconnect").waitFor({ state: "detached" });
  assert.equal(await editor.evaluate((node, previous) => node === previous, editorNode), true);
  await editor.focus();
  assert.equal(await caret(), offset);
  const waitForSaved = async (marker) => {
    for (let i = 0; i < 100; i++) {
      if ((await readFile(main, "utf8")).includes(marker)) return;
      await delay(100);
    }
    assert.fail("draft did not reach the original project");
  };
  await save(owner).dispatchEvent("click");
  await waitForSaved("OWNER-DRAFT");
  assert.equal(await readFile(join(otherPaper, "main.tex"), "utf8"), otherText);

  // An existing paired browser resumes through the device cookie after the same restart.
  const getProject = () => phone.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke("initial_project")).root);
  await getProject().catch(() => {});
  const realRoot = await editor.evaluate(() => window.__TAURI_INTERNALS__.invoke("initial_project").then((project) => project.root));
  await phone.waitForFunction(async (root) => {
    try { return (await window.__TAURI_INTERNALS__.invoke("initial_project")).root === root; } catch { return false; }
  }, realRoot);
  assert.equal(await phone.getByLabel("Server access token").count(), 0);
  await owner.setViewportSize({ width: 1300, height: 820 });
  await devices.click();
  await owner.getByRole("button", { name: "Refresh devices" }).click();
  await owner.getByText("Test iPhone", { exact: true }).waitFor();
  await owner.getByRole("button", { name: "Revoke", exact: true }).click();
  await owner.getByText("Test iPhone", { exact: true }).waitFor({ state: "hidden" });
  const phoneEditor = phone.locator(".cm-content").first();
  await phoneEditor.focus();
  await phone.keyboard.press("End");
  await phone.keyboard.insertText("PAIRED-DRAFT");
  await save(phone).dispatchEvent("click");
  await phone.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  assert.equal(await phone.getByLabel("Server access token").count(), 0);
  assert.ok((await phoneEditor.innerText()).includes("PAIRED-DRAFT"));
  assert.ok(!(await readFile(main, "utf8")).includes("PAIRED-DRAFT"));

  const [newInvite] = await Promise.all([
    owner.waitForResponse((response) => response.url() === origin + "/api/devices/invites", { timeout: 12000 }),
    owner.getByRole("button", { name: "Pair a device", exact: true }).click({ timeout: 10000 }),
  ]);
  const fresh = await phoneContext.newPage();
  await fresh.goto((await newInvite.json()).url);
  await fresh.getByLabel("Device name").fill("Paired again");
  await fresh.getByRole("button", { name: "Connect this device" }).click();
  await fresh.locator(".cm-content").first().waitFor();
  await phone.bringToFront();
  await phone.getByRole("button", { name: "Reconnect", exact: true }).click();
  await phone.locator(".headless-reconnect").waitFor({ state: "detached" });
  await save(phone).dispatchEvent("click");
  await waitForSaved("PAIRED-DRAFT");
  assert.equal(await readFile(join(otherPaper, "main.tex"), "utf8"), otherText);
  assert.equal(await phone.getByRole("button", { name: "Devices", exact: true }).count(), 0);
  assert.ok((await readFile(main, "utf8")).includes("OWNER-DRAFT"));
  console.log(`${engine.name()}: owner draft and caret survived restart; paired resume, revocation, new invitation, and saving to the original project passed over HTTPS.`);
} catch (error) {
  console.error(logs.join("").slice(-4500));
  throw error;
} finally {
  await browser?.close();
  for (const { program } of processes) program.kill("SIGTERM");
  await Promise.race([Promise.all(processes.map(({ stopped }) => stopped)), delay(5000)]);
  await rm(scratch, { recursive: true, force: true });
}
