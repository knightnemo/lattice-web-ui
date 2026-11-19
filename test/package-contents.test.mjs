import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginFiles = ["LICENSE", "lattice-plugin.mjs", "lattice-plugin.toml", "main.mjs"];
const deploymentFiles = [
  "account-gateway/Caddyfile", "account-gateway/README.md", "account-gateway/oauth2-proxy.toml",
  "device-pairing/Caddyfile", "device-pairing/README.md",
  "tailscale-owner/README.md", "tailscale-owner/gateway.py", "tailscale-owner/index.html",
  "tailscale-owner/owner.css", "tailscale-owner/owner.js",
];
const packPlugin = fileURLToPath(new URL("../scripts/pack-plugin.mjs", import.meta.url));

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "lattice-pack-contents-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function put(directory, file, contents = file, mode = 0o644) {
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

test("the plugin ZIP carries only regular launcher files and preserves the last ZIP on failure", (t) => {
  const directory = scratch(t);
  const folder = join(directory, "plugin");
  for (const file of [...pluginFiles, "local-notes.txt", "cache/temporary.txt"]) put(folder, file);
  const archive = join(directory, "launcher.zip");
  const pack = () => run(process.execPath, [packPlugin, folder, archive]);
  pack();
  assert.deepEqual(run("unzip", ["-Z1", archive]).trim().split("\n").sort(), pluginFiles);
  assert.equal(run("unzip", ["-p", archive, "main.mjs"]), "main.mjs");

  const good = readFileSync(archive);
  rmSync(join(folder, "main.mjs"));
  symlinkSync("local-notes.txt", join(folder, "main.mjs"));
  assert.throws(pack, /Expected regular plugin file/);
  assert.deepEqual(readFileSync(archive), good);
});

test("both source and Linux host kits ship only the declared deployment templates", (t) => {
  const directory = scratch(t);
  const repo = join(directory, "launcher");
  const companion = join(directory, "companion");
  const dist = join(directory, "out");
  const version = "1.2.3";
  for (const file of [
    ...deploymentFiles, "README.md", "docs/releases.md", "docs/assets/lattice-web-ui.png",
    "test/account-gateway.test.mjs", ...pluginFiles.map((name) => `plugin/${name}`),
    "account-gateway/local.conf", "device-pairing/.local", "tailscale-owner/__pycache__/local.pyc",
  ]) put(repo, file);
  put(repo, "plugin/lattice-plugin.toml", `version = "${version}"\n`);
  for (const file of [
    "scripts/build-linux.sh", "scripts/copy-deployment-files.sh", "scripts/package.sh", "scripts/pack-plugin.mjs",
    "automation/release-package.mjs", "automation/companion-source.mjs",
  ]) {
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), join(repo, file));
  }
  for (const file of [
    "server/Cargo.lock", "licenses/notice", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md",
    "scripts/install-headless-service.py", "scripts/prepare-headless-agent.mjs", "scripts/patch-headless-agent.mjs",
    "scripts/synara-runtime.json", "docs/headless-server.md", "docs/headless-agent.md", "docs/private-headless-deployment.md",
  ]) put(companion, file);
  const git = (...args) => run("git", ["-C", companion, ...args]).trim();
  git("init", "-q");
  git("add", ".");
  const tree = git("write-tree");
  const commit = git("-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false",
    "commit-tree", tree, "-m", "fixture");
  put(repo, "automation/release-source.json", JSON.stringify({
    snapshotTag: "companion/v1.2.3", originalCommit: commit, snapshotCommit: commit, tree,
  }));
  run("bash", [join(repo, "scripts/package.sh"), companion, dist]);
  run("shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: dist });

  const sourceKit = `lattice-remote-source-${version}`;
  const sourceArchive = join(dist, `${sourceKit}.tar.gz`);
  function checkTemplates(archive, prefix, caddyfile) {
    const entries = run("tar", ["-tzf", archive]).trim().split("\n")
      .map((path) => path.slice(prefix.length + 1))
      .filter((path) => /^(account-gateway|device-pairing|tailscale-owner)\//.test(path) && !path.endsWith("/"));
    assert.deepEqual(entries.sort(), deploymentFiles);
    assert.equal(run("tar", ["-xOf", archive, `${prefix}/account-gateway/Caddyfile`]), caddyfile);
  }
  checkTemplates(sourceArchive, sourceKit, "account-gateway/Caddyfile");
  run("tar", ["-xzf", sourceArchive, "-C", directory]);
  const extracted = join(directory, sourceKit);
  put(extracted, "account-gateway/Caddyfile", "locally edited Caddyfile");
  put(extracted, "account-gateway/host-local.conf");
  put(extracted, "device-pairing/.env");
  put(extracted, "tailscale-owner/local.log");

  // Stub compilation so the portable test exercises the standalone host packager on macOS and Linux.
  const bin = join(directory, "bin");
  put(bin, "uname", "#!/bin/sh\necho Linux\n", 0o755);
  put(bin, "pnpm", "#!/bin/sh\nmkdir -p dist && touch dist/index.html\n", 0o755);
  put(bin, "cargo", '#!/bin/sh\nmkdir -p "$CARGO_TARGET_DIR/release" && touch "$CARGO_TARGET_DIR/release/lattice-server"\n', 0o755);
  const archive = join(directory, "host.tar.gz");
  const build = () => run("bash", [join(extracted, "build-linux.sh"), join(extracted, "source"), archive], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  build();
  checkTemplates(archive, "lattice-remote-host", "locally edited Caddyfile");

  rmSync(join(extracted, "device-pairing/Caddyfile"));
  symlinkSync(".env", join(extracted, "device-pairing/Caddyfile"));
  assert.throws(build, /Expected regular deployment file/);
});
