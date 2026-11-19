/** Run against the standalone server and the production web bundle on loopback. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright-core";

const engine = process.env.LATTICE_TEST_BROWSER === "webkit" ? webkit : chromium;
const binary = resolve(process.env.LATTICE_SERVER_BINARY ?? "server/target/debug/lattice-server");
const assets = resolve(process.env.LATTICE_WEB_ASSETS ?? "dist");
const scratch = await mkdtemp(join(tmpdir(), "lattice-duo-"));
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
  const page = await browser.newPage({
    viewport: { width: 382, height: 580 }, isMobile: true, hasTouch: true, reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Server access token").fill((await readFile(tokenPath, "utf8")).trim());
  await page.getByRole("button", { name: "Connect", exact: true }).click();

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
  // Switch a working tab via the regular picker and back via Recent projects.
  await editor.click();
  await page.keyboard.type("switch draft ");
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Open another folder" }).click();
  await page.getByRole("dialog", { name: "Open server project" }).getByRole("button", { name: "Second Paper" }).click();
  await until(async () => (await editor.innerText()).includes("Another project."), "the chosen project opens");
  assert.match(await readFile(main, "utf8"), /switch draft/);
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("menuitem", { name: "Duo Paper" }).click();
  await until(async () => (await editor.innerText()).includes("switch draft"), "the recent project reopens with its saved edit");
  assert.deepEqual(errors, []);
  console.log(`${engine.name()}: Duo layouts, draft, caret, save, PDF download and server project switching passed.`);
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill("SIGTERM");
  await Promise.race([serverStopped, delay(5000)]);
  await rm(scratch, { recursive: true, force: true });
}
