// End-to-end check of an installed host kit, through a real HTTPS entrance.
//
// Needs: `lattice-host install --public-origin https://127.0.0.1:18491 --projects-root <dir>`
// with a project folder in <dir> that has main.tex, test/e2e/tls-front.mjs running on 18491,
// and playwright-core with a Chromium build. Run:
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core LATTICE_E2E_PROJECT=<dir>/<project> \
//     node --test test/e2e/browser-host.e2e.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const origin = process.env.LATTICE_E2E_ORIGIN || "https://127.0.0.1:18491";
const project = process.env.LATTICE_E2E_PROJECT;
const root = process.env.LATTICE_HOST_ROOT || join(homedir(), ".local/share/lattice-host");
const token = readFileSync(join(root, "access-token"), "utf8").trim();
const shots = process.env.LATTICE_E2E_SHOTS;

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function context(options = {}) {
  return browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, ...options });
}

async function signInAsOwner(page, next = "/") {
  await page.goto(`${origin}/__gateway/login?next=${encodeURIComponent(next)}`);
  await page.fill("#token", token);
  await page.click("button[type=submit]");
  await page.waitForURL(`${origin}${next}`);
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

test("a stranger only ever sees the sign-in page", async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  await page.goto(`${origin}/`);
  assert.equal(new URL(page.url()).pathname, "/__gateway/login");
  const api = await ctx.request.get(`${origin}/__lattice_session`);
  assert.equal(api.status(), 401);
  await ctx.close();
});

test("the owner opens a project, edits it, and the edit reaches the disk", { skip: !project && "set LATTICE_E2E_PROJECT" }, async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInAsOwner(page, "/__gateway/projects");
  const name = project.split("/").filter(Boolean).at(-1);
  await page.locator("li", { hasText: name }).getByRole("button").click();
  // Lattice opens the project in a new workspace and the tab follows it.
  await page.waitForURL(/\/\?entry=/, { timeout: 40_000 });
  await page.locator(".cm-content").first().waitFor({ timeout: 30_000 });
  await page.getByText(name, { exact: true }).first().waitFor();
  const marker = `% edited through lattice-gateway ${Date.now()}`;
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\n${marker}`);
  await page.keyboard.press("Control+s");
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 40; i++) {
      if (readFileSync(join(project, "main.tex"), "utf8").includes(marker)) return;
      await page.waitForTimeout(250);
    }
    throw new Error("the edit never reached main.tex");
  });
  await shot(page, "e2e-owner-edit");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("a paired phone reaches Lattice, and revoking it cuts it off", async () => {
  const owner = await context();
  const ownerPage = await owner.newPage();
  await signInAsOwner(ownerPage, "/__gateway/devices");
  await ownerPage.getByRole("button", { name: "Pair a device" }).click();
  const link = await ownerPage.locator(".qr input").inputValue();
  assert.match(link, new RegExp(`^${origin.replace(/[.]/g, "\\.")}/__gateway/pair#[0-9a-f]{48}$`));
  await shot(ownerPage, "e2e-invite");

  const phone = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phonePage = await phone.newPage();
  const bridgeOpened = phonePage.waitForEvent("websocket", {
    predicate: (socket) => socket.url().includes("/__lattice_bridge"), timeout: 40_000,
  });
  await phonePage.goto(link);
  const label = `E2E phone ${Date.now() % 1_000_000}`;
  await phonePage.fill("#label", label);
  await phonePage.getByRole("button", { name: "Connect this device" }).click();
  await phonePage.waitForURL(`${origin}/`);
  const bridge = await bridgeOpened;
  assert.match(bridge.url(), /^wss:\/\/[^/]+\/__lattice_bridge\?/, "the phone reached Lattice's bridge through the gateway");
  await phonePage.waitForFunction(() => window.__LATTICE_BROWSER_RUNTIME__ === true, null, { timeout: 30_000 });
  await shot(phonePage, "e2e-phone");

  const closed = new Promise((resolve) => bridge.on("close", resolve));
  await ownerPage.reload();
  const row = ownerPage.locator("li", { hasText: label });
  await row.getByRole("button").click();
  await row.getByRole("button").click(); // confirm
  await closed;
  const after = await phone.request.get(`${origin}/__lattice_session`);
  assert.equal(after.status(), 401);
  await owner.close();
  await phone.close();
});

test("the Agent loads from its own origin through the gateway", { skip: !process.env.LATTICE_E2E_AGENT_ORIGIN && "set LATTICE_E2E_AGENT_ORIGIN" }, async () => {
  const agentOrigin = process.env.LATTICE_E2E_AGENT_ORIGIN;
  const ctx = await context();
  const page = await ctx.newPage();
  await signInAsOwner(page);
  await page.locator(".cm-content").first().waitFor({ timeout: 40_000 });
  await page.evaluate(() => {
    const title = [...document.querySelectorAll('[data-trellis-part="tab-title"]')].find((t) => t.textContent.trim() === "Agent");
    (title?.closest('[data-trellis-part="tab"]') || title?.parentElement)?.click();
  });
  const frame = page.frameLocator(`iframe[src^="${agentOrigin}/"]`);
  await frame.getByRole("textbox").first().waitFor({ timeout: 40_000 });
  if (process.env.LATTICE_E2E_AGENT_TURN) {
    // Runs one turn with the host's signed-in agent CLI.
    await frame.getByRole("textbox").first().fill("Reply with exactly the word GATEWAY-OK and nothing else. Do not read or edit any files.");
    await page.keyboard.press("Enter");
    await frame.getByText("GATEWAY-OK", { exact: true }).waitFor({ timeout: 180_000 });
  }
  await shot(page, "e2e-agent");
  await ctx.close();
});

test("host windows and TeX installs are for the owner only", async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  await signInAsOwner(page);
  const owner = await ctx.request.get(`${origin}/__gateway/api/screen/state`);
  assert.equal(owner.status(), 200);
  const stranger = await context();
  assert.equal((await stranger.request.get(`${origin}/__gateway/api/screen.png`)).status(), 401);
  assert.equal((await stranger.request.post(`${origin}/__gateway/api/tex-install`, { data: { name: "lipsum" }, headers: { Origin: origin } })).status(), 401);
  const bad = await ctx.request.post(`${origin}/__gateway/api/tex-install`, { data: { name: "a;rm -rf" }, headers: { Origin: origin } });
  assert.ok([400, 404].includes(bad.status()), "a malformed package name is refused before tlmgr runs");
  await stranger.close();
  await ctx.close();
});

test("the owner's terminal runs a shell on the host", async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  await signInAsOwner(page);
  const config = await (await ctx.request.get(`${origin}/__gateway/api/config`)).json();
  if (!config.terminal) return; // not enabled on this host
  await page.goto(`${origin}/__gateway/terminal`);
  await page.locator(".xterm").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.locator(".xterm").click();
  await page.keyboard.type("echo gateway-$((6*7))");
  await page.keyboard.press("Enter");
  await page.locator(".xterm-rows", { hasText: "gateway-42" }).waitFor({ timeout: 15_000 });
  await shot(page, "e2e-terminal");
  const stranger = await context();
  assert.equal((await stranger.request.get(`${origin}/__gateway/api/terminal`)).status(), 401);
  await stranger.close();
  await ctx.close();
});

test("on a phone, Lattice gets one panel with every view as a tab", { skip: !project && "set LATTICE_E2E_PROJECT" }, async () => {
  const phone = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await phone.newPage();
  await signInAsOwner(page);
  // The layout switch reloads the page once.
  await page.waitForTimeout(12_000);
  await page.locator(".cm-content").first().waitFor({ timeout: 30_000 });
  const width = await page.locator(".cm-content").first().evaluate((node) => node.getBoundingClientRect().width);
  assert.ok(width > 250, `the editor fills the phone (${Math.round(width)} px)`);
  await shot(page, "e2e-phone-layout");
  await phone.close();
  // The desktop gets its own layout back.
  const desk = await context();
  const deskPage = await desk.newPage();
  await signInAsOwner(deskPage);
  await deskPage.waitForTimeout(12_000);
  const panels = await deskPage.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("lattice.trellis-layout.v1:"));
    return key ? JSON.parse(localStorage.getItem(key)).document.root.kind : "none";
  });
  assert.notEqual(panels, "panel", "the wide layout is restored on a wide screen");
  await desk.close();
});
