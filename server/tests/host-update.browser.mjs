/** Check the hosted update bar and its real owner API against a packaged web build. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";

const scratch = await mkdtemp(join(tmpdir(), "lattice-host-update-browser-"));
const release = join(scratch, "release");
const workspace = join(scratch, "workspace");
const updates = join(scratch, "updates");
const token = join(scratch, "access-token");
await Promise.all([release, workspace, updates].map((path) => mkdir(path)));
const binary = join(release, "lattice-server");
await copyFile(resolve(process.env.LATTICE_SERVER_BINARY ?? "server/target/debug/lattice-server"), binary);
await writeFile(join(release, "release-version.txt"), "0.4.8\n");
await writeFile(join(workspace, "main.tex"), "\\documentclass{article}\n\\begin{document}\nAn isolated project.\n\\end{document}\n");

async function phase(phase) {
  const next = join(updates, "status.next");
  await writeFile(next, JSON.stringify({
    schema: 1, installedVersion: "0.4.8", latestVersion: "0.4.9", phase,
  }));
  await rename(next, join(updates, "status.json"));
}
await phase("ready");

const reservation = createServer();
await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
const port = reservation.address().port;
await new Promise((closed) => reservation.close(closed));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(binary, [
  "serve", "--workspace-root", workspace, "--state-dir", join(scratch, "state"),
  "--token-file", token, "--listen", `127.0.0.1:${port}`,
  "--assets", resolve(process.env.LATTICE_WEB_ASSETS ?? "dist"), "--host-update-dir", updates,
], { stdio: ["ignore", "ignore", "inherit"] });
const stopped = new Promise((done) => server.once("close", done));
let browser;

try {
  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if ((await fetch(origin + "/api/host-update/health").catch(() => null))?.ok) {
      healthy = true;
      break;
    }
    await delay(125);
  }
  assert.ok(healthy, "managed server started");
  const engine = process.env.LATTICE_TEST_BROWSER === "webkit" ? webkit : chromium;
  browser = await engine.launch(engine === chromium ? { channel: "chrome" } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Server access token").fill((await readFile(token, "utf8")).trim());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const banner = page.getByRole("region", { name: "Host update" });
  await banner.getByText("Lattice-web-ui 0.4.9 is ready to install.").waitFor();
  const button = banner.getByRole("button", { name: "Update host", exact: true });
  assert.ok(await button.isEnabled());
  assert.ok((await banner.boundingBox()).y < 25);
  const screenshotDir = process.env.LATTICE_UPDATE_SCREENSHOTS;
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "update-host-desktop.png") });
  await page.setViewportSize({ width: 375, height: 760 });
  assert.ok(await button.isVisible());
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "update-host-mobile.png") });

  const approved = page.waitForResponse((response) =>
    response.url() === origin + "/api/host-update" && response.request().method() === "POST");
  await button.click();
  assert.equal((await approved).status(), 202);
  assert.equal(await readFile(join(updates, "request"), "utf8"), "0.4.9\n");
  await banner.getByText("Preparing Lattice-web-ui 0.4.9 in the background…").waitFor();
  assert.ok(await button.isDisabled());
  await phase("waiting");
  await banner.getByText(/Waiting for open Agent sessions/).waitFor();
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "update-host-waiting.png") });
  await rm(join(updates, "request"));
  await phase("rolled_back");
  await banner.getByText("Update failed. The host is back on 0.4.8.").waitFor();
  assert.ok(await button.isEnabled());
  assert.deepEqual(errors, []);
  console.log("Host update banner and owner approval passed.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  const kill = setTimeout(() => server.kill("SIGKILL"), 3000);
  await stopped;
  clearTimeout(kill);
  await rm(scratch, { recursive: true, force: true });
}
