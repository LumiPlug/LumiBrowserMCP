import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import { Frames, writeFrame, validate } from "./protocol.mjs";
export function endpoint() {
  const dir = path.join(os.homedir(), ".lumi-browser-mcp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (st.uid !== process.getuid() || st.mode & 0o077))
  )
    throw Error("Unsafe IPC directory; requires owner-only permissions");
  const file = path.join(dir, "ipc-token");
  try {
    fs.writeFileSync(file, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const f = fs.lstatSync(file);
  if (
    !f.isFile() ||
    f.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (f.uid !== process.getuid() || f.mode & 0o077))
  )
    throw Error("Unsafe IPC token permissions");
  const token = fs.readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid IPC token");
  const user = createHash("sha256")
    .update(os.userInfo().username + "\0" + os.homedir())
    .digest("hex")
    .slice(0, 24);
  return {
    dir,
    token,
    address:
      process.platform === "win32"
        ? `\\\\.\\pipe\\lumi-browser-mcp-${user}`
        : path.join(dir, "broker.sock"),
  };
}
export function createBroker({
  token,
  startupGraceMs = 30000,
  idleGraceMs = 1000,
  requestTimeoutMs = 35000,
  serverFactory = net.createServer,
} = {}) {
  if (!token) throw Error("Broker token required");
  const clients = new Set(),
    sessions = new Map(),
    pending = new Map();
  let idleTimer,
    seenMcp = false,
    closing = false;
  const send = (c, m) => {
    try {
      writeFrame(c, m);
      return true;
    } catch {
      c.destroy();
      return false;
    }
  };
  function finish(p, error, result) {
    if (!pending.has(p.id)) return;
    clearTimeout(p.timer);
    pending.delete(p.id);
    send(p.client, {
      type: "response",
      id: p.original,
      ...(error ? { error } : { result }),
    });
  }
  const unknown = (p, message) =>
    finish(p, {
      code: "outcome_unknown",
      message: message + " Do not automatically retry.",
    });
  function idle() {
    clearTimeout(idleTimer);
    if (![...clients].some((c) => c.role === "mcp"))
      idleTimer = setTimeout(
        () => server.shutdown(),
        seenMcp ? idleGraceMs : startupGraceMs,
      );
  }
  const server = serverFactory((c) => {
    if (closing) return c.destroy();
    clients.add(c);
    c.role = null;
    c.sessions = new Set();
    const frames = new Frames();
    c.pipe(frames);
    const hello = setTimeout(() => c.destroy(), 3000);
    c.on("error", () => {});
    frames.on("error", () => c.destroy());
    frames.on("data", (m) => {
      if (!c.role) {
        if (
          m.type !== "hello" ||
          !["native", "mcp", "doctor"].includes(m.role) ||
          typeof m.token !== "string" ||
          Buffer.byteLength(m.token) !== Buffer.byteLength(token) ||
          !timingSafeEqual(Buffer.from(m.token), Buffer.from(token))
        )
          return c.destroy();
        c.role = m.role;
        // Chrome supplies this origin argument to the native host. Same-user
        // processes can impersonate peers; this is attribution, not strong auth.
        c.origin = c.role === "native" && typeof m.origin === "string" &&
          /^chrome-extension:\/\/[a-p]{32}\/$/.test(m.origin) ? m.origin : null;
        clearTimeout(hello);
        if (c.role === "mcp") seenMcp = true;
        if (c.role !== "doctor") idle();
        send(c, { type: "ready" });
        return;
      }
      if (c.role === "doctor") {
        if (m.type !== "status" || typeof m.id !== "string" || m.id.length > 256) return c.destroy();
        if (m.expectedOrigin !== undefined && (typeof m.expectedOrigin !== "string" || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(m.expectedOrigin))) return c.destroy();
        const native = [...clients].filter(client => client.role === "native" && (!m.expectedOrigin || client.origin === m.expectedOrigin));
        const matchingSessions = [...sessions.values()].filter(session => native.includes(session.native));
        send(c, {
          type: "status", id: m.id,
          originMatched: !!m.expectedOrigin,
          nativeHosts: native.length,
          sessionPublishers: native.filter(client => client.publishedSessions).length,
          sessions: matchingSessions.length,
          activeSessions: matchingSessions.filter(session => session.item.state === "active").length
        });
        return;
      }
      if (c.role === "native" && m.type === "sessions") {
        if (!Array.isArray(m.sessions) || m.sessions.length > 200)
          return c.destroy();
        c.publishedSessions = true;
        const ids = new Set(m.sessions.map((s) => s?.id));
        for (const id of c.sessions)
          if (!ids.has(id)) {
            sessions.delete(id);
            for (const p of pending.values())
              if (p.sessionId === id)
                unknown(p, "Session revoked after dispatch.");
          }
        const next = new Set();
        for (const item of m.sessions) {
          if (
            !item ||
            typeof item.id !== "string" ||
            !item.id ||
            item.id.length > 256
          )
            continue;
          const prior = sessions.get(item.id);
          if (prior && prior.native !== c) continue;
          const safe = {
            id: item.id,
            tabId: item.tabId,
            title: String(item.title ?? "").slice(0, 4096),
            url: String(item.url ?? "").slice(0, 8192),
            origin: String(item.origin ?? "").slice(0, 4096),
            state: String(item.state ?? "").slice(0, 128),
          };
          sessions.set(item.id, { native: c, item: safe, owner: prior?.owner });
          next.add(item.id);
        }
        c.sessions = next;
        return;
      }
      if (c.role === "native" && m.type === "response") {
        const p = pending.get(m.id);
        if (p?.native === c) finish(p, m.error, m.result);
        return;
      }
      if (c.role === "mcp" && m.type === "cancel") {
        for (const p of pending.values())
          if (p.client === c && p.original === m.id) {
            send(p.native, { type: "cancel", id: p.id });
            unknown(
              p,
              "Request cancelled after dispatch; operation may have occurred.",
            );
          }
        return;
      }
      if (
        c.role !== "mcp" ||
        m.type !== "request" ||
        typeof m.id !== "string" ||
        m.id.length > 256
      )
        return c.destroy();
      const fail = (code, message) =>
        send(c, { type: "response", id: m.id, error: { code, message } });
      try {
        validate(m.tool, m.args);
      } catch (e) {
        return fail("invalid_arguments", e.message);
      }
      if (m.tool === "list_sessions")
        return send(c, {
          type: "response",
          id: m.id,
          result: {
            sessions: [...sessions.values()].map((s) => ({
              ...s.item,
              available: !s.owner || s.owner === c,
            })),
          },
        });
      const s = sessions.get(m.args.sessionId);
      if (!s || s.native.destroyed)
        return fail(
          "disconnected",
          "Session unavailable; request not dispatched.",
        );
      if (s.owner && s.owner !== c)
        return fail(
          "session_owned",
          "Another MCP client owns this session; request not dispatched.",
        );
      if (s.item.state !== "active")
        return fail(
          "session_inactive",
          "Session is not active; request not dispatched.",
        );
      if (pending.size >= 256)
        return fail("busy", "Too many pending requests; not dispatched.");
      s.owner = c;
      const id = randomUUID(),
        p = {
          id,
          original: m.id,
          client: c,
          native: s.native,
          sessionId: m.args.sessionId,
        };
      p.timer = setTimeout(
        () => {
          send(p.native, { type: "cancel", id });
          unknown(
            p,
            "Response timed out after dispatch; operation may have occurred.",
          );
        },
        Math.max(requestTimeoutMs, (m.args.timeoutMs ?? 0) + 1000),
      );
      pending.set(id, p);
      send(s.native, { type: "request", id, tool: m.tool, args: m.args });
    });
    c.on("close", () => {
      clearTimeout(hello);
      clients.delete(c);
      for (const id of c.sessions) sessions.delete(id);
      for (const s of sessions.values()) if (s.owner === c) s.owner = null;
      for (const p of pending.values()) {
        if (p.native === c)
          unknown(
            p,
            "Browser disconnected after dispatch; operation may have occurred.",
          );
        else if (p.client === c) {
          clearTimeout(p.timer);
          pending.delete(p.id);
          send(p.native, { type: "cancel", id: p.id });
        }
      }
      if (!closing && c.role !== "doctor") idle();
    });
  });
  server.shutdown = () => {
    if (closing) return;
    closing = true;
    clearTimeout(idleTimer);
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    for (const c of clients) c.destroy();
    server.close();
  };
  server.on("listening", idle);
  server.on("close", () => clearTimeout(idleTimer));
  return server;
}
export async function connect(
  address,
  role,
  token,
  connectionFactory = net.createConnection,
  metadata = {},
) {
  return new Promise((resolve, reject) => {
    const socket = connectionFactory(address),
      frames = new Frames();
    socket.pipe(frames);
    let settled = false;
    const timer = setTimeout(
      () => bad(Error("Broker handshake timeout")),
      1500,
    );
    function bad(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    }
    socket.once("error", bad);
    socket.once("close", () => bad(Error("Broker closed during handshake")));
    frames.on("error", () => socket.destroy());
    socket.once("connect", () => {
      try {
        writeFrame(socket, { type: "hello", role, token, origin: metadata.origin });
      } catch (e) {
        bad(e);
      }
    });
    frames.once("data", (m) => {
      if (m.type !== "ready") return bad(Error("Invalid broker handshake"));
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", bad);
      socket.on("error", () => {});
      resolve({ socket, frames });
    });
  });
}
export async function connectOrLaunch(role, metadata = {}) {
  const { dir, address, token } = endpoint(),
    lock = path.join(dir, "startup.lock"),
    deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      return await connect(address, role, token, undefined, metadata);
    } catch {}
    let owns = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      owns = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 20000) fs.rmdirSync(lock);
      } catch {}
    }
    if (owns)
      try {
        try {
          return await connect(address, role, token, undefined, metadata);
        } catch {}
        if (process.platform !== "win32")
          try {
            fs.unlinkSync(address);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        const script =
          process.argv[1] && /\.(?:mjs|cjs|js)$/.test(process.argv[1]);
        const child = spawn(
          process.execPath,
          [...(script ? [process.argv[1]] : []), "--broker"],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.on("error", () => {});
        child.unref();
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 75));
          try {
            return await connect(address, role, token, undefined, metadata);
          } catch {}
        }
      } finally {
        try {
          fs.rmdirSync(lock);
        } catch {}
      }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Local adapter startup timed out");
}
