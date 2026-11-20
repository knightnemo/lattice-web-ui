import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsPackaging, plan, publish } from "../automation/pr-ci.mjs";
import { currentPull, githubApi, parsePullRequest, pullFiles } from "../automation/pr-github.mjs";
import { formatReview, prepareReview, validateFindings } from "../automation/pr-review.mjs";

const head = "a".repeat(40);
const headRequest = { number: 2, head };
const patch = "@@ -41,2 +41,3 @@ configure\n const value = input.trim();\n+const normalized = value.toLowerCase();\n return value;";
const proposal = { filename: "plugin/main.mjs", patch };

test("rejects control strings in dispatch inputs, and stale, closed or rebased PRs", async () => {
  assert.deepEqual(parsePullRequest("2", head), headRequest);
  for (const number of ["2/../../", "0", "-2", "1\nHEAD"]) {
    assert.throws(() => parsePullRequest(number, head), /Invalid pull request number/);
  }
  assert.throws(() => parsePullRequest("2", "HEAD"), /Invalid pull request head/);
  const pull = { state: "open", head: { sha: head }, base: { ref: "main" } };
  assert.equal(await currentPull(async () => pull, headRequest, "main"), pull);
  for (const wrong of [
    { ...pull, state: "closed" },
    { ...pull, head: { sha: "b".repeat(40) } },
    { ...pull, base: { ref: "other" } },
  ]) assert.equal(await currentPull(async () => wrong, headRequest, "main"), null);
});

test("paginates bounded file metadata and selects packaging for incomplete data or packaging-affecting paths", async () => {
  const apiPaths = [];
  const files = Array.from({ length: 100 }, () => ({ filename: "notes.md" }));
  const api = async (path) => {
    apiPaths.push(path);
    return files;
  };
  assert.deepEqual(await pullFiles(api, 2, 150, 1), { files, complete: false });
  assert.equal(apiPaths.length, 1);
  assert.equal(needsPackaging(files, [], true), false);
  assert.equal(needsPackaging(files, [], false), true);
  assert.equal(needsPackaging(files, [{ name: "full-ci" }], true), true);
  assert.equal(needsPackaging([proposal], [], true), true);
  assert.equal(needsPackaging([{ filename: "docs/assets/lattice-web-ui.png" }], [], true), true);
  assert.equal(needsPackaging([{ filename: "notes.md", previous_filename: "scripts/pack-plugin.mjs" }], [], true), true);
});

test("packaging uses the exact PR pin and requires its tag, commit and tree", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lattice-pr-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = "lattice-writer/lattice-web-ui";
  const base = "b".repeat(40);
  const pin = {
    snapshotTag: "companion/v0.5.0",
    snapshotCommit: "c".repeat(40),
    originalCommit: "d".repeat(40),
    tree: "e".repeat(40),
  };
  const env = {
    GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/heads/main", GITHUB_SHA: base,
    GITHUB_OUTPUT: join(directory, "output"), GITHUB_STEP_SUMMARY: join(directory, "summary"),
  };
  const pull = {
    state: "open", head: { sha: head }, base: { ref: "main", repo: { full_name: repo } },
    labels: [], changed_files: 1,
  };
  const object = { type: "commit", sha: pin.snapshotCommit };
  const api = ({ filePin = pin, ref = { object }, tree = pin.tree, filename = "automation/release-source.json", hostKit = false } = {}) =>
    async (path) => {
      if (path === "/git/ref/heads/main") return { object: { type: "commit", sha: base } };
      if (path === "/pulls/2") return pull;
      if (path === "/pulls/2/files?per_page=100&page=1") return [{ filename }];
      if (path === `/contents/host/lattice-releases.json?ref=${head}`) return hostKit ? { type: "file" } : null;
      assert.notEqual(filename, "CONTRIBUTING.md", "a docs-only PR should skip the snapshot lookup");
      assert.equal(hostKit, false, "a host-kit PR has no companion snapshot to look up");
      if (path === `/contents/automation/release-source.json?ref=${head}`) {
        const bytes = Buffer.from(JSON.stringify(filePin));
        return { type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
      }
      if (path === `/git/ref/tags/${pin.snapshotTag}`) return ref;
      assert.equal(path, `/git/commits/${pin.snapshotCommit}`);
      return { tree: { sha: tree } };
    };

  await assert.rejects(plan(api({ filePin: { ...pin, snapshotTag: "v0.5.0" } }), headRequest, env), /requires a companion/);
  await assert.rejects(plan(api({ ref: null }), headRequest, env), /tag is missing/);
  await assert.rejects(plan(api({ ref: { object: { type: "tag", sha: object.sha } } }), headRequest, env), /point directly/);
  await assert.rejects(plan(api({ ref: { object: { ...object, sha: base } } }), headRequest, env), /pinned commit/);
  await assert.rejects(plan(api({ tree: base }), headRequest, env), /wrong tree/);
  await plan(api(), headRequest, env);
  await plan(api({ filename: "CONTRIBUTING.md" }), headRequest, env);
  await plan(api({ filename: "host/lattice-host.py", hostKit: true }), headRequest, env);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"),
    `head=${head}\nnumber=2\npackaging=true\ncompanion_sha=${pin.snapshotCommit}\nlayout=companion\n` +
    `head=${head}\nnumber=2\npackaging=false\ncompanion_sha=\nlayout=companion\n` +
    `head=${head}\nnumber=2\npackaging=true\ncompanion_sha=\nlayout=host-kit\n`);
});

test("the required CI result belongs to current main and the exact open PR head", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lattice-pr-requeue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = "lattice-writer/lattice-web-ui";
  const base = "b".repeat(40);
  const env = {
    GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/heads/main", GITHUB_SHA: base,
    GITHUB_RUN_ID: "17", VERIFY_RESULT: "success", GITHUB_OUTPUT: join(directory, "output"),
  };
  const checks = [];
  const pull = {
    state: "open", head: { sha: head }, base: { ref: "main", repo: { full_name: repo } },
  };
  const api = (current = pull, currentBase = base) => async (path, options) => {
    if (path === "/git/ref/heads/main") return { object: { type: "commit", sha: currentBase } };
    if (path === "/pulls/2") return current;
    assert.equal(path, "/check-runs");
    assert.equal(options.method, "POST");
    checks.push(options.body);
  };

  await publish(api(), headRequest, env);
  assert.deepEqual(
    checks.map(({ name, head_sha, conclusion }) => [name, head_sha, conclusion]),
    [["Lattice CI passed", head, "success"]],
  );
  await assert.rejects(publish(api(), headRequest, { ...env, GITHUB_REF: "refs/tags/v0.4.0" }),
    /trusted main/);
  await plan(api(pull, head), headRequest, env);
  await publish(api(pull, head), headRequest, env);
  await publish(api({ ...pull, state: "closed" }, head), headRequest, env);
  await publish(api({ ...pull, head: { sha: base } }, head), headRequest, env);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "requeue=true\n");
  await publish(api({ ...pull, head: { sha: base } }), headRequest, env);
  await publish(api({ ...pull, base: { ...pull.base, repo: { full_name: "other/repo" } } }),
    headRequest, env);
  assert.equal(checks.length, 1);
  await publish(api(), headRequest, { ...env, VERIFY_RESULT: "skipped" });
  assert.equal(checks[1].conclusion, "failure");
});

test("GitHub API errors are bounded to status codes and prohibit redirects", async () => {
  const api = githubApi({ token: "fixture-token", repository: "sample/project",
    fetcher: async (url, init) => {
      assert.equal(url, "https://api.github.com/repos/sample/project/status");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer fixture-token");
      return new Response("sensitive diagnostic", { status: 403 });
    } });
  await assert.rejects(api("/status"), /^Error: GitHub API returned HTTP 403\.$/);
});

test("review omits credentials, sensitive paths, binary files, and excessive excerpts", () => {
  const files = [
    proposal, { filename: "screenshots/example.png" }, { filename: "plugin/.env.sample", patch },
    { filename: "automation/dev-credentials.json", previous_filename: "automation/credentials.json", patch },
    { filename: "plugin/large.mjs", patch: "+a".repeat(5000) },
    { filename: "plugin/test.mjs", patch: patch + "\n+github_pat_" + "x".repeat(30) },
  ];
  assert.deepEqual(prepareReview(files, true), {
    excerpts: [{ path: proposal.filename, patch }],
    partial: true,
  });
});

test("review rejects unsupported locations and publishes findings against the exact submitted head", () => {
  const { excerpts } = prepareReview([proposal], true);
  const finding = { path: proposal.filename, line: 42, severity: "medium",
    summary: "@someone Input normalization changes the configured path. https://example.test/" };
  for (const wrong of [{ ...finding, line: 40 }, { ...finding, path: "plugin/other.mjs" }]) {
    assert.throws(() => validateFindings([wrong], excerpts), /did not reference/);
  }
  const findings = validateFindings([finding], excerpts);
  const review = formatReview({ head, repository: "sample/project", excerpts, partial: true, findings });
  assert.ok(review.includes(`https://github.com/sample/project/blob/${head}/plugin/main.mjs#L42`));
  assert.ok(review.includes("Some changes were outside the review scope"));
  assert.ok(!review.includes("@someone"));
  assert.ok(!review.includes("https://example.test/"));
  assert.ok(formatReview({ head, unavailable: "AI review unavailable." }).includes("AI review unavailable."));
});
