import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyEdits, EDITABLE_PATHS } from "../automation/agent-issue.mjs";

const entry = fileURLToPath(new URL("../automation/agent-issue.mjs", import.meta.url));

function textEdit(path, oldText, newText) {
  return { edits: [{ path, oldText, newText }] };
}

test("edits replace literal, unique substrings without opening more files", () => {
  const source = new Map([["README.md", "Text $&.\n"], ["plugin/main.mjs", "leave me alone\n"]]);
  assert.deepEqual(
    [...applyEdits(textEdit("README.md", "$&", "$\u4E2D"), source)],
    [["README.md", "Text $\u4E2D.\n"]],
  );
  assert.equal(source.get("README.md"), "Text $&.\n");
});

test("edits reject protected paths, ambiguous text, no-op output and oversized replacement", () => {
  const source = new Map([["README.md", "abc abc"]]);
  const paths = [
    "../README.md",
    ".github/workflows/pull-request.yml",
    "plugin/lattice-plugin.toml",
    "host/lattice-releases.json",
  ];
  for (const path of paths) {
    assert.throws(() => applyEdits(textEdit(path, "abc abc", "example"), source), /allowlist/);
  }
  assert.throws(() => applyEdits(textEdit("README.md", "abc", "example"), source), /exactly once/);
  assert.throws(() => applyEdits({ edits: [] }, source), /no supported edits/);
  assert.throws(() => applyEdits(textEdit("README.md", "abc abc", "x".repeat(16_100)), source), /size/);
  assert.throws(() => applyEdits(textEdit("README.md", "abc abc", "abc abc"), source), /invalid replacement/i);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "lattice-issue-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const cwd = join(root, "checkout");
  const origin = join(root, "origin.git");
  const bin = join(root, "bin");
  const stateFile = join(root, "state.json");
  const output = join(root, "output");
  const modelProposal = join(root, "proposal.json");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: "",
    GITHUB_REPOSITORY: "owner/lattice-web-ui",
    GITHUB_RUN_ID: "123",
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(root, "summary"),
    DEFAULT_BRANCH: "main",
    ISSUE_NUMBER: "42",
    OPENAI_API_KEY: "",
    DRY_RUN: "false",
    LATTICE_TEST_API_STATE: stateFile,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };

  mkdirSync(cwd);
  mkdirSync(bin);
  function git(...args) {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  for (const path of EDITABLE_PATHS) {
    const dest = join(cwd, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, `Original ${path}\n`);
  }
  git("add", ".");
  git("commit", "-m", "Initial fixture");
  git("init", "--bare", "--initial-branch=main", origin);
  git("remote", "add", "origin", origin);
  git("push", "-u", "origin", "main");

  // Execute the production CLI with a local real Git remote and narrow GitHub API stand-in.
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const file = process.env.LATTICE_TEST_API_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const [, methodFlag, method, path, ...fields] = process.argv.slice(2);
if (methodFlag !== "--method") process.exit(4);
if (method === "GET" && path.endsWith("/issues/42")) {
  console.log(JSON.stringify(state.issue));
} else if (method === "GET" && path.endsWith("/pulls")) {
  if (!fields.includes("state=open") || !fields.includes("head=owner:codex/issue-42")) process.exit(5);
  console.log(JSON.stringify(state.pulls));
} else if (method === "POST" && path.endsWith("/pulls")) {
  if (state.breakPublish) {
    console.error("HTTP 503");
    process.exit(1);
  }
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  const ref = body.head;
  const sha = cp.execFileSync("git", ["rev-parse", "origin/" + ref], { encoding: "utf8" }).trim();
  const pull = {
    number: 11, body: body.body, draft: body.draft,
    head: { ref, sha, repo: { full_name: "owner/lattice-web-ui" } },
    base: { ref: body.base },
  };
  state.pulls.push(pull);
  fs.writeFileSync(file, JSON.stringify(state));
  console.log(JSON.stringify(pull));
} else if (method === "POST" && path.endsWith("/actions/workflows/pull-request.yml/dispatches")) {
  state.dispatches.push(JSON.parse(fs.readFileSync(0, "utf8")));
  fs.writeFileSync(file, JSON.stringify(state));
} else {
  process.exit(9);
}
`, { mode: 0o755 });

  const issue = {
    number: 42,
    state: "open",
    title: "Fix typo",
    body: "Fix a typo in the introduction.",
    labels: [{ name: "agent-ready" }],
  };
  const revision = createHash("sha256").update(JSON.stringify([issue.title, issue.body])).digest("hex");
  const main = git("rev-parse", "main");
  writeFileSync(modelProposal, JSON.stringify({
    sha: main,
    issue: issue.number,
    revision,
    document: textEdit("README.md", "Original README.md", "Updated README.md"),
  }));
  writeFileSync(stateFile, JSON.stringify({ issue, pulls: [], dispatches: [] }));

  return {
    git,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    update: (state) => writeFileSync(stateFile, JSON.stringify(state)),
    run(mode, envOverrides = {}) {
      return spawnSync(process.execPath, [entry, mode, modelProposal], {
        cwd, env: { ...env, ...envOverrides }, encoding: "utf8",
      });
    },
    output: () => readFileSync(output, "utf8"),
  };
}

test("dry run validates label and does not publish or call a model", (t) => {
  const repo = fixture(t);
  const dry = repo.run("plan", { DRY_RUN: "true" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(repo.output(), /mode=dry-run/);
  assert.deepEqual(repo.state().pulls, []);
  const unlabeled = repo.state();
  unlabeled.issue.labels = [];
  repo.update(unlabeled);
  const denied = repo.run("plan", { DRY_RUN: "true" });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /must still be open and labeled/);
});

test("publisher opens exactly one draft PR and dispatches its exact SHA on retries", (t) => {
  const repo = fixture(t);
  const initial = repo.run("publish");
  assert.equal(initial.status, 0, initial.stderr);
  const mode = repo.run("plan");
  assert.equal(mode.status, 0, mode.stderr);
  assert.match(repo.output(), /mode=resume/);
  const retry = repo.run("publish");
  assert.equal(retry.status, 0, retry.stderr);

  const { pulls, dispatches } = repo.state();
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0].draft, true);
  assert.match(pulls[0].body, /Closes #42/);
  assert.equal(repo.git("show", "origin/main:README.md"), "Original README.md");
  assert.equal(repo.git("show", "origin/codex/issue-42:README.md"), "Updated README.md");
  const sha = repo.git("rev-parse", "origin/codex/issue-42");
  assert.deepEqual(dispatches, Array(2).fill({
    ref: "main",
    inputs: { pr_number: "11", head_sha: sha },
  }));
});

test("a published issue branch survives failed PR creation and can be resumed", (t) => {
  const repo = fixture(t);
  const state = repo.state();
  repo.update({ ...state, breakPublish: true });
  const first = repo.run("publish");
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /HTTP 503/);
  assert.equal(repo.state().pulls.length, 0);

  const sha = repo.git("rev-parse", "origin/codex/issue-42");
  // Simulate a fresh checkout of main on the new runner.
  repo.git("reset", "--hard", "origin/main");
  repo.update({ ...state, breakPublish: false });
  const retry = repo.run("publish");
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(repo.state().pulls[0].head.sha, sha);
  assert.equal(repo.git("rev-parse", "HEAD"), repo.git("rev-parse", "origin/main"));
});

test("proposal generation without a provider credential reports the blocked lane", (t) => {
  const repo = fixture(t);
  const blocked = repo.run("propose");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /requires the repository OPENAI_API_KEY secret/);
  assert.deepEqual(repo.state().pulls, []);
});

test("an orphaned proposal is not published if the issue changes after its branch was pushed", (t) => {
  const repo = fixture(t);
  const state = repo.state();
  repo.update({ ...state, breakPublish: true });
  const first = repo.run("publish");
  assert.notEqual(first.status, 0);

  repo.git("reset", "--hard", "origin/main");
  repo.update({ ...state, issue: { ...state.issue, body: "Updated requirements." } });
  const retry = repo.run("publish");
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /does not match an automation commit/);
  assert.deepEqual(repo.state().pulls, []);
});
