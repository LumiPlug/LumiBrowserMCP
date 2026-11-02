import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (/\.(mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ["--check", file], {
        stdio: "inherit",
      });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const dir of ["bridge", "extension", "scripts", "tests"]) await check(dir);
