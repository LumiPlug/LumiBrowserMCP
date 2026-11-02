import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ID = /^[a-p]{32}$/;
const hash = data => createHash('sha256').update(data).digest('hex');
async function exists(p) { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function regular(p) { const s = await fs.lstat(p); if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Expected regular non-symlink file: ${p}`); }
async function noLink(p) { if (await exists(p) && (await fs.lstat(p)).isSymbolicLink()) throw new Error(`Refusing symlink: ${p}`); }
export function binaryTarget(data) {
  if (data.length >= 32 && data.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = data.readUInt32LE(4);
    return { platform: 'darwin', arch: cpu === 0x1000007 ? 'x64' : cpu === 0x100000c ? 'arm64' : 'unknown' };
  }
  if (data.length >= 64 && data.toString('ascii', 0, 2) === 'MZ') {
    const pe = data.readUInt32LE(60);
    if (pe + 6 <= data.length && data.readUInt32LE(pe) === 0x4550) {
      const cpu = data.readUInt16LE(pe + 4);
      return { platform: 'win32', arch: cpu === 0x8664 ? 'x64' : cpu === 0xaa64 ? 'arm64' : 'unknown' };
    }
  }
  throw new Error('Adapter is not a supported Mach-O/PE executable');
}
export function parseSetupArgs(argv) {
  const out = { client: 'snippet', dryRun: true, doctor: false, uninstall: false };
  const names = { '--extension-id': 'extensionId', '--client': 'client', '--package-dir': 'packageDir', '--sha256': 'sha256', '--codex-path': 'codexPath', '--codex-home': 'codexHome' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--apply') out.dryRun = false;
    else if (arg === '--uninstall') out.uninstall = true;
    else if (arg === '--doctor') out.doctor = true;
    else if (names[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (Object.hasOwn(out, names[arg]) && names[arg] !== 'client') throw new Error(`Duplicate ${arg}`);
      out[names[arg]] = argv[++i];
    } else throw new Error(`Unknown setup argument: ${arg}`);
  }
  if (!ID.test(out.extensionId || '')) throw new Error('Supply --extension-id with exactly 32 lowercase letters a-p');
  if (!['snippet', 'codex'].includes(out.client)) throw new Error('--client must be snippet or codex');
  if (out.sha256 && !/^[0-9a-fA-F]{64}$/.test(out.sha256)) throw new Error('--sha256 must contain 64 hexadecimal characters');
  return out;
}
function matchesCodex(value, installed) {
  const tr = value.transport || value;
  return (!tr.type || tr.type === 'stdio') && tr.command === installed && JSON.stringify(tr.args || []) === '["--mcp"]' && (!tr.env || Object.keys(tr.env).length === 0) && (!tr.env_vars || tr.env_vars.length === 0) && !tr.cwd && value.enabled !== false;
}
function doctorResult(result) {
  let value;
  try { value = JSON.parse(result.stdout || '{}'); } catch { value = { error: 'Doctor returned invalid JSON' }; }
  if (!value || typeof value !== 'object') value = { error: 'Doctor returned invalid JSON' };
  value.ready = result.status === 0 && value.ready === true;
  return { readiness: value, exitCode: value.ready ? 0 : (result.status || 1) };
}
function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, ...options });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  return result;
}
export async function preflight(options, context = {}) {
  const platform = context.platform || process.platform;
  const arch = context.arch || process.arch;
  const home = context.home || os.homedir();
  const env = context.env || process.env;
  if (!['darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw new Error(`Unsupported setup target ${platform}-${arch}`);
  if (!ID.test(options.extensionId || '')) throw new Error('Invalid extension ID');
  const packageDir = path.resolve(options.packageDir || path.dirname(process.execPath));
  const filename = platform === 'win32' ? 'lumi-browser-adapter.exe' : 'lumi-browser-adapter';
  const source = path.join(packageDir, filename);
  await regular(source);
  const bytes = await fs.readFile(source);
  const actual = binaryTarget(bytes);
  if (actual.platform !== platform || actual.arch !== arch) throw new Error(`Adapter target ${actual.platform}-${actual.arch} does not match ${platform}-${arch}`);
  let expected = options.sha256;
  if (!expected) {
    const metadata = path.join(packageDir, 'setup-manifest.json');
    await regular(metadata);
    const m = JSON.parse(await fs.readFile(metadata, 'utf8'));
    if (m.platform !== platform || m.arch !== arch) throw new Error('Package metadata target mismatch');
    expected = m.sha256;
  }
  if (!/^[a-fA-F0-9]{64}$/.test(expected || '') || hash(bytes) !== expected.toLowerCase()) throw new Error('Adapter SHA-256 mismatch');
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.LOCALAPPDATA;
  if (!base || !path.isAbsolute(base)) throw new Error('User application-data directory must be absolute');
  const installDir = path.join(base, 'LumiBrowserMCP');
  const installed = path.join(installDir, filename);
  const manifest = platform === 'darwin' ? path.join(base, 'Google', 'Chrome', 'NativeMessagingHosts', 'com.lumiplug.browser.json') : path.join(installDir, 'com.lumiplug.browser.json');
  const marker = path.join(installDir, '.lumi-install-v1');
  const script = platform === 'darwin' ? 'install-macos.sh' : 'install-windows.ps1';
  await regular(path.join(packageDir, script));
  await regular(path.join(packageDir, platform === 'darwin' ? 'uninstall-macos.sh' : 'uninstall-windows.ps1'));
  for (const p of [installDir, installed, manifest, marker]) await noLink(p);
  if (await exists(installDir) && (!await exists(marker) || (await fs.readFile(marker, 'utf8')).trim() !== 'LumiBrowserMCP installer v1')) throw new Error('Existing installation is not owned by this installer');
  let current;
  if (await exists(manifest)) {
    if (!await exists(marker)) throw new Error('Native manifest has no installation ownership marker');
    current = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (current.path !== installed || current.name !== 'com.lumiplug.browser') throw new Error('Native manifest belongs to another installation');
  }
  const same = platform !== 'win32' && current?.type === 'stdio' && await exists(installed) && hash(await fs.readFile(installed)) === expected.toLowerCase() && current?.allowed_origins?.length === 1 && current.allowed_origins[0] === `chrome-extension://${options.extensionId}/`;
  return { platform, arch, packageDir, source, installed, manifest, marker, installDir, script, sha256: expected.toLowerCase(), same };
}
async function backup(files, directory) {
  const present = [];
  for (const file of files) if (await exists(file)) { await regular(file); present.push(file); }
  if (!present.length) return;
  await noLink(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await fs.mkdtemp(path.join(directory, 'before-'));
  for (const file of present) {
    const dest = path.join(folder, path.basename(file));
    await fs.copyFile(file, dest, 1);
    await fs.chmod(dest, 0o600);
  }
}
export async function runSetup(argv, context = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    (context.log || console.log)('Lumi setup: --extension-id ID [--client snippet|codex] [--apply|--dry-run] [--uninstall|--doctor] [--package-dir DIR] [--sha256 HASH] [--codex-path EXE] [--codex-home DIR]. Default: dry-run. SHA-256 verifies integrity, not publisher identity. Use only a trusted package.');
    return { exitCode: 0 };
  }
  const options = parseSetupArgs(argv);
  if (argv.includes('--dry-run') && argv.includes('--apply')) throw new Error('Choose --dry-run or --apply, not both');
  if (options.doctor && options.uninstall) throw new Error('Doctor and uninstall cannot be combined');
  const runner = context.runner || defaultRunner;
  const log = context.log || console.log;
  const env = context.env || process.env;
  const plan = await preflight(options, context);
  const snippet = { mcpServers: { 'lumi-browser': { command: plan.installed, args: ['--mcp'] } } };
  if (options.doctor) {
    if (argv.includes('--dry-run')) { log(JSON.stringify({ dryRun: true, doctor: [plan.source, '--doctor', '--extension-id', options.extensionId, '--json'] })); return { ready: false, dryRun: true }; }
    const result = runner(plan.source, ['--doctor', '--extension-id', options.extensionId, '--json']);
    if (result.stdout) log(result.stdout.trim());
    if (result.stderr) log(result.stderr.trim());
    const diagnosis = doctorResult(result);
    return { ready: diagnosis.readiness.ready, ...diagnosis };
  }
  if (options.dryRun) {
    log(JSON.stringify({ dryRun: true, platform: plan.platform, arch: plan.arch, sha256: plan.sha256, install: !options.uninstall && !plan.same, uninstall: options.uninstall, source: plan.source, destination: plan.installed, nativeManifest: plan.manifest, client: options.client, codexConfig: options.client === 'codex' ? path.join(path.resolve(options.codexHome || env.CODEX_HOME || path.join(context.home || os.homedir(), '.codex')), 'config.toml') : undefined, codexConflictCheck: options.client === 'codex' ? 'Deferred until --apply; no external process launched' : undefined, snippet }, null, 2));
    return { dryRun: true, snippet };
  }
  let codex, codexEnv, codexConfig, codexSame = false;
  if (options.client === 'codex') {
    codex = options.codexPath || 'codex';
    if (/\.(cmd|bat)$/i.test(codex)) throw new Error('Use the native Codex executable, not a cmd/bat wrapper');
    const codexHome = path.resolve(options.codexHome || env.CODEX_HOME || path.join(context.home || os.homedir(), '.codex'));
    await noLink(codexHome);
    codexConfig = path.join(codexHome, 'config.toml');
    await noLink(codexConfig);
    codexEnv = { ...env, CODEX_HOME: codexHome };
    const probe = runner(codex, ['mcp', 'get', 'lumi-browser', '--json'], { env: codexEnv });
    if (probe.status === 0) {
      const existing = JSON.parse(probe.stdout);
      codexSame = matchesCodex(existing, plan.installed);
      if (!codexSame) throw new Error('Codex lumi-browser entry already exists with different settings; refusing overwrite');
    } else if (!/No MCP server named|MCP server.*not found/i.test(probe.stderr || '')) throw new Error('Could not safely inspect Codex entry; no changes made');
  }
  // Recheck the named entry immediately before mutations; never overwrite a newly changed entry.
  if (options.client === 'codex') {
    const check = runner(codex, ['mcp', 'get', 'lumi-browser', '--json'], { env: codexEnv });
    if (codexSame) {
      if (check.status !== 0) throw new Error('Codex entry changed during setup; retry');
      const value = JSON.parse(check.stdout);
      if (!matchesCodex(value, plan.installed)) throw new Error('Codex entry changed during setup; refusing mutation');
    } else if (check.status === 0 || !/No MCP server named|MCP server.*not found/i.test(check.stderr || '')) throw new Error('Codex entry changed during setup; refusing mutation');
  }
  if (options.uninstall) {
    if (options.client === 'codex' && codexSame) {
      await backup([codexConfig], path.join(path.dirname(codexConfig), 'lumi-setup-backups'));
      const removed = runner(codex, ['mcp', 'remove', 'lumi-browser'], { env: codexEnv });
      if (removed.status !== 0) throw new Error('Codex removal failed; native registration was retained');
      const check = runner(codex, ['mcp', 'get', 'lumi-browser', '--json'], { env: codexEnv });
      if (check.status === 0 || !/No MCP server named|MCP server.*not found/i.test(check.stderr || '')) throw new Error('Could not verify Codex removal; native registration was retained');
    }
    await backup([plan.installed, plan.manifest, plan.marker], path.join(path.dirname(plan.installDir), 'LumiBrowserMCP-setup-backups'));
    const script = path.join(plan.packageDir, plan.platform === 'darwin' ? 'uninstall-macos.sh' : 'uninstall-windows.ps1');
    const removed = !await exists(plan.marker) ? { status: 0 } : plan.platform === 'darwin' ? runner('/bin/bash', [script]) : runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script]);
    if (removed.status !== 0) throw new Error(`Native unregister failed: ${removed.stderr || removed.stdout}`);
    log(JSON.stringify({ uninstalled: true, backupsRetained: true, snippetClient: options.client === 'snippet' ? 'Remove only your lumi-browser MCP entry from the client manually.' : undefined }));
    return { uninstalled: true };
  }
  if (!plan.same) {
    await backup([plan.installed, plan.manifest, plan.marker], path.join(path.dirname(plan.installDir), 'LumiBrowserMCP-setup-backups'));
    // Backup directory creation on a new install must not make it look foreign.
    const result = plan.platform === 'darwin'
      ? runner('/bin/bash', [path.join(plan.packageDir, plan.script), options.extensionId])
      : runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(plan.packageDir, plan.script), '-ExtensionId', options.extensionId]);
    if (result.status !== 0) throw new Error(`Native registration failed: ${result.stderr || result.stdout || result.status}`);
    if (hash(await fs.readFile(plan.installed)) !== plan.sha256) throw new Error('Installed executable checksum mismatch');
  }
  if (options.client === 'codex' && !codexSame) {
    await backup([codexConfig], path.join(path.dirname(codexConfig), 'lumi-setup-backups'));
    const result = runner(codex, ['mcp', 'add', 'lumi-browser', '--', plan.installed, '--mcp'], { env: codexEnv });
    if (result.status !== 0) throw new Error('Codex configuration failed; native registration remains installed. Existing config backup was retained.');
    const verification = runner(codex, ['mcp', 'get', 'lumi-browser', '--json'], { env: codexEnv });
    const value = verification.status === 0 ? JSON.parse(verification.stdout) : {};
    if (!matchesCodex(value, plan.installed)) throw new Error('Codex entry did not verify after add; inspect your configuration');
  }
  const doctor = runner(plan.installed, ['--doctor', '--extension-id', options.extensionId, '--json']);
  const { readiness, exitCode } = doctorResult(doctor);
  log(JSON.stringify({ installed: true, client: options.client, snippet, readiness, next: 'Enable the Chrome extension and authorize a tab; then run --setup --doctor with the same extension ID.' }, null, 2));
  return { installed: true, snippet, readiness, exitCode };
}
