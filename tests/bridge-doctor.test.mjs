import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runDoctor, registrationPaths, validateManifest, existingEndpoint } from "../bridge/doctor.mjs";
const id = "abcdefghijklmnopabcdefghijklmnop";
function fixture(platform = "darwin") {
  const home = platform === "win32" ? "C:\\Users\\test" : "/Users/test", localAppData = "C:\\Users\\test\\AppData\\Local";
  const expected = registrationPaths(platform, home, localAppData);
  const manifest = { name: "com.lumiplug.browser", type: "stdio", path: expected.executable, allowed_origins: [`chrome-extension://${id}/`] };
  const options = {
    platform,
    home,
    localAppData,
    extensionId: id,
    fsApi: { lstatSync() {
      return { isFile: () => true, isSymbolicLink: () => false };
    }, readFileSync() {
      return JSON.stringify(manifest);
    } },
    registryQuery: async () => expected.manifest,
    launchProbe: async () => "Lumi Browser MCP adapter",
    brokerProbe: async () => ({ originMatched: true, nativeHosts: 1, sessionPublishers: 1, sessions: 1, activeSessions: 1 })
  };
  return { options, manifest, expected };
}
test("doctor validates exact mac and Windows user registration paths", () => {
  for (const platform of ["darwin", "win32"]) {
    const { manifest, expected } = fixture(platform);
    assert.equal(validateManifest(manifest, expected, id, platform).extensionId, id);
    assert.throws(() => validateManifest({ ...manifest, path: "/tmp/other" }, expected, id, platform), /unexpected/);
    assert.throws(() => validateManifest({ ...manifest, allowed_origins: ["chrome-extension://*/"] }, expected, id, platform), /concrete/);
    assert.throws(() => validateManifest(manifest, expected, "a".repeat(32), platform), /does not match/);
  }
});
test("doctor ready requires registration, executable and live authorized publication", async () => {
  for (const platform of ["darwin", "win32"]) {
    const { options: options2 } = fixture(platform);
    assert.equal((await runDoctor(options2)).ready, true);
  }
  const { options } = fixture();
  options.brokerProbe = async () => ({ originMatched: true, nativeHosts: 1, sessionPublishers: 0, sessions: 0, activeSessions: 0 });
  const result = await runDoctor(options);
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((c) => c.id === "extension_connection").status, "fail");
  options.brokerProbe = async () => ({ originMatched: true, nativeHosts: 1, sessionPublishers: 1, sessions: 0, activeSessions: 0 });
  const noConsent = await runDoctor(options);
  assert.equal(noConsent.ready, false);
  assert.equal(noConsent.checks.find((c) => c.id === "extension_connection").status, "pass");
  assert.equal(noConsent.checks.find((c) => c.id === "authorization").status, "fail");
});
test("doctor never invents connectivity when broker is absent", async () => {
  const { options } = fixture();
  options.brokerProbe = async () => {
    throw Error("ENOENT");
  };
  const result = await runDoctor(options);
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((c) => c.id === "extension_connection").status, "fail");
  assert.equal(result.checks.find((c) => c.id === "authorization").status, "unknown");
});
test("doctor invalid manifest is not executed, wrong Windows registry fails", async () => {
  const { options, manifest } = fixture("win32");
  manifest.allowed_origins.push("chrome-extension://" + "a".repeat(32) + "/");
  let launched = false;
  options.launchProbe = async () => {
    launched = true;
  };
  options.registryQuery = async () => "C:\\unrelated.json";
  const result = await runDoctor(options);
  assert.equal(result.ready, false);
  assert.equal(launched, false);
  assert.equal(result.checks.find((c) => c.id === "registration").status, "fail");
});
test("read-only endpoint lookup does not create missing directories or credentials", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-doctor-"));
  try {
    assert.throws(() => existingEndpoint({ platform: "darwin", home, username: "test" }), /ENOENT/);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("read-only endpoint rejects symlink token without reading it", () => {
  let reads = 0;
  assert.throws(() => existingEndpoint({ platform: "darwin", home: "/tmp/test", username: "test", fsApi: { lstatSync(p) {
    return { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => p.endsWith("ipc-token") };
  }, readFileSync() {
    reads++;
  } } }), /Unsafe/);
  assert.equal(reads, 0);
});
test("doctor CLI emits structured not-ready result on unsupported platform without setup", async () => {
  if (process.platform !== "linux") return;
  const child = spawn(process.execPath, [path.resolve("bridge/index.mjs"), "--doctor", "--json"]), output = [];
  child.stdout.on("data", (b) => output.push(b));
  assert.equal((await once(child, "exit"))[0], 1);
  const report = JSON.parse(Buffer.concat(output));
  assert.equal(report.ready, false);
  assert.equal(report.checks.find((c) => c.id === "platform").status, "fail");
});

test('doctor does not call unrelated or originless broker sessions ready', async () => {
  const {options}=fixture();
  let requested;
  options.brokerProbe=async ({expectedOrigin})=>{requested=expectedOrigin;return {originMatched:false,nativeHosts:1,sessionPublishers:1,activeSessions:1};};
  const report=await runDoctor(options);
  assert.equal(requested,`chrome-extension://${id}/`);
  assert.equal(report.ready,false);
  assert.equal(report.checks.find(c=>c.id==='extension_connection').status,'fail');
});
