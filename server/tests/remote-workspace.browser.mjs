/** Run against the standalone server and the production web bundle on loopback. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";

const engine = process.env.LATTICE_TEST_BROWSER === "webkit" ? webkit : chromium;
const binary = resolve(process.env.LATTICE_SERVER_BINARY ?? "server/target/debug/lattice-server");
const scratch = await mkdtemp(join(tmpdir(), "lattice-duo-"));
const assets = join(scratch, "web");
await cp(resolve(process.env.LATTICE_WEB_ASSETS ?? "dist"), assets, { recursive: true, mode: constants.COPYFILE_FICLONE });
await writeFile(join(assets, "lattice-host-update.json"), JSON.stringify({
  schema: 1, installedVersion: "0.4.3", latestVersion: "0.5.0",
}));
const projects = join(scratch, "projects");
const project = join(projects, "Duo Paper");
const main = join(project, "main.tex");
const original = "\\documentclass{article}\n\\begin{document}\nA test paper for folding and unfolding.\n\\end{document}\n";
await mkdir(project, { recursive: true });
await writeFile(main, original);
const other = join(projects, "Second Paper");
await mkdir(other);
await writeFile(join(other, "main.tex"), original.replace("A test paper for folding and unfolding.", "Another project."));

const reservation = createServer();
await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
const port = reservation.address().port;
await new Promise((closed) => reservation.close(closed));
const origin = `http://127.0.0.1:${port}`;
const tokenPath = join(scratch, "access-token");
const server = spawn(binary, [
  "serve", "--workspace-root", projects, "--project", project,
  "--state-dir", join(scratch, "state"), "--token-file", tokenPath,
  "--listen", `127.0.0.1:${port}`, "--assets", assets,
], { stdio: ["ignore", "ignore", "inherit"] });
const serverStopped = new Promise((done) => server.once("close", done));
let browser;

async function until(check, message) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await delay(125);
  }
  assert.fail(message);
}

try {
  await until(async () => (await fetch(origin + "/api/session").catch(() => null))?.ok, "server started");
  browser = await engine.launch(engine === chromium ? { channel: "chrome" } : {});
  const browsing = await browser.newContext({
    viewport: { width: 382, height: 580 }, isMobile: true, hasTouch: true, reducedMotion: "reduce",
  });
  const page = await browsing.newPage();
  const errors = [];
  const githubTraffic = [];
  browsing.on("request", (request) => {
    const { hostname, pathname } = new URL(request.url());
    if (["github.com", "api.github.com"].includes(hostname) && pathname.includes("/lattice-writer/lattice-web-ui")) githubTraffic.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Server access token").fill((await readFile(tokenPath, "utf8")).trim());
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const hostUpdate = page.getByRole("region", { name: "Host update" });
  await hostUpdate.getByText("Lattice-web-ui 0.5.0 is available.", { exact: true }).waitFor();
  assert.equal(await hostUpdate.getByRole("button", { name: "Update host" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Save and reload" }).count(), 0);

  if (engine === chromium) {
    const devtools = await browsing.newCDPSession(page);
    const { manifest, errors } = await devtools.send("Page.getAppManifest");
    assert.deepEqual(errors, []);
    assert.equal(manifest.launchHandler.clientMode, "kFocusExisting");
    await devtools.detach();
  }
  const editor = page.locator(".cm-content").first();
  await editor.waitFor();
  const bounds = async () => editor.evaluate((content) => {
    const rect = (element) => element?.getBoundingClientRect().toJSON() ?? null;
    const panels = document.querySelectorAll('[data-trellis-part="panel"]');
    const caret = content.getBoundingClientRect();
    const source = [...panels].find((panel) => {
      const box = panel.getBoundingClientRect();
      return panel.querySelector('[data-type="file"][data-selected]') &&
        caret.x >= box.left - 1 && caret.x < box.right && caret.y >= box.top - 1 && caret.y < box.bottom;
    });
    return [
      rect(source),
      rect([...panels].find((panel) => panel.querySelector('[data-type="pdf"][data-selected]'))),
      rect(document.querySelector("main.trellis-workspace")),
    ];
  });
  const checkCompact = async () => {
    const [source, pdf, workspace] = await bounds();
    if (!source || !workspace || source.width < workspace.width * 0.8) return false;
    return !pdf || pdf.x >= workspace.x + workspace.width - 2 || pdf.x + pdf.width <= workspace.x + 2;
  };
  const checkSpread = async () => {
    const [source, pdf, workspace] = await bounds();
    return source && pdf && workspace && source.width > 220 && pdf.width > 200
      && source.x >= workspace.x - 2 && source.x + source.width <= pdf.x + 2
      && pdf.x + pdf.width <= workspace.x + workspace.width + 2 && Math.abs(source.y - pdf.y) <= 3;
  };
  await until(checkCompact, "outer portrait has only the editor").catch(async (error) => {
    console.error("Initial layouts:", JSON.stringify(await bounds()));
    console.error(await editor.evaluate((el) => [...document.querySelectorAll('[data-trellis-part="panel"]')].map((panel) => {
      const rect = panel.getBoundingClientRect().toJSON();
      const names = [...panel.querySelectorAll('[data-trellis-part="tab"]')].map((node) => node.textContent);
      return { rect, names };
    })));
    throw error;
  });
  const built = page.waitForResponse((response) => response.url().endsWith("/api/invoke") &&
    response.request().postDataJSON()?.command === "build_project");
  await page.getByRole("navigation", { name: "Workspace panels" }).getByRole("button", { name: "Build", exact: true }).click();
  assert.ok((await built).ok());

  await page.evaluate(() => {
    const fetch = window.fetch.bind(window);
    const paused = new Promise((resume) => { window.resumeDuoTestWrites = resume; });
    window.fetch = async (input, options) => {
      if (input === "/api/invoke" && JSON.parse(options?.body ?? "null")?.command === "write_project_file") {
        window.duoTestSaveRequested = true;
        await paused;
      }
      return fetch(input, options);
    };
  });
  await editor.getByText("A test paper for folding and unfolding.", { exact: true }).click();
  await page.keyboard.type("unsaved ");
  await page.keyboard.press("ArrowLeft");
  await until(async () => (await editor.innerText()).includes("unsaved "), "edit is in the editor");
  const save = page.getByRole("navigation", { name: "Workspace panels" }).getByRole("button", { name: "Save", exact: true });
  await until(() => save.isEnabled(), "editor marked the draft as dirty");
  // Start saving without moving focus away from the active text selection.
  await save.dispatchEvent("click");
  await until(() => page.evaluate(() => window.duoTestSaveRequested), "the pending save is paused before folding");
  const element = await editor.elementHandle();
  const caret = async () => editor.evaluate((content) => {
    const selected = window.getSelection();
    if (!selected?.focusNode || !content.contains(selected.focusNode)) return null;
    const range = document.createRange();
    range.setStart(content, 0);
    range.setEnd(selected.focusNode, selected.focusOffset);
    return { offset: range.toString().length, collapsed: selected.isCollapsed };
  });
  const selection = await caret();
  assert.ok(selection?.offset > 0);

  for (const [width, height, expanded] of [[669, 867, true], [382, 580, false], [951, 585, true], [594, 368, false], [669, 867, true], [385, 571, false], [669, 867, true]]) {
    await page.setViewportSize({ width, height });
    await until(expanded ? checkSpread : checkCompact, `correct layout at ${width} × ${height}`).catch(async (error) => {
      console.error("Resize bounds:", JSON.stringify(await bounds()));
      console.error(JSON.stringify(await editor.evaluate((content) => ({
        viewport: [window.innerWidth, window.innerHeight],
        content: content.getBoundingClientRect().toJSON(),
        panels: [...document.querySelectorAll('[data-trellis-part="panel"]')].map((panel) => ({
          rect: panel.getBoundingClientRect().toJSON(),
          tabs: [...panel.querySelectorAll('[data-trellis-part="tab"]')].map((node) => [node.textContent,node.hasAttribute("data-selected")]),
        })),
      }))));
      throw error;
    });
    const panelNav = page.getByRole("navigation", { name: "Workspace panels" });
    const expected = expanded ? ["Editor", "PDF"] : ["Editor"];
    await until(async () => {
      const active = await panelNav.getByRole("button", { pressed: true }).allTextContents();
      return active.join(",") === expected.join(",");
    }, `panel indicators match the visible layout at ${width} × ${height}`);
    assert.equal(await editor.evaluate((node, originalEditor) => node === originalEditor, element), true, "keeps the same editor DOM");
    assert.deepEqual(await caret(), selection, "keeps the caret after resize");
    assert.match(await editor.innerText(), /unsaved /);
    assert.equal(await readFile(main, "utf8"), original, "save is held while testing the draft");
  }
  await page.locator(".trellis-pdf canvas").first().waitFor({ state: "visible", timeout: 30_000 });
  // A compiled PDF downloads to the browser's device, even with the toolbar folded.
  const download = page.waitForEvent("download");
  const savePdf = page.getByRole("button", { name: "Save PDF as…" });
  if (await savePdf.isVisible()) await savePdf.click();
  else {
    await page.getByRole("button", { name: "More PDF actions" }).click();
    await page.getByRole("menuitem", { name: "Save PDF as…" }).click();
  }
  const pdf = await download;
  assert.match(pdf.suggestedFilename(), /\.pdf$/i);
  assert.deepEqual(await readFile(await pdf.path()), await readFile(join(project, "main.pdf")));

  await page.evaluate(() => window.resumeDuoTestWrites());
  await until(async () => (await readFile(main, "utf8")).includes("unsaved "), "normal save works after unfolding");
  // Open another project in the same page, then return via the project tab.
  await editor.click();
  await page.keyboard.type("switch draft ");
  const projectCaret = await caret();
  assert.ok(projectCaret?.offset > 0);
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Open another folder" }).click();
  await page.getByRole("dialog", { name: "Open server project" }).getByRole("button", { name: "Second Paper" }).click();
  await until(async () => (await editor.innerText()).includes("Another project."), "the chosen project opens");
  assert.match(await readFile(main, "utf8"), /switch draft/);
  const projectTabs = page.getByRole("navigation", { name: "Open projects" });
  const firstProjectTab = projectTabs.getByRole("button", { name: "Duo Paper", exact: true });
  const secondProjectTab = projectTabs.getByRole("button", { name: "Second Paper", exact: true });
  assert.equal(await secondProjectTab.getAttribute("aria-current"), "page");
  await firstProjectTab.click();
  await until(async () => (await editor.innerText()).includes("switch draft"), "the first project returns with its saved edit");
  await editor.focus();
  await until(async () => (await caret())?.offset === projectCaret.offset, "the first project's caret position is restored");
  assert.equal(await firstProjectTab.getAttribute("aria-current"), "page");
  // Both tabs use the same authenticated session. Explicitly opening a second
  // tab must not couple its project to this tab's project or update.
  const secondTab = await page.context().newPage();
  await secondTab.goto(origin, { waitUntil: "domcontentloaded" });
  const otherEditor = secondTab.locator(".cm-content").first();
  await until(async () => (await otherEditor.innerText()).includes("switch draft"), "second tab opened the default project");
  await page.bringToFront();
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Second Paper" }).click();
  await until(async () => (await editor.innerText()).includes("Another project."), "the recent project opened in this tab");
  assert.equal(page.context().pages().length, 2);
  assert.match(await otherEditor.innerText(), /switch draft/);

  // Model a redeploy of the compiled entry while the user is writing. Only the
  // version probe is substituted; saves, project switching and reload use the server.
  await page.evaluate(() => {
    const fetch = window.fetch.bind(window);
    window.denyUpdateTestSave = true;
    window.fetch = async (input, init) => {
      if (new URL(String(input), location.href).pathname === "/index.html") {
        const response = await fetch(input, init);
        const html = (await response.text()).replace(/(name="lattice-web-build" content=")[a-f0-9]+/, "$1" + "f".repeat(24));
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }
      if (input === "/api/invoke" && window.denyUpdateTestSave && JSON.parse(init?.body ?? "null")?.command === "write_project_file") {
        return Response.json({ error: { message: "Fixture save unavailable" } }, { status: 503 });
      }
      return fetch(input, init);
    };
    window.dispatchEvent(new Event("online"));
  });
  const reload = page.getByRole("button", { name: "Save and reload" });
  await reload.waitFor();
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Editor & builds" }).click();
  await settings.getByText("This host runs Lattice-web-ui 0.4.3. Version 0.5.0 is available on GitHub.").waitFor();
  assert.equal(await settings.getByRole("link", { name: "View release notes" }).getAttribute("href"),
    "https://github.com/lattice-writer/lattice-web-ui/releases/tag/v0.5.0");
  await settings.getByRole("button", { name: "Save and reload" }).waitFor();
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  const originalClient = await page.evaluate(() => window.__LATTICE_HEADLESS_CLIENT__);
  await editor.click();
  await page.keyboard.type("update draft ");
  await reload.click();
  await page.getByText("Your workspace stayed open. Finish any active edit or sync, then try again.").waitFor();
  assert.equal(await page.evaluate(() => window.__LATTICE_HEADLESS_CLIENT__), originalClient);
  assert.match(await editor.innerText(), /update draft/);
  await page.evaluate(() => { window.denyUpdateTestSave = false; });
  await Promise.all([page.waitForEvent("domcontentloaded"), reload.click()]);
  await until(async () => (await editor.innerText()).includes("update draft"), "reload restored the edited project");
  assert.notEqual(await page.evaluate(() => window.__LATTICE_HEADLESS_CLIENT__), originalClient);
  assert.equal(await secondProjectTab.getAttribute("aria-current"), "page");
  assert.equal(await firstProjectTab.count(), 1);
  assert.match(await readFile(join(other, "main.tex"), "utf8"), /update draft/);
  assert.match(await otherEditor.innerText(), /switch draft/);
  assert.equal(page.context().pages().length, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(githubTraffic, []);
  console.log(`${engine.name()}: Duo layouts, draft, caret, save, PDF download, independent project navigation and save-before-update reload passed.`);
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill("SIGTERM");
  await Promise.race([serverStopped, delay(5000)]);
  await rm(scratch, { recursive: true, force: true });
}
