import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin, PluginError } from "./lattice-plugin.mjs";

function workspaceAddress(input) {
  const address = typeof input === "string" ? input.trim() : "";
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new PluginError("Enter the full HTTPS workspace address.");
  }
  if (
    !/^https:\/\//i.test(address) ||
    /[\s?#\\]/u.test(address) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new PluginError("Use the HTTPS workspace origin with no path, credentials, or login token.");
  }
  return url.origin;
}

function addressFile() {
  const data = process.env.LATTICE_PLUGIN_DATA_DIR;
  if (!data) throw new PluginError("Lattice did not provide plugin storage.");
  return join(data, "workspace-address.txt");
}

async function saveAddress(origin, signal) {
  const path = addressFile();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${origin}\n`, { flag: "wx", mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(temporary, path);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PluginError("Could not save the workspace address.");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readAddress() {
  let address;
  try {
    address = await readFile(addressFile(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new PluginError("Run Remote Workspace: Set workspace address… first.");
    }
    throw new PluginError("Could not read the workspace address.");
  }
  return workspaceAddress(address);
}

function workspaceResult(origin, summary) {
  return {
    kind: "items",
    summary,
    items: [{
      id: "remote-workspace",
      title: "Open remote workspace",
      subtitle: origin,
      actions: [{ type: "openUrl", url: `${origin}/` }],
    }],
  };
}

definePlugin({
  commands: {
    async configure({ input, signal }) {
      const origin = workspaceAddress(input);
      await saveAddress(origin, signal);
      return workspaceResult(origin, "Workspace address saved");
    },
    async open() {
      return workspaceResult(await readAddress(), "Remote workspace");
    },
  },
});
