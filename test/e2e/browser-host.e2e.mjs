// End-to-end check of an installed host kit with real Lattice behind lattice-gateway.
//
//   LATTICE_E2E_ORIGIN         a gateway reached from outside the tailnet (sign-in and pairing),
//                              e.g. a second gateway on the same Lattice behind test/e2e/tls-front.mjs
//   LATTICE_E2E_TAILNET_ORIGIN the Tailscale Serve/Funnel origin, reached from the owner's tailnet login
//   LATTICE_E2E_AGENT_ORIGIN   the Agent origin that goes with LATTICE_E2E_TAILNET_ORIGIN
//   LATTICE_E2E_PROJECT        a scratch project folder in the host's projects folder (edited by the test)
//   PLAYWRIGHT_CORE            path to playwright-core
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
const tailnet = process.env.LATTICE_E2E_TAILNET_ORIGIN;
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
  // Owner sign-in sits in a disclosure, as on the v0.4.x landing page.
  if (!(await page.locator("details").evaluate((node) => node.open))) await page.locator("summary").click();
  await page.fill("#token", token);
  await page.click("button[type=submit]");
  await page.waitForURL(`${origin}${next}`);
}

/** Open the e2e project from Lattice's own project menu: the gateway lists the
 *  host's projects there. The tab stays the same one. */
async function openProject(page, at = origin) {
  const name = project.split("/").filter(Boolean).at(-1);
  if (new URL(page.url()).origin !== at) await page.goto(`${at}/`);
  await page.locator(".cm-content").first().waitFor({ timeout: 40_000 });
  await page.waitForTimeout(2500); // the gateway adds the projects to Lattice's recent list
  const title = () => page.evaluate(() => document.body.innerText.split("\n")[0].trim());
  if ((await title()) !== name) {
    await page.locator("button", { hasText: await title() }).first().click();
    await page.getByText(name, { exact: true }).first().click();
    for (let i = 0; i < 80 && (await title()) !== name; i++) await page.waitForTimeout(250);
    await page.locator(".cm-content").first().waitFor({ timeout: 40_000 });
  }
  assert.equal(await title(), name);
  return name;
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
  await signInAsOwner(page);
  const name = await openProject(page);
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
  const created = ownerPage.waitForResponse((response) => response.url().endsWith("/__gateway/api/invites"));
  await ownerPage.getByRole("button", { name: "Pair a device" }).click();
  const { url: link } = await (await created).json();
  await ownerPage.locator(".headless-device-code img").waitFor();
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
  await row.getByRole("button", { name: "Revoke" }).click();
  await closed;
  const after = await phone.request.get(`${origin}/__lattice_session`);
  assert.equal(after.status(), 401);
  await owner.close();
  await phone.close();
});

test("the Agent loads from its own origin through the gateway", { skip: (!process.env.LATTICE_E2E_AGENT_ORIGIN || !project || !tailnet) && "set LATTICE_E2E_AGENT_ORIGIN, LATTICE_E2E_TAILNET_ORIGIN and LATTICE_E2E_PROJECT" }, async () => {
  const agentOrigin = process.env.LATTICE_E2E_AGENT_ORIGIN;
  const ctx = await context();
  const page = await ctx.newPage();
  // On the tailnet the owner needs no sign-in. The Agent refuses projects in hidden folders.
  await openProject(page, tailnet);
  await page.evaluate(() => {
    const title = [...document.querySelectorAll('[data-trellis-part="tab-title"]')].find((t) => t.textContent.trim() === "Agent");
    (title?.closest('[data-trellis-part="tab"]') || title?.parentElement)?.click();
  });
  const frame = page.frameLocator(`iframe[src^="${agentOrigin}/"]`);
  await frame.getByRole("textbox").first().waitFor({ timeout: 40_000 });
  if (process.env.LATTICE_E2E_AGENT_TURN) {
    // Runs one turn with the host's signed-in agent CLI. The project's thread
    // keeps earlier turns, so look for an answer after the newest prompt.
    const prompt = `Reply with exactly the word GATEWAY-OK and nothing else. Do not read or edit any files. (${Date.now()})`;
    await frame.getByRole("textbox").first().fill(prompt);
    await page.keyboard.press("Enter");
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 90; i++) {
        const lines = (await frame.locator("body").innerText()).split("\n").map((line) => line.trim());
        const asked = lines.lastIndexOf(prompt);
        if (asked >= 0 && lines.slice(asked + 1).includes("GATEWAY-OK")) return;
        await page.waitForTimeout(2000);
      }
      throw new Error("the Agent did not answer within three minutes");
    });
  }
  await shot(page, "e2e-agent");
  await ctx.close();
});

test("TeX installs are for the owner only", async () => {
  const stranger = await context();
  assert.equal((await stranger.request.post(`${origin}/__gateway/api/tex-install`, { data: { name: "lipsum" }, headers: { Origin: origin } })).status(), 401);
  await stranger.close();
  const ctx = await context();
  const page = await ctx.newPage();
  await signInAsOwner(page);
  const bad = await ctx.request.post(`${origin}/__gateway/api/tex-install`, { data: { name: "a;rm -rf" }, headers: { Origin: origin } });
  assert.ok([400, 404].includes(bad.status()), "a malformed package name is refused before tlmgr runs");
  await ctx.close();
});

test("on a phone, Lattice gets one panel with every view as a tab", { skip: !project && "set LATTICE_E2E_PROJECT" }, async () => {
  const phone = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await phone.newPage();
  await signInAsOwner(page);
  await openProject(page);
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
  await openProject(deskPage);
  await deskPage.waitForTimeout(12_000);
  const panels = await deskPage.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("lattice.trellis-layout.v1:"));
    return key ? JSON.parse(localStorage.getItem(key)).document.root.kind : "none";
  });
  assert.notEqual(panels, "panel", "the wide layout is restored on a wide screen");
  await desk.close();
});

test("on the tailnet the owner gets Lattice with no sign-in and no extra controls", { skip: !tailnet && "set LATTICE_E2E_TAILNET_ORIGIN" }, async () => {
  const ctx = await context();
  const page = await ctx.newPage();
  await page.goto(`${tailnet}/`);
  assert.equal(new URL(page.url()).pathname, "/");
  await page.locator(".cm-content").first().waitFor({ timeout: 40_000 });
  assert.equal(await page.locator("[data-lattice-gateway]").count(), 0, "the gateway adds nothing to Lattice's page");
  await shot(page, "e2e-tailnet");
  await ctx.close();
});
