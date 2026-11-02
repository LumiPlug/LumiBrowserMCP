import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "./broker.mjs";
import { writeFrame } from "./protocol.mjs";
const execute = promisify(execFile);
export const HOST_NAME = "com.lumiplug.browser";
export function registrationPaths(platform, home, localAppData) {
  if (platform === "darwin") return { manifest: path.posix.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts", `${HOST_NAME}.json`), executable: path.posix.join(home, "Library/Application Support/LumiBrowserMCP/lumi-browser-adapter") };
  if (platform === "win32") {
    if (!localAppData) throw Error("LOCALAPPDATA is unavailable");
    const dir = path.win32.join(localAppData, "LumiBrowserMCP");
    return { manifest: path.win32.join(dir, `${HOST_NAME}.json`), executable: path.win32.join(dir, "lumi-browser-adapter.exe"), registry: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}` };
  }
  throw Error("Packaged native registration diagnostics support macOS and Windows only");
}
export function samePath(a, b, platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (typeof a !== "string" || !p.isAbsolute(a)) return false;
  return platform === "win32" ? p.normalize(a).toLowerCase() === p.normalize(b).toLowerCase() : p.normalize(a) === p.normalize(b);
}
export function validateManifest(manifest, expected, extensionId, platform) {
  if (manifest?.name !== HOST_NAME || manifest.type !== "stdio") throw Error("Native manifest name/type is incorrect");
  if (!samePath(manifest.path, expected.executable, platform)) throw Error("Native manifest points to an unexpected adapter path");
  if (!Array.isArray(manifest.allowed_origins) || manifest.allowed_origins.length !== 1 || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(manifest.allowed_origins[0])) throw Error("Native manifest must allow exactly one concrete Chrome extension origin");
  if (extensionId && manifest.allowed_origins[0] !== `chrome-extension://${extensionId}/`) throw Error("Native manifest allowed origin does not match --extension-id");
  return { extensionId: manifest.allowed_origins[0].split("/")[2] };
}
// Read-only: do not use endpoint(), which creates runtime credentials.
export function existingEndpoint({ platform = process.platform, home = os.homedir(), username = os.userInfo().username, fsApi = fs, uid = process.getuid?.() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix, dir = p.join(home, ".lumi-browser-mcp"), file = p.join(dir, "ipc-token");
  const d = fsApi.lstatSync(dir), f = fsApi.lstatSync(file);
  if (!d.isDirectory() || d.isSymbolicLink() || !f.isFile() || f.isSymbolicLink()) throw Error("Unsafe existing IPC directory/token");
  if (platform !== "win32" && (d.uid !== uid || f.uid !== uid || d.mode & 0o077 || f.mode & 0o077)) throw Error("Existing IPC directory/token is not owner-only");
  const token = fsApi.readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Existing IPC token is invalid");
  const user = createHash("sha256").update(username + "\0" + home).digest("hex").slice(0, 24);
  return { token, address: platform === "win32" ? `\\\\.\\pipe\\lumi-browser-mcp-${user}` : p.join(dir, "broker.sock") };
}
export async function probeExistingBroker(options = {}) {
  const { address, token } = existingEndpoint(options), { socket, frames } = await connect(address, "doctor", token);
  try {
    return await new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { cleanup(); reject(Error("Existing broker did not answer diagnostic query")); }, 1500);
      const cleanup = () => {
        clearTimeout(timer);
        frames.removeListener("data", onData);
        socket.removeListener("close", onClose);
      };
      const onClose = () => {
        cleanup();
        reject(Error("Existing broker disconnected during diagnosis"));
      };
      const onData = (m) => {
        if (m.type !== "status" || m.id !== id) return;
        cleanup();
        resolve(m);
      };
      frames.on("data", onData);
      socket.once("close", onClose);
      try {
        writeFrame(socket, { type: "status", id, expectedOrigin: options.expectedOrigin });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  } finally {
    socket.destroy();
  }
}
export async function runDoctor({ extensionId, platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA, fsApi = fs, registryQuery, launchProbe, brokerProbe } = {}) {
  const checks = [], add = (id, status, message, details) => checks.push({ id, status, message, ...details ? { details } : {} });
  let expected, manifest;
  add("runtime", "pass", "The adapter diagnostic entry point started successfully.");
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) {
    add("extension_id", "fail", "--extension-id must contain exactly 32 letters a\u2013p.");
    return { ready: false, checks };
  }
  try {
    expected = registrationPaths(platform, home, localAppData);
  } catch (e) {
    add("platform", "fail", e.message);
    return { ready: false, checks };
  }
  if (platform === "win32") {
    try {
      const registered = registryQuery ? await registryQuery(expected.registry) : (await execute("reg.exe", ["query", expected.registry, "/ve"], { windowsHide: true, timeout: 3e3, maxBuffer: 65536 })).stdout.match(/REG_SZ\s+(.+)\s*$/m)?.[1]?.trim();
      if (!samePath(registered, expected.manifest, platform)) throw Error("HKCU native-host registration does not point to the expected manifest");
      add("registration", "pass", "Current-user Chrome native-host registry entry is correct.");
    } catch (e) {
      add("registration", "fail", e.message);
    }
  }
  try {
    const st = fsApi.lstatSync(expected.manifest);
    if (!st.isFile() || st.isSymbolicLink()) throw Error("Native manifest must be a regular non-symlink file");
    manifest = JSON.parse(fsApi.readFileSync(expected.manifest, "utf8"));
    const validated = validateManifest(manifest, expected, extensionId, platform);
    add("manifest", "pass", "Native host path and exact Chrome origin are configured.", validated);
  } catch (e) {
    manifest = null;
    add("manifest", "fail", e.message);
  }
  if (manifest) try {
    const st = fsApi.lstatSync(expected.executable);
    if (!st.isFile() || st.isSymbolicLink()) throw Error("Registered adapter must be a regular non-symlink file");
    const output = launchProbe ? await launchProbe(expected.executable) : (await execute(expected.executable, ["--help"], { windowsHide: true, timeout: 3e3, maxBuffer: 65536 })).stdout;
    if (!/Lumi Browser MCP/.test(output)) throw Error("Registered executable did not return the expected adapter help banner");
    add("registered_adapter", "pass", "The registered adapter launches successfully (--help only).");
  } catch (e) {
    add("registered_adapter", "fail", e.message);
  }
  else add("registered_adapter", "unknown", "Cannot probe an invalid or missing native registration.");
  try {
    const expectedOrigin = manifest?.allowed_origins?.[0] || (extensionId ? `chrome-extension://${extensionId}/` : undefined);
    const status = await (brokerProbe ? brokerProbe({expectedOrigin}) : probeExistingBroker({ platform, home, expectedOrigin }));
    if (![status.nativeHosts,status.sessionPublishers,status.activeSessions].every(n => Number.isInteger(n) && n >= 0)) throw Error("Broker returned an invalid diagnostic response");
    if (!expectedOrigin || !status.originMatched) add("extension_connection", "fail", "Live connection origin could not be correlated with the registered extension ID.");
    else if (status.nativeHosts < 1 || status.sessionPublishers < 1) add("extension_connection", "fail", "No connected native host has received an extension session publication. Start the Agent, then authorize a tab in Lumi.");
    else add("extension_connection", "pass", "A native host with the registered Chrome argv origin received an extension session publication (trusted same-user IPC, not hostile-process authentication).", { nativeHosts: status.nativeHosts });
    add("authorization", status.activeSessions > 0 ? "pass" : "fail", status.activeSessions > 0 ? "At least one explicitly authorized browser session is active." : "No active authorized browser session. Authorize a tab in the Lumi popup.", { activeSessions: status.activeSessions });
  } catch (e) {
    add("extension_connection", "fail", `No verified live extension connection: ${e.message}`);
    add("authorization", "unknown", "No live broker evidence; browser authorization was not verified.");
  }
  return { ready: checks.every((c) => c.status === "pass"), checks };
}
export async function doctorCLI(args = process.argv.slice(2)) {
  const position = args.indexOf("--extension-id");
  if (position >= 0 && (!args[position + 1] || args[position + 1].startsWith("--"))) {
    process.stderr.write("--extension-id requires a value\n");
    return 2;
  }
  const report = await runDoctor({ extensionId: position >= 0 ? args[position + 1] : void 0 });
  if (args.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    process.stdout.write(`Lumi diagnostic: ${report.ready ? "READY" : "NOT READY"}
`);
    for (const check of report.checks) process.stdout.write(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}
`);
  }
  return report.ready ? 0 : 1;
}
