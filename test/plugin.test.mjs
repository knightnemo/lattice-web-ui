import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../plugin/main.mjs", import.meta.url));
const origin = "https://remote.example.ts.net:8443";

async function command(data, name, input) {
  const processHandle = spawn(process.execPath, [main], {
    env: { ...process.env, LATTICE_PLUGIN_DATA_DIR: data },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exit = new Promise((resolve, reject) => {
    processHandle.once("error", reject);
    processHandle.once("exit", resolve);
  });
  const replies = createInterface({ input: processHandle.stdout });
  try {
    const send = (id, method, params) => {
      processHandle.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    };
    send(1, "initialize", { hostApiLevel: 1, hostApiCompat: 1 });
    const lines = replies[Symbol.asyncIterator]();
    assert.deepEqual(JSON.parse((await lines.next()).value), {
      jsonrpc: "2.0", id: 1, result: { apiLevel: 1 },
    });
    send(2, "command/run", { command: name, input, context: { project: { name: "Fixture" } } });
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.id, 2);
    return reply;
  } finally {
    processHandle.stdin.end();
    replies.close();
    assert.equal(await exit, 0);
  }
}

async function fixture(t) {
  const data = await mkdtemp(join(tmpdir(), "lattice-remote-plugin-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  return data;
}

test("returns an openUrl action and remembers the address across plugin processes", { timeout: 10000 }, async (t) => {
  const data = await fixture(t);
  const first = await command(data, "configure", " " + origin + "/ ");
  const second = await command(data, "open");
  const expected = { type: "openUrl", url: origin + "/" };
  assert.deepEqual(first.result.items[0].actions, [expected]);
  assert.deepEqual(second.result.items[0].actions, [expected]);
  assert.equal((await stat(join(data, "workspace-address.txt"))).mode & 0o777, 0o600);
});

test("rejects unconfigured, insecure, and credential-bearing links without overwriting the saved address", { timeout: 10000 }, async (t) => {
  const data = await fixture(t);
  assert.match((await command(data, "open")).error.message, /Set workspace address/);
  await command(data, "configure", origin);
  for (const input of [
    "http://remote.example.ts.net/",
    "https://user:password@remote.example.ts.net/",
    "https://remote.example.ts.net/?token=private",
    "https://remote.example.ts.net/#private",
    "https://remote.examp\nle.ts.net/",
    "https://remote.example.ts.net/private",
  ]) {
    const reply = await command(data, "configure", input);
    assert.equal(reply.error.code, -32000);
    assert.ok(!reply.error.message.includes("password"));
    assert.ok(!reply.error.message.includes(input));
  }
  const location = join(data, "workspace-address.txt");
  assert.equal(await readFile(location, "utf8"), origin + "\n");
  await writeFile(location, "file:///etc/passwd");
  assert.equal((await command(data, "open")).error.code, -32000);
});
