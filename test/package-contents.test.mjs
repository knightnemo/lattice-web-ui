import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginFiles = ["LICENSE", "README.md", "lattice-plugin.mjs", "lattice-plugin.toml", "main.mjs"];
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packPlugin = join(repoRoot, "scripts/pack-plugin.mjs");

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

test("the Linux host kit ships the gateway, lattice-host and the pinned releases, and nothing local", (t) => {
  const directory = scratch(t);
  const repo = join(directory, "repo");
  const files = [
    "scripts/package.sh", "scripts/pack-plugin.mjs", "automation/release-package.mjs",
    "host/lattice-host.py", "host/lattice-releases.json", "host/README.md", "host/examples/Caddyfile",
    "gateway/assets/vendor/LICENSE-inter",
    ...pluginFiles.map((name) => `plugin/${name}`),
  ];
  for (const file of files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(repoRoot, file), join(repo, file));
  }
  put(repo, "host/local-notes.txt");
  put(repo, "host/__pycache__/lattice-host.cpython-312.pyc");
  const gateway = join(directory, "lattice-gateway");
  put(gateway, "", "#!/bin/sh\necho lattice-gateway 0.5.0\n", 0o755);
  const out = join(directory, "out");
  const version = run(process.execPath, [join(repo, "automation/release-package.mjs"), "version", join(repo, "plugin/lattice-plugin.toml")]).trim();
  const pack = () => run("bash", [join(repo, "scripts/package.sh"), out], { env: { ...process.env, LATTICE_GATEWAY_BINARY: gateway } });
  pack();

  const kit = `lattice-remote-host-${version}`;
  const archive = join(out, `${kit}-linux-x86_64.tar.gz`);
  const listed = run("tar", ["-tzf", archive]).trim().split("\n").filter((path) => !path.endsWith("/")).sort();
  assert.deepEqual(listed, [
    "LICENSE", "LICENSE-inter", "README.md", "bin/lattice-gateway", "examples/Caddyfile", "lattice-host", "lattice-releases.json", "release-version.txt",
  ].map((name) => `${kit}/${name}`));
  assert.equal(run("tar", ["-xOzf", archive, `${kit}/release-version.txt`]).trim(), version);
  assert.equal(run("tar", ["-xOzf", archive, `${kit}/lattice-host`]), readFileSync(join(repo, "host/lattice-host.py"), "utf8"));
  const modes = run("tar", ["-tvzf", archive]);
  assert.match(modes, /^-rwxr-xr-x .* lattice-remote-host-[\d.]+\/bin\/lattice-gateway$/m);
  assert.doesNotMatch(modes, /siqiao|runner/, "archive entries carry no local user names");
  run("sha256sum", ["--check", "SHA256SUMS"], { cwd: out });

  rmSync(gateway);
  symlinkSync(join(repo, "host/README.md"), gateway);
  assert.throws(pack, /Expected a regular lattice-gateway binary/);
});
