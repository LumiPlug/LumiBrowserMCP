import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// Dependency-free, deterministic ZIP (stored entries, UTF-8 names, fixed timestamp).
// Chrome's unpacked loader consumes the extracted extension directory on every OS.
const root = path.resolve("extension");
const entries = [];
async function walk(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing symbolic link: ${file}`);
    if (entry.name.startsWith("."))
      throw new Error(`Unexpected hidden extension file: ${file}`);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile())
      entries.push({
        name: path.relative(root, file).split(path.sep).join("/"),
        data: await readFile(file),
      });
  }
}
await walk(root);
if (!entries.some((e) => e.name === "manifest.json"))
  throw new Error("extension/manifest.json is missing");
const manifest = JSON.parse(
  entries.find((e) => e.name === "manifest.json").data,
);
if (manifest.manifest_version !== 3)
  throw new Error("Only Manifest V3 is supported");
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const local = [],
  central = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name);
  const size = entry.data.length;
  if (size > 0xffffffff || offset > 0xffffffff || name.length > 0xffff)
    throw new Error("ZIP64 is not supported");
  const crc = crc32(entry.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(0x21, 12); // 1980-01-01, 00:00:00
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, entry.data);
  const index = Buffer.alloc(46);
  index.writeUInt32LE(0x02014b50, 0);
  index.writeUInt16LE(20, 4);
  index.writeUInt16LE(20, 6);
  index.writeUInt16LE(0x800, 8);
  index.writeUInt16LE(0x21, 14);
  index.writeUInt32LE(crc, 16);
  index.writeUInt32LE(size, 20);
  index.writeUInt32LE(size, 24);
  index.writeUInt16LE(name.length, 28);
  index.writeUInt32LE(offset, 42);
  central.push(index, name);
  offset += header.length + name.length + size;
}
if (entries.length > 0xffff || offset > 0xffffffff)
  throw new Error("ZIP64 is not supported");
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, directory, end]);
const name = "lumi-browser-extension.zip";
await mkdir("dist", { recursive: true });
await writeFile(path.join("dist", name), archive);
const checksum = createHash("sha256").update(archive).digest("hex");
await writeFile(path.join("dist", `${name}.sha256`), `${checksum}  ${name}\n`);
console.log(
  `Built dist/${name}: ${entries.length} files, ${archive.length} bytes\nSHA-256 ${checksum}`,
);
