import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Duplex } from "node:stream";
import { once, EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  Frames,
  writeFrame,
  MAX_FRAME,
  validate,
} from "../bridge/protocol.mjs";
import { createBroker, connect } from "../bridge/broker.mjs";
import { mcpHost, nativeHost } from "../bridge/hosts.mjs";
const delay = (n) => new Promise((r) => setTimeout(r, n));
function inbox(stream) {
  const values = [],
    waiters = [];
  stream.on("data", (m) => {
    const w = waiters.shift();
    if (w) w(m);
    else values.push(m);
  });
  return () => {
    if (values.length) return Promise.resolve(values.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Message timeout")), 2000);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
}
function fakeTransport() {
  let handler, server;
  class Socket extends Duplex {
    _read() {}
    _write(chunk, encoding, done) {
      if (this.peer.destroyed) return done(Error("Peer closed"));
      this.peer.push(Buffer.from(chunk));
      done();
    }
    _destroy(error, done) {
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
      done(error);
    }
  }
  return {
    serverFactory(fn) {
      handler = fn;
      server = new EventEmitter();
      server.listening = false;
      server.listen = () => {
        server.listening = true;
        queueMicrotask(() => server.emit("listening"));
      };
      server.close = () => {
        if (server.listening) {
          server.listening = false;
          queueMicrotask(() => server.emit("close"));
        }
      };
      return server;
    },
    connectionFactory() {
      const a = new Socket(),
        b = new Socket();
      a.peer = b;
      b.peer = a;
      queueMicrotask(() => {
        if (!server.listening) {
          a.destroy(Error("No listener"));
          return;
        }
        handler(b);
        a.emit("connect");
      });
      return a;
    },
  };
}
async function setup(opts = {}) {
  const transport = fakeTransport(),
    address = "in-memory",
    token = "a".repeat(64),
    broker = createBroker({
      token,
      startupGraceMs: 1000,
      idleGraceMs: 30,
      ...opts,
      serverFactory: transport.serverFactory,
    });
  broker.listen(address);
  await once(broker, "listening");
  const peers = [];
  const dial = (role, credential = token, metadata = {}) =>
    connect(address, role, credential, transport.connectionFactory, metadata);
  return {
    broker,
    address,
    token,
    dial,
    async client(role, metadata = {}) {
      const c = await dial(role, token, metadata);
      c.next = inbox(c.frames);
      peers.push(c);
      return c;
    },
    async stop() {
      broker.shutdown();
      for (const p of peers) p.socket.destroy();
      await delay(5);
    },
  };
}

const shared = {
  id: "shared-id",
  tabId: 1,
  origin: "https://example.test",
  url: "https://example.test/",
  title: "Test",
  state: "active",
};

test("native framing supports fragmented and combined Unicode messages", async () => {
  const wire = new PassThrough(),
    frames = new Frames(true),
    next = inbox(frames);
  wire.pipe(frames);
  const capture = new PassThrough(),
    chunks = [];
  capture.on("data", (b) => chunks.push(b));
  writeFrame(capture, { hello: "中文🙂" }, true);
  writeFrame(capture, { n: 2 }, true);
  const b = Buffer.concat(chunks);
  wire.write(b.subarray(0, 2));
  wire.write(b.subarray(2, 7));
  wire.end(b.subarray(7));
  assert.deepEqual(await next(), { hello: "中文🙂" });
  assert.deepEqual(await next(), { n: 2 });
});
test("frame bounds and truncated input fail closed", async () => {
  for (const native of [false, true]) {
    const f = new Frames(native),
      error = once(f, "error");
    f.resume();
    if (native) {
      const h = Buffer.alloc(4);
      h.writeUInt32LE(MAX_FRAME + 1);
      f.end(h);
    } else f.end(Buffer.alloc(MAX_FRAME + 1, 120));
    assert.match((await error)[0].message, /frame/i);
  }
  const f = new Frames(true),
    e = once(f, "error");
  f.resume();
  f.end(Buffer.from([1, 0]));
  assert.match((await e)[0].message, /Truncated/);
});
test("strict schemas reject unknown keys and invalid wait arguments", () => {
  assert.throws(() =>
    validate("fill", { sessionId: "s", ref: "r", value: "x" }),
  );
  assert.throws(() =>
    validate("wait_for", { sessionId: "s", text: "x", ref: "r" }),
  );
  assert.throws(() => validate("scroll", { sessionId: "s", deltaY: Infinity }));
  validate("fill", { sessionId: "s", ref: "r", text: "中文🙂" });
});
test("broker rejects incorrect local credential", async () => {
  const s = await setup();
  try {
    await assert.rejects(s.dial("mcp", "b".repeat(64)), /closed/);
  } finally {
    await s.stop();
  }
});
test("owner arbitration, matching native replies and cancellation routing", async () => {
  const s = await setup();
  try {
    const a = await s.client("mcp"),
      b = await s.client("mcp"),
      n = await s.client("native");
    writeFrame(n.socket, { type: "sessions", sessions: [shared] });
    await delay(10);
    writeFrame(a.socket, {
      type: "request",
      id: "a",
      tool: "snapshot",
      args: { sessionId: shared.id },
    });
    const request = await n.next();
    assert.equal(request.tool, "snapshot");
    writeFrame(b.socket, {
      type: "request",
      id: "b",
      tool: "click",
      args: { sessionId: shared.id, ref: "r" },
    });
    assert.equal((await b.next()).error.code, "session_owned");
    writeFrame(b.socket, { type: "cancel", id: "a" });
    writeFrame(n.socket, {
      type: "response",
      id: request.id,
      result: { text: "ok" },
    });
    assert.equal((await a.next()).result.text, "ok");
    writeFrame(a.socket, {
      type: "request",
      id: "c",
      tool: "click",
      args: { sessionId: shared.id, ref: "r" },
    });
    const clicked = await n.next();
    writeFrame(a.socket, { type: "cancel", id: "c" });
    assert.deepEqual(await n.next(), { type: "cancel", id: clicked.id });
    assert.equal((await a.next()).error.code, "outcome_unknown");
  } finally {
    await s.stop();
  }
});
test("native disconnect after dispatch is unknown, absent session is not dispatched", async () => {
  const s = await setup();
  try {
    const a = await s.client("mcp"),
      n = await s.client("native");
    writeFrame(n.socket, { type: "sessions", sessions: [shared] });
    await delay(10);
    writeFrame(a.socket, {
      type: "request",
      id: "a",
      tool: "click",
      args: { sessionId: shared.id, ref: "r" },
    });
    await n.next();
    n.socket.destroy();
    assert.equal((await a.next()).error.code, "outcome_unknown");
    writeFrame(a.socket, {
      type: "request",
      id: "b",
      tool: "click",
      args: { sessionId: shared.id, ref: "r" },
    });
    assert.equal((await a.next()).error.code, "disconnected");
  } finally {
    await s.stop();
  }
});
test("multiple MCP clients keep broker alive; last disconnect closes native and broker", async () => {
  const s = await setup();
  try {
    const a = await s.client("mcp"),
      b = await s.client("mcp"),
      n = await s.client("native");
    a.socket.destroy();
    await delay(60);
    assert.equal(s.broker.listening, true);
    const closed = once(s.broker, "close"),
      nativeClosed = once(n.socket, "close");
    b.socket.destroy();
    await Promise.all([closed, nativeClosed]);
    assert.equal(s.broker.listening, false);
  } finally {
    await s.stop();
  }
});
test("native-only startup does not leave a daemon", async () => {
  const s = await setup({ startupGraceMs: 40 });
  try {
    await s.client("native");
    await once(s.broker, "close");
    assert.equal(s.broker.listening, false);
  } finally {
    await s.stop();
  }
});
test("complete MCP newline → broker → native length framing → response", async () => {
  const s = await setup();
  const ni = new PassThrough(),
    no = new PassThrough(),
    mi = new PassThrough(),
    mo = new PassThrough(),
    nf = new Frames(true),
    mf = new Frames();
  no.pipe(nf);
  mo.pipe(mf);
  const nativeNext = inbox(nf),
    mcpNext = inbox(mf);
  let mcp;
  try {
    mcp = mcpHost(mi, mo, () => s.dial("mcp"));
    await nativeHost(ni, no, () => s.dial("native"));
    writeFrame(ni, { type: "sessions", sessions: [shared] }, true);
    await delay(10);
    writeFrame(mi, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal((await mcpNext()).result.protocolVersion, "2025-06-18");
    writeFrame(mi, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "fill",
        arguments: { sessionId: shared.id, ref: "r", text: "你好🙂" },
      },
    });
    const req = await nativeNext();
    assert.equal(req.args.text, "你好🙂");
    writeFrame(
      ni,
      { type: "response", id: req.id, result: { ok: true } },
      true,
    );
    const response = await mcpNext();
    assert.equal(response.id, 2);
    assert.deepEqual(JSON.parse(response.result.content[0].text), { ok: true });
  } finally {
    mcp?.close();
    ni.end();
    await s.stop();
  }
});
test("MCP cancellation during broker connection prevents dispatch", async () => {
  const mi = new PassThrough(),
    mo = new PassThrough(),
    socket = new PassThrough(),
    frames = new PassThrough({ objectMode: true });
  let resolve;
  const pending = new Promise((r) => (resolve = r));
  const written = [];
  socket.on("data", (b) => written.push(b));
  const m = mcpHost(mi, mo, () => pending);
  writeFrame(mi, {
    jsonrpc: "2.0",
    id: "cancel-me",
    method: "tools/call",
    params: { name: "snapshot", arguments: { sessionId: "s" } },
  });
  writeFrame(mi, {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "cancel-me" },
  });
  resolve({ socket, frames });
  await delay(10);
  assert.equal(written.length, 0);
  m.close();
});
test("actual stdio executable supports tools/list/ping and clean EOF without broker", async () => {
  const child = spawn(
      process.execPath,
      [path.resolve("bridge/index.mjs"), "--mcp"],
      { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] },
    ),
    frames = new Frames(),
    next = inbox(frames);
  child.stdout.pipe(frames);
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  writeFrame(child.stdin, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal((await next()).result.tools.length, 7);
  writeFrame(child.stdin, { jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual((await next()).result, {});
  child.stdin.end();
  assert.equal((await once(child, "exit"))[0], 0);
  assert.equal(stderr, "");
});

test("real local IPC handshake where OS sandbox allows sockets", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-real-ipc-")),
    address =
      process.platform === "win32"
        ? `\\\\.\\pipe\\lumi-test-${crypto.randomUUID()}`
        : path.join(dir, "ipc"),
    token = "c".repeat(64),
    broker = createBroker({ token, startupGraceMs: 100 });
  try {
    broker.listen(address);
    try {
      await once(broker, "listening");
    } catch (e) {
      if (["EPERM", "EACCES"].includes(e.code)) {
        t.skip("OS sandbox denies local socket listen");
        return;
      }
      throw e;
    }
    const c = await connect(address, "mcp", token);
    c.socket.destroy();
  } finally {
    const closed = broker.listening ? once(broker, "close") : null;
    broker.shutdown();
    if (closed) await closed;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP initialize attaches and keeps broker alive without tool calls", async () => {
  const s = await setup({ startupGraceMs: 40 }),
    mi = new PassThrough(),
    mo = new PassThrough(),
    frames = new Frames();
  mo.pipe(frames);
  const next = inbox(frames),
    m = mcpHost(mi, mo, () => s.dial("mcp"));
  try {
    writeFrame(mi, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal((await next()).result.serverInfo.name, "lumi-browser-mcp");
    await delay(70);
    assert.equal(s.broker.listening, true);
  } finally {
    m.close();
    await s.stop();
  }
});
test("timeout cancels once and returns unknown without replay", async () => {
  const s = await setup({ requestTimeoutMs: 20 });
  try {
    const a = await s.client("mcp"),
      n = await s.client("native");
    writeFrame(n.socket, { type: "sessions", sessions: [shared] });
    await delay(10);
    writeFrame(a.socket, {
      type: "request",
      id: "timeout",
      tool: "click",
      args: { sessionId: shared.id, ref: "r" },
    });
    const request = await n.next();
    const cancel = await n.next();
    assert.deepEqual(cancel, { type: "cancel", id: request.id });
    assert.equal((await a.next()).error.code, "outcome_unknown");
  } finally {
    await s.stop();
  }
});
test("owner disconnect cancels its pending work and releases ownership", async () => {
  const s = await setup();
  try {
    const a = await s.client("mcp"),
      b = await s.client("mcp"),
      n = await s.client("native");
    writeFrame(n.socket, { type: "sessions", sessions: [shared] });
    await delay(10);
    writeFrame(a.socket, {
      type: "request",
      id: "a",
      tool: "snapshot",
      args: { sessionId: shared.id },
    });
    const request = await n.next();
    a.socket.destroy();
    assert.deepEqual(await n.next(), { type: "cancel", id: request.id });
    writeFrame(b.socket, {
      type: "request",
      id: "b",
      tool: "snapshot",
      args: { sessionId: shared.id },
    });
    const replacement = await n.next();
    assert.equal(replacement.tool, "snapshot");
    writeFrame(n.socket, {
      type: "response",
      id: replacement.id,
      result: { ok: true },
    });
    assert.equal((await b.next()).result.ok, true);
  } finally {
    await s.stop();
  }
});
test("outgoing native messages cannot exceed Chrome one-MiB limit", () => {
  assert.throws(
    () => writeFrame(new PassThrough(), { text: "x".repeat(MAX_FRAME) }, true),
    /Frame too large/,
  );
});
test("help exits without runtime startup", async () => {
  const child = spawn(process.execPath, [
      path.resolve("bridge/index.mjs"),
      "--help",
    ]),
    chunks = [];
  child.stdout.on("data", (b) => chunks.push(b));
  assert.equal((await once(child, "exit"))[0], 0);
  assert.match(Buffer.concat(chunks).toString(), /Lumi Browser MCP/);
});

test("doctor sees only counts, cannot operate tools or take session ownership", async () => {
  const s = await setup();
  try {
    const m = await s.client("mcp"), n = await s.client("native"), d = await s.client("doctor");
    writeFrame(d.socket, { type: "status", id: "before" });
    assert.equal((await d.next()).sessionPublishers, 0);
    writeFrame(n.socket, { type: "sessions", sessions: [shared] });
    await delay(10);
    writeFrame(d.socket, { type: "status", id: "after" });
    const status = await d.next();
    assert.equal(status.nativeHosts, 1);
    assert.equal(status.sessionPublishers, 1);
    assert.equal(status.activeSessions, 1);
    assert.equal(JSON.stringify(status).includes(shared.origin), false);
    const closed = once(d.socket, "close");
    writeFrame(d.socket, { type: "request", id: "forbidden", tool: "click", args: { sessionId: shared.id, ref: "r" } });
    await closed;
    assert.equal(s.broker.listening, true);
    writeFrame(m.socket, { type: "request", id: "normal", tool: "snapshot", args: { sessionId: shared.id } });
    const request = await n.next();
    assert.equal(request.tool, "snapshot");
    writeFrame(n.socket, { type: "response", id: request.id, result: { ok: true } });
    assert.equal((await m.next()).result.ok, true);
  } finally {
    await s.stop();
  }
});
test("doctor closing does not revoke a native-only session or change startup grace", async () => {
  const s = await setup({ startupGraceMs: 140, idleGraceMs: 10 });
  try {
    const n = await s.client("native"), d = await s.client("doctor");
    writeFrame(n.socket, { type: "sessions", sessions: [shared] });
    d.socket.destroy();
    await delay(40);
    assert.equal(s.broker.listening, true);
    assert.equal(n.socket.destroyed, false);
    await once(s.broker, "close");
  } finally {
    await s.stop();
  }
});
test("MCP result escaping overflow returns bounded tool error without closing client", async () => {
  const input = new PassThrough(), output = new PassThrough(), outFrames = new Frames(), socket = new PassThrough(), responses = new PassThrough({ objectMode: true });
  output.pipe(outFrames);
  const next = inbox(outFrames), requests = new Frames();
  socket.pipe(requests);
  const requestNext = inbox(requests), host = mcpHost(input, output, async () => ({ socket, frames: responses }));
  try {
    writeFrame(input, { jsonrpc: "2.0", id: "large", method: "tools/call", params: { name: "read_text", arguments: { sessionId: "s" } } });
    const request = await requestNext();
    responses.write({ type: "response", id: request.id, result: { text: "\\".repeat(3e5) } });
    const reply = await next();
    assert.equal(reply.result.isError, true);
    assert.equal(JSON.parse(reply.result.content[0].text).error.code, "response_too_large");
    writeFrame(input, { jsonrpc: "2.0", id: "still-open", method: "ping" });
    assert.deepEqual((await next()).result, {});
  } finally {
    host.close();
  }
});

test('doctor expected origin filters different native extensions and originless hosts', async () => {
  const s = await setup();
  const first = 'chrome-extension://' + 'a'.repeat(32) + '/';
  const second = 'chrome-extension://' + 'b'.repeat(32) + '/';
  try {
    await s.client('mcp');
    const a = await s.client('native', {origin:first});
    const b = await s.client('native', {origin:second});
    const originless = await s.client('native');
    const d = await s.client('doctor');
    writeFrame(a.socket, {type:'sessions',sessions:[{...shared,id:'first'}]});
    writeFrame(b.socket, {type:'sessions',sessions:[{...shared,id:'second',state:'paused'}]});
    writeFrame(originless.socket, {type:'sessions',sessions:[{...shared,id:'no-origin'}]});
    await delay(10);
    for (const [origin,active] of [[first,1],[second,0]]) {
      writeFrame(d.socket,{type:'status',id:origin,expectedOrigin:origin});
      const status=await d.next();
      assert.equal(status.originMatched,true);
      assert.equal(status.nativeHosts,1);
      assert.equal(status.sessionPublishers,1);
      assert.equal(status.activeSessions,active);
      assert.equal(status.sessions,1);
    }
    writeFrame(d.socket,{type:'status',id:'missing',expectedOrigin:'chrome-extension://'+'c'.repeat(32)+'/'});
    const missing=await d.next();
    assert.equal(missing.nativeHosts,0);
    assert.equal(missing.activeSessions,0);
  } finally { await s.stop(); }
});
