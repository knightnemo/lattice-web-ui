/** Start two real production distributions whose hashed Settings chunks differ.
 * LATTICE_NEXT_WEB_ASSETS=/path/to/other/dist node server/tests/remote-settings-rollout.browser.mjs
 * LATTICE_WEB_ASSETS, LATTICE_SERVER_BINARY and LATTICE_TEST_BROWSER match remote-workspace.browser.mjs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";

assert.ok(process.env.LATTICE_NEXT_WEB_ASSETS, "Set LATTICE_NEXT_WEB_ASSETS to a different production distribution");
const next = resolve(process.env.LATTICE_NEXT_WEB_ASSETS);
const current = resolve(process.env.LATTICE_WEB_ASSETS ?? "dist");
const binary = resolve(process.env.LATTICE_SERVER_BINARY ?? "server/target/debug/lattice-server");
const engine = process.env.LATTICE_TEST_BROWSER === "webkit" ? webkit : chromium;
const scratch = await mkdtemp(join(tmpdir(), "lattice-settings-rollout-"));
const projects = join(scratch, "projects");
const project = join(projects, "Paper");
const document = join(project, "main.tex");
const token = randomBytes(32).toString("hex");
const tokenFile = join(scratch, "token");
const reservation = createServer();
await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
const address = `127.0.0.1:${reservation.address().port}`;
await new Promise((closed) => reservation.close(closed));
const origin = `http://${address}`;
let server, stopped, browser;

async function start(assets) {
  server = spawn(binary, ["serve", "--listen", address, "--project", project, "--workspace-root", projects,
    "--state-dir", join(scratch, "state"), "--token-file", tokenFile, "--assets", assets], { stdio: "ignore" });
  stopped = new Promise(resolve => server.once("close", resolve));
  for (let i = 0; i < 120; i++) {
    if (await fetch(origin + "/api/session").then(response => response.ok).catch(() => false)) return;
    if (server.exitCode !== null) throw new Error("The test server exited prematurely");
    await delay(100);
  }
  throw new Error("The test server did not start");
}

async function stop() {
  if (!server || server.exitCode !== null || server.signalCode) return;
  server.kill("SIGTERM");
  const timeout = setTimeout(() => server.kill("SIGKILL"), 8000);
  try { await stopped; } finally { clearTimeout(timeout); }
}

try {
  await mkdir(project, { recursive: true });
  await writeFile(document, "\\documentclass{article}\n\\begin{document}\nSettings rollout\n\\end{document}\n");
  await writeFile(tokenFile, token, { mode: 0o600 });
  await start(current);
  browser = await engine.launch(engine === chromium ? { channel: "chrome" } : {});
  const page = await browser.newPage();
  const missingSettings = [];
  const errors = [];
  page.on("response", response => {
    if (response.status() === 404 && /\/assets\/settings-dialog-[^/]+\.js$/.test(new URL(response.url()).pathname))
      missingSettings.push(response.url());
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const login = async () => {
    await page.getByLabel("Server access token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  };
  await login();
  const editor = page.locator(".cm-content").first();
  await editor.getByText("Settings rollout", { exact: true }).waitFor();
  const node = await editor.elementHandle();
  const revision = () => page.locator('meta[name="lattice-web-build"]').getAttribute("content");
  const before = await revision();
  await stop();
  await start(next);
  await page.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke("refresh_project"); } catch { /* The new process requires sign-in. */ }
  });
  await login();
  const reload = page.getByRole("button", { name: "Save and reload" });
  await reload.waitFor();
  await reload.locator("xpath=ancestor::*[@data-app-toast]").getByRole("button", { name: "Dismiss notification" }).click();
  await reload.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    window.holdTestWrites = true;
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (window.holdTestWrites && input === "/api/invoke" && JSON.parse(options?.body ?? "null")?.command === "write_project_file")
        return Promise.resolve(Response.json({ error: { message: "Fixture write unavailable" } }, { status: 503 }));
      return fetch(input, options);
    };
  });
  const draft = "Unsaved while opening Settings";
  await editor.focus();
  await page.keyboard.insertText(draft);
  await page.keyboard.press("Meta+,");
  await reload.waitFor();
  assert.ok(missingSettings.length, "use a replacement build without the old Settings module");
  assert.equal(await editor.evaluate((element, previous) => element === previous, node), true);
  assert.ok((await editor.innerText()).includes(draft));
  assert.ok(!(await readFile(document, "utf8")).includes(draft));
  await reload.click();
  await page.getByText("Your workspace stayed open. Finish any active edit or sync, then try again.").waitFor();
  assert.equal(await revision(), before);
  await page.evaluate(() => { window.holdTestWrites = false; });
  await Promise.all([page.waitForEvent("domcontentloaded"), reload.click()]);
  await page.waitForFunction(text => document.querySelector(".cm-content")?.textContent.includes(text), draft);
  assert.notEqual(await revision(), before);
  assert.ok((await readFile(document, "utf8")).includes(draft));
  assert.deepEqual(errors, []);
  console.log(`${engine.name()}: first Settings open after deployment kept the editor and dirty draft; retry saved and restored the draft in the new build.`);
} finally {
  await browser?.close();
  await stop();
  await rm(scratch, { recursive: true, force: true });
}
