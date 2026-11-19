import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("host updates use stable releases and stage only verified source kits", () => {
  execFileSync("python3", ["-B", fileURLToPath(new URL("./host_update.py", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"],
  });
});
