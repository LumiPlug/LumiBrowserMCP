import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("portable extension ZIP is deterministic, root-loadable, and checksummed", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "lumi-zip-test-"));
  try {
    await cp(path.join(root, "extension"), path.join(temp, "extension"), {
      recursive: true,
    });
    const run = () => {
      const r = spawnSync(
        process.execPath,
        [path.join(root, "scripts/build.mjs")],
        { cwd: temp, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
    };
    run();
    const first = await readFile(
      path.join(temp, "dist/lumi-browser-extension.zip"),
    );
    run();
    assert.deepEqual(
      first,
      await readFile(path.join(temp, "dist/lumi-browser-extension.zip")),
    );
    const checksum = (
      await readFile(
        path.join(temp, "dist/lumi-browser-extension.zip.sha256"),
        "utf8",
      )
    ).split(" ")[0];
    assert.equal(checksum, createHash("sha256").update(first).digest("hex"));
    const entries = [];
    let offset = 0;
    while (first.readUInt32LE(offset) === 0x04034b50) {
      const size = first.readUInt32LE(offset + 18),
        n = first.readUInt16LE(offset + 26),
        extra = first.readUInt16LE(offset + 28);
      entries.push(first.subarray(offset + 30, offset + 30 + n).toString());
      offset += 30 + n + extra + size;
    }
    assert.ok(entries.includes("manifest.json"));
    assert.ok(entries.includes("background.js"));
    assert.ok(
      entries.every(
        (n) => !n.startsWith("/") && !n.includes("..") && !n.includes("\\"),
      ),
    );
    assert.equal(first.readUInt32LE(offset), 0x02014b50);
    assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
