import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { binaryTarget, parseSetupArgs, preflight, runSetup } from '../scripts/setup.mjs';
const id = 'a'.repeat(32);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumi-setup-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, 'package'); await fs.mkdir(pkg);
  const exe = Buffer.alloc(64); exe.writeUInt32LE(0xfeedfacf); exe.writeUInt32LE(0x100000c, 4);
  const sha256 = createHash('sha256').update(exe).digest('hex');
  await fs.writeFile(path.join(pkg, 'lumi-browser-adapter'), exe);
  await fs.writeFile(path.join(pkg, 'setup-manifest.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64', sha256 }));
  for (const n of ['install-macos.sh', 'uninstall-macos.sh']) await fs.writeFile(path.join(pkg, n), '# mocked, never executed');
  return { dir, pkg, exe, sha256, args: ['--extension-id', id, '--package-dir', pkg], ctx: { platform: 'darwin', arch: 'arm64', home: path.join(dir, 'home'), env: {}, log() {}, runner() { throw new Error('Unexpected execution'); } } };
}
test('setup defaults to dry-run and validates IDs/options', () => {
  assert.equal(parseSetupArgs(['--extension-id', id]).dryRun, true);
  assert.equal(parseSetupArgs(['--extension-id', id, '--apply']).dryRun, false);
  assert.throws(() => parseSetupArgs(['--extension-id', 'A'.repeat(32)]));
  assert.throws(() => parseSetupArgs(['--extension-id', id, '--bogus']));
  assert.throws(() => binaryTarget(Buffer.alloc(64)));
});
test('dry-run verifies binary/hash/architecture without writes or processes', async t => {
  const f = await fixture(t);
  const result = await runSetup(f.args, f.ctx);
  assert.equal(result.dryRun, true);
  await assert.rejects(fs.stat(f.ctx.home), { code: 'ENOENT' });
  await assert.rejects(runSetup([...f.args, '--sha256', '0'.repeat(64)], f.ctx), /SHA-256/);
  await assert.rejects(runSetup(f.args, { ...f.ctx, arch: 'x64' }), /does not match/);
});
test('foreign installation and Codex name conflicts are rejected before mutations', async t => {
  const f = await fixture(t);
  await assert.rejects(runSetup([...f.args, '--client', 'codex', '--apply'], { ...f.ctx, runner() { return { status: 0, stdout: JSON.stringify({ transport: { command: 'foreign', args: [] } }) }; } }), /refusing overwrite/);
  const install = path.join(f.ctx.home, 'Library', 'Application Support', 'LumiBrowserMCP');
  await fs.mkdir(install, { recursive: true });
  await assert.rejects(runSetup(f.args, f.ctx), /not owned/);
});
test('matching existing install and Codex entry are idempotent', async t => {
  const f = await fixture(t);
  const plan = await preflight(parseSetupArgs(f.args), f.ctx);
  await fs.mkdir(plan.installDir, { recursive: true });
  await fs.writeFile(plan.marker, 'LumiBrowserMCP installer v1\n');
  await fs.writeFile(plan.installed, f.exe);
  await fs.mkdir(path.dirname(plan.manifest), { recursive: true });
  await fs.writeFile(plan.manifest, JSON.stringify({ name: 'com.lumiplug.browser', type: 'stdio', path: plan.installed, allowed_origins: [`chrome-extension://${id}/`] }));
  const calls = [];
  const result = await runSetup([...f.args, '--client', 'codex', '--apply'], { ...f.ctx, runner(cmd,args) { calls.push(args); if (args[0] === '--doctor') return { status: 0, stdout: '{"ready":true}' }; return { status: 0, stdout: JSON.stringify({ enabled: true, transport: { type: 'stdio', command: plan.installed, args: ['--mcp'] } }) }; } });
  assert.equal(result.installed, true);
  assert.deepEqual(calls, [['mcp', 'get', 'lumi-browser', '--json'], ['mcp', 'get', 'lumi-browser', '--json'], ['--doctor', '--extension-id', id, '--json']]);
  await assert.rejects(fs.stat(path.join(plan.installDir, '.setup-backups')), { code: 'ENOENT' });
});
test('doctor is read-only and propagates not-ready status', async t => {
  const f = await fixture(t); const calls = [];
  const result = await runSetup([...f.args, '--doctor'], { ...f.ctx, runner(cmd,args) { calls.push(args); return { status: 1, stdout: '{"ready":false}' }; } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, [['--doctor', '--extension-id', id, '--json']]);
  await assert.rejects(fs.stat(f.ctx.home), { code: 'ENOENT' });
});
test('Codex apply uses official CLI, preserves unrelated config and creates private backup', async t => {
  const f = await fixture(t);
  const plan = await preflight(parseSetupArgs(f.args), f.ctx);
  const codexHome = path.join(f.dir, 'codex'); await fs.mkdir(codexHome);
  const original = '[other]\nkeep = "untouched"\n';
  await fs.writeFile(path.join(codexHome, 'config.toml'), original);
  let configured = false; const calls = [];
  const runner = (cmd,args) => {
    calls.push([cmd,...args]);
    if (args[0] === '--doctor') return { status: 1, stdout: '{"ready":false}' };
    if (cmd === '/bin/bash') return { status: 0 }; // File materialization below is performed by the mock async context.
    if (args[1] === 'get') return configured ? { status: 0, stdout: JSON.stringify({ transport: { command: plan.installed, args: ['--mcp'] } }) } : { status: 1, stderr: "No MCP server named 'lumi-browser' found." };
    if (args[1] === 'add') { configured = true; return { status: 0 }; }
    throw new Error('Unexpected command');
  };
  // An existing matching native installation isolates the Codex configuration branch.
  await fs.mkdir(plan.installDir, { recursive: true }); await fs.writeFile(plan.marker, 'LumiBrowserMCP installer v1'); await fs.writeFile(plan.installed, f.exe);
  await fs.mkdir(path.dirname(plan.manifest), { recursive: true }); await fs.writeFile(plan.manifest, JSON.stringify({ name: 'com.lumiplug.browser', type: 'stdio', path: plan.installed, allowed_origins: [`chrome-extension://${id}/`] }));
  await runSetup([...f.args, '--client', 'codex', '--codex-home', codexHome, '--apply'], { ...f.ctx, runner });
  assert.equal(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), original);
  const backupRoot = path.join(codexHome, 'lumi-setup-backups'); const dirs = await fs.readdir(backupRoot);
  assert.equal(await fs.readFile(path.join(backupRoot, dirs[0], 'config.toml'), 'utf8'), original);
  assert.ok(calls.some(c => JSON.stringify(c) === JSON.stringify(['codex', 'mcp', 'add', 'lumi-browser', '--', plan.installed, '--mcp'])));
});
test('uninstall default dry-run never invokes removals or writes backups', async t => {
  const f = await fixture(t);
  const result = await runSetup([...f.args, '--uninstall'], f.ctx);
  assert.equal(result.dryRun, true);
  await assert.rejects(fs.stat(f.ctx.home), { code: 'ENOENT' });
});
test('Codex dry-run launches no external process; help needs no ID', async t => {
  const f = await fixture(t);
  assert.equal((await runSetup([...f.args, '--client', 'codex'], f.ctx)).dryRun, true);
  assert.equal((await runSetup(['--help'], f.ctx)).exitCode, 0);
});
test('doctor signal termination is never success', async t => {
  const f = await fixture(t);
  const result = await runSetup([...f.args, '--doctor'], { ...f.ctx, runner() { return { status: null, signal: 'SIGTERM', stdout: '' }; } });
  assert.equal(result.exitCode, 1);
});
test('doctor requires explicit ready true, not merely exit zero', async t => {
  const f = await fixture(t);
  for (const stdout of ['', '{}', 'invalid', 'null', '{"ready":false}']) {
    const result = await runSetup([...f.args, '--doctor'], { ...f.ctx, runner() { return { status: 0, stdout }; } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.ready, false);
  }
});
test('Codex dry-run reports absolute config and native manifest paths without processes', async t => {
  const f = await fixture(t); const output = [];
  await runSetup([...f.args, '--client', 'codex'], { ...f.ctx, log: value => output.push(value) });
  const plan = JSON.parse(output[0]);
  assert.equal(plan.codexConfig, path.join(f.ctx.home, '.codex', 'config.toml'));
  assert.equal(plan.nativeManifest, path.join(f.ctx.home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.lumiplug.browser.json'));
});
test('apply uninstall removes only matching Codex entry, verifies absence and preserves config backup', async t => {
  const f = await fixture(t); const plan = await preflight(parseSetupArgs(f.args), f.ctx);
  await fs.mkdir(plan.installDir, { recursive: true }); await fs.writeFile(plan.marker, 'LumiBrowserMCP installer v1'); await fs.writeFile(plan.installed, f.exe);
  await fs.mkdir(path.dirname(plan.manifest), { recursive: true });
  await fs.writeFile(plan.manifest, JSON.stringify({ name: 'com.lumiplug.browser', type: 'stdio', path: plan.installed, allowed_origins: [`chrome-extension://${id}/`] }));
  const codexHome = path.join(f.dir, 'codex'); await fs.mkdir(codexHome);
  const unrelated = '[mcp_servers.other]\ncommand = "untouched"\n';
  await fs.writeFile(path.join(codexHome, 'config.toml'), unrelated);
  let present = true; const calls = [];
  const result = await runSetup([...f.args, '--client', 'codex', '--codex-home', codexHome, '--uninstall', '--apply'], { ...f.ctx, runner(cmd,args) {
    calls.push([cmd,...args]);
    if (cmd === '/bin/bash') { assert.equal(present, false, 'Codex removal verified before native unregister'); return { status: 0 }; }
    if (args[1] === 'get') return present ? { status: 0, stdout: JSON.stringify({ transport: { type: 'stdio', command: plan.installed, args: ['--mcp'] } }) } : { status: 1, stderr: "No MCP server named 'lumi-browser' found." };
    if (args[1] === 'remove') { assert.equal(args[2], 'lumi-browser'); present = false; return { status: 0 }; }
    throw new Error('Unexpected execution');
  } });
  assert.equal(result.uninstalled, true);
  assert.equal(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), unrelated);
  assert.deepEqual(calls.slice(0,4).map(c=>c.slice(1)), [['mcp','get','lumi-browser','--json'],['mcp','get','lumi-browser','--json'],['mcp','remove','lumi-browser'],['mcp','get','lumi-browser','--json']]);
  const backups = await fs.readdir(path.join(codexHome, 'lumi-setup-backups'));
  assert.equal(await fs.readFile(path.join(codexHome,'lumi-setup-backups',backups[0],'config.toml'),'utf8'), unrelated);
  assert.equal(calls.at(-1)[1], path.join(f.pkg, 'uninstall-macos.sh'));
});
