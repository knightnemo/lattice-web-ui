import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const versionPattern = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const versionRegex = new RegExp(`^${versionPattern}$`);
const tagRegex = new RegExp(`^v(${versionPattern})$`);
const commitRegex = /^[a-f0-9]{40}$/;
const digestRegex = /^[a-f0-9]{64}$/;

export function packageVersion(manifest) {
  const matches = [...manifest.matchAll(/^\s*version\s*=\s*"([^"]+)"\s*$/gm)];
  if (matches.length !== 1 || !versionRegex.test(matches[0][1])) {
    throw new Error("Plugin manifest must contain one X.Y.Z version.");
  }
  return matches[0][1];
}

export function releaseNames(tag) {
  const version = tagRegex.exec(tag)?.[1];
  if (!version) throw new Error("Release tags must use vX.Y.Z.");
  return {
    packageFiles: [`remote-workspace-${version}.zip`, `lattice-remote-host-${version}-linux-x86_64.tar.gz`],
    checksums: `SHA256SUMS-${tag}.txt`,
    manifest: `release-${tag}.json`,
  };
}

/** The Lattice releases the host kit is pinned to, recorded in the release manifest. */
export function pinnedLattice(text) {
  const manifest = JSON.parse(text);
  const releases = Array.isArray(manifest.releases) ? manifest.releases : [];
  if (!releases.length || !releases.some((entry) => entry.version === manifest.default) ||
      releases.some((entry) => !versionRegex.test(entry.version ?? "") || !digestRegex.test(entry.sha256 ?? "") ||
        !/^https:\/\/github\.com\/leo1oel\/lattice\/releases\/download\//.test(entry.url ?? ""))) {
    throw new Error("host/lattice-releases.json must pin Lattice releases by version, GitHub release URL and SHA-256.");
  }
  return { default: manifest.default, releases: releases.map(({ version, sha256 }) => ({ version, sha256 })) };
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function verifiedChecksums(directory, checksumName, packageFiles) {
  const checksums = await readFile(join(directory, checksumName), "utf8");
  const expected = await Promise.all(packageFiles.map(async (name) => `${await sha256(join(directory, name))}  ${name}\n`));
  if (checksums !== expected.join("")) throw new Error("Package checksum verification failed.");
  return Object.fromEntries(expected.map((line, i) => [packageFiles[i], line.slice(0, 64)]));
}

export async function sealRelease(directory, tag, commit, latticeManifest = new URL("../host/lattice-releases.json", import.meta.url)) {
  if (!commitRegex.test(commit)) throw new Error("Release commit must be a full Git SHA.");
  const lattice = pinnedLattice(await readFile(latticeManifest, "utf8"));
  const names = releaseNames(tag);
  const assets = await verifiedChecksums(directory, "SHA256SUMS", names.packageFiles);
  await rename(join(directory, "SHA256SUMS"), join(directory, names.checksums));
  assets[names.checksums] = await sha256(join(directory, names.checksums));
  const metadata = {
    schema: 2,
    tag,
    commit,
    lattice,
    assets,
  };
  await writeFile(join(directory, names.manifest), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  return sha256(join(directory, names.manifest));
}

export async function verifyRelease(directory, tag, commit, expectedDigest) {
  const names = releaseNames(tag);
  const manifest = join(directory, names.manifest);
  if (expectedDigest !== undefined && (!digestRegex.test(expectedDigest) || expectedDigest !== await sha256(manifest))) {
    throw new Error("Release artifact does not match the build job's manifest.");
  }
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  if (metadata.schema !== 2 || metadata.tag !== tag || metadata.commit !== commit || !commitRegex.test(commit)) {
    throw new Error("Release manifest does not match the exact tag and commit.");
  }
  if (!versionRegex.test(metadata.lattice?.default ?? "")) throw new Error("The release manifest names no pinned Lattice release.");
  const assets = await verifiedChecksums(directory, names.checksums, names.packageFiles);
  assets[names.checksums] = await sha256(join(directory, names.checksums));
  if (Object.keys(metadata.assets ?? {}).length !== Object.keys(assets).length ||
      Object.entries(assets).some(([name, hash]) => metadata.assets[name] !== hash)) {
    throw new Error("Package hashes do not match the release manifest.");
  }
  return [...names.packageFiles, names.checksums, names.manifest];
}

async function run([operation, ...args]) {
  switch (operation) {
    case "version":
      console.log(packageVersion(await readFile(args[0], "utf8")));
      break;
    case "seal":
      console.log(await sealRelease(...args));
      break;
    case "verify":
      console.log((await verifyRelease(...args)).join("\n"));
      break;
    default:
      throw new Error("Use version, seal, or verify.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
