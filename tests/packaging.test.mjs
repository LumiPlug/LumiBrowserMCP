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

test("published public key fixes the official extension identity without a private key", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "extension/manifest.json"), "utf8"),
  );
  const digest = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32);
  const id = [...digest]
    .map((n) => String.fromCharCode(97 + parseInt(n, 16)))
    .join("");
  assert.equal(id, "hfhigjgopbjmojflbhhnahpfpnmiaman");
  assert.ok(!manifest.key.includes("PRIVATE"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(!manifest.permissions.includes("management"));
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, [
    "http://*/*",
    "https://*/*",
  ]);
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(!manifest.permissions.includes("tabs"));
});

test("Lumi branding includes Chrome-sized application icons and bounded metadata", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "extension/manifest.json"), "utf8"),
  );
  assert.equal(manifest.name, "Lumi Browser — AI Browser Automation & MCP");
  assert.ok(manifest.name.length <= 75);
  assert.ok(manifest.description.length <= 132);
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(
      path.join(root, "extension", manifest.icons[size]),
    );
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    if (size !== 128)
      assert.equal(manifest.action.default_icon[size], manifest.icons[size]);
  }
});

test("build rejects missing Chrome popup resources before writing a ZIP", async () => {
  for (const missing of [
    "popup.html",
    "popup.css",
    "popup.js",
    "core.mjs",
    "page.js",
    "icons/icon32.png",
    "background.js",
  ]) {
    const temp = await mkdtemp(path.join(tmpdir(), "lumi-missing-resource-"));
    try {
      await cp(path.join(root, "extension"), path.join(temp, "extension"), {
        recursive: true,
      });
      await rm(path.join(temp, "extension", missing));
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/build.mjs")],
        { cwd: temp, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, missing);
      assert.match(result.stderr, /Missing or empty extension resource/);
      await assert.rejects(
        readFile(path.join(temp, "dist/lumi-browser-extension.zip")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});

test("resource validation catches case mismatches, empty files and traversal", async () => {
  const { validateExtension } =
    await import("../scripts/validate-extension.mjs");
  const entries = [
    {
      name: "manifest.json",
      data: Buffer.from(
        JSON.stringify({
          manifest_version: 3,
          action: { default_popup: "popup.html" },
          background: { service_worker: "background.js" },
        }),
      ),
    },
    {
      name: "popup.html",
      data: Buffer.from('<script src="popup.js"></script>'),
    },
    { name: "popup.js", data: Buffer.from('import "./core.mjs";') },
    { name: "core.mjs", data: Buffer.from("export const x = 1;") },
    { name: "background.js", data: Buffer.from("// worker") },
  ];
  assert.doesNotThrow(() => validateExtension(entries));
  assert.throws(
    () =>
      validateExtension(
        entries.map((e) =>
          e.name === "popup.html" ? { ...e, name: "Popup.html" } : e,
        ),
      ),
    /popup.html/,
  );
  assert.throws(
    () =>
      validateExtension(
        entries.map((e) =>
          e.name === "popup.js" ? { ...e, data: Buffer.alloc(0) } : e,
        ),
      ),
    /empty/,
  );
  assert.throws(
    () =>
      validateExtension(
        entries.map((e) =>
          e.name === "popup.html"
            ? {
                ...e,
                data: Buffer.from('<script src="../outside.js"></script>'),
              }
            : e,
        ),
      ),
    /outside.js/,
  );
});
