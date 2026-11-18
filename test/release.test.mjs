import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packageVersion, releaseNames, sealRelease, verifyRelease } from "../automation/release-package.mjs";

const tag = "v1.2.3";
const commit = "a".repeat(40);
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lattice-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = releaseNames(tag);
  let sums = "";
  for (const name of names.packageFiles) {
    const content = `fixture for ${name}`;
    await writeFile(join(directory, name), content);
    sums += `${sha256(content)}  ${name}\n`;
  }
  await writeFile(join(directory, "SHA256SUMS"), sums);
  return { directory, names };
}

test("takes a single numeric release version from the manifest", () => {
  assert.equal(packageVersion('schema = 1\nversion = "1.2.3"\n[[commands]]'), "1.2.3");
  assert.throws(() => packageVersion('version = "1.2.3-beta"'), /one X.Y.Z version/);
  assert.throws(() => packageVersion('version = "1.2.3"\nversion = "2.0.0"'), /one X.Y.Z version/);
  assert.throws(() => releaseNames("v1.2.03"), /vX.Y.Z/);
  assert.throws(() => releaseNames("../../main"), /vX.Y.Z/);
});

test("seals and verifies the same release artifact for publishing and promotion", async (t) => {
  const { directory, names } = await fixture(t);
  const manifestDigest = await sealRelease(directory, tag, commit);
  assert.match(manifestDigest, /^[a-f0-9]{64}$/);
  const verified = await verifyRelease(directory, tag, commit, manifestDigest);
  assert.deepEqual(verified, [...names.packageFiles, names.checksums, names.manifest]);
  await assert.rejects(verifyRelease(directory, tag, "b".repeat(40), manifestDigest), /exact tag and commit/);
  await assert.rejects(verifyRelease(directory, tag, commit, "b".repeat(64)), /build job's manifest/);
  await writeFile(join(directory, names.packageFiles[0]), "tampered");
  await assert.rejects(verifyRelease(directory, tag, commit, manifestDigest), /checksum verification/);
});

test("rejects unchecked or altered checksum contents", async (t) => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, "SHA256SUMS"), `${"b".repeat(64)}  ../unexpected\n`);
  await assert.rejects(sealRelease(directory, tag, commit), /checksum verification/);
});

test("only tags of the exact expected commit already on the default branch are releasable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lattice-release-git-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, DEFAULT_BRANCH: "main" };
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const script = fileURLToPath(new URL("../automation/release-target.sh", import.meta.url));
  const target = (...args) => spawnSync("bash", [script, ...args], { cwd: directory, env, encoding: "utf8" });

  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("commit", "-q", "--allow-empty", "-m", "default branch");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("tag", "v1.2.3", base);
  assert.equal(target("v1.2.3", base).stdout.trim(), base);

  git("commit", "-q", "--allow-empty", "-m", "unmerged branch");
  const unmerged = git("rev-parse", "HEAD");
  git("tag", "v1.2.4", unmerged);
  assert.match(target("v1.2.3", unmerged).stderr, /tag changed/);
  assert.match(target("v1.2.4", unmerged).stderr, /already on the default branch/);
});
