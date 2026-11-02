import { build } from "esbuild";
import { inject } from "postject";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
const platform = process.platform;
if (!["darwin", "win32"].includes(platform))
  throw new Error("Build adapter on macOS or Windows.");
if (process.versions.node.split(".")[0] !== "22")
  throw new Error("SEA build requires Node 22.");
const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: exit ${result.status}`);
};
const temp = path.resolve(".build");
const stage = path.join(temp, "adapter");
await rm(temp, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["bridge/index.mjs"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(temp, "bridge.cjs"),
});
await writeFile(
  path.join(temp, "sea.json"),
  JSON.stringify({
    main: path.join(temp, "bridge.cjs"),
    output: path.join(temp, "sea.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
run(process.execPath, [
  "--experimental-sea-config",
  path.join(temp, "sea.json"),
]);
const exe = path.join(
  stage,
  platform === "win32" ? "lumi-browser-adapter.exe" : "lumi-browser-adapter",
);
await copyFile(process.execPath, exe);
if (platform === "darwin") run("codesign", ["--remove-signature", exe]);
// Node documents Windows signature removal as optional; postject may warn.
// No Windows signing credentials are used; the adapter is an unsigned developer build.
await inject(
  exe,
  "NODE_SEA_BLOB",
  await readFile(path.join(temp, "sea.blob")),
  {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  },
);
if (platform === "darwin") {
  run("codesign", ["--sign", "-", exe]); // Ad-hoc only; not Developer ID or notarization.
  await chmod(exe, 0o755);
}
for (const name of platform === "darwin"
  ? ["install-macos.sh", "uninstall-macos.sh"]
  : ["install-windows.ps1", "uninstall-windows.ps1"]) {
  const dest = path.join(stage, name);
  await copyFile(path.join("scripts", name), dest);
  if (platform === "darwin") await chmod(dest, 0o755);
}
// Verify the embedded entrypoint without starting a broker or writing credentials.
const smoke = spawnSync(exe, ["--help"], { encoding: "utf8", timeout: 10000 });
if (smoke.error || smoke.status !== 0 || !/Lumi/i.test(smoke.stdout || "")) {
  throw new Error(
    `SEA --help smoke failed: ${smoke.error || smoke.stderr || smoke.stdout}`,
  );
}
console.log(smoke.stdout.trim());
const zip = path.resolve(
  "dist",
  `lumi-browser-adapter-${platform}-${process.arch}.zip`,
);
await rm(zip, { force: true });
if (platform === "darwin")
  run("/usr/bin/ditto", ["-c", "-k", "--norsrc", stage, zip]);
else {
  const q = (s) => `'${s.replaceAll("'", "''")}'`;
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path (${q(stage)} + '\\*') -DestinationPath ${q(zip)}`,
  ]);
}
const hash = createHash("sha256")
  .update(await readFile(zip))
  .digest("hex");
await writeFile(`${zip}.sha256`, `${hash}  ${path.basename(zip)}\n`);
console.log(`Built ${zip}\nSHA-256 ${hash}`);
