#!/usr/bin/env node
// Pack the Lattice-web-ui launcher for Settings › Plugins › Install from URL.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [folder, out] = process.argv.slice(2);
if (!folder || !out) {
  console.error("usage: pack-plugin.mjs <plugin folder> <out.zip>");
  process.exit(2);
}
const target = resolve(out);
const files = ["LICENSE", "README.md", "lattice-plugin.mjs", "lattice-plugin.toml", "main.mjs"];
for (const file of files) {
  if (!lstatSync(join(folder, file)).isFile()) throw new Error(`Expected regular plugin file: ${file}`);
}
mkdirSync(dirname(target), { recursive: true });
const staging = mkdtempSync(join(dirname(target), ".lattice-plugin-"));
try {
  const archive = join(staging, "plugin.zip");
  execFileSync("zip", ["-q", "-X", "-MM", archive, ...files], { cwd: resolve(folder) });
  renameSync(archive, target);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");
console.log(`${target}\nsha256 ${sha256}`);
