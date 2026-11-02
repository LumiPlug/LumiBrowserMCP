import test from "node:test";
import assert from "node:assert/strict";
const event = () => ({
  listeners: [],
  addListener(fn) {
    this.listeners.push(fn);
  },
  fire(...args) {
    for (const fn of this.listeners) fn(...args);
  },
});
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
async function setup({ alarms = [], fail = false, initializationGate } = {}) {
  const scheduled = new Map(alarms.map((alarm) => [alarm.name, alarm]));
  const ports = [],
    commands = [],
    attached = [],
    detached = [];
  let attempts = 0;
  globalThis.chrome = {
    runtime: {
      id: "test",
      getURL: (file) => `chrome-extension://test/${file}`,
      onMessage: event(),
      onStartup: event(),
      onInstalled: event(),
      connectNative(name) {
        assert.equal(name, "com.lumiplug.browser");
        attempts++;
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          sent: [],
          postMessage(message) {
            this.sent.push(message);
          },
          disconnect() {
            this.onDisconnect.fire();
          },
        };
        ports.push(port);
        if (fail) queueMicrotask(() => port.onDisconnect.fire());
        return port;
      },
    },
    alarms: {
      onAlarm: event(),
      getAll: async () => {
        await initializationGate;
        return [...scheduled.values()];
      },
      create: async (name, info) => {
        scheduled.set(name, { name, scheduledTime: info.when });
      },
      clear: async (name) => scheduled.delete(name),
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: {
      get: async (id) => ({
        id,
        url: "https://example.test/",
        title: "Fixture",
      }),
      onRemoved: event(),
      onUpdated: event(),
    },
    webNavigation: { onCommitted: event() },
    debugger: {
      onDetach: event(),
      attach: async (target) => attached.push(target),
      detach: async (target) => detached.push(target),
      sendCommand: async (...args) => {
        commands.push(args);
        return {};
      },
    },
    scripting: {
      executeScript: async ({ args: [op] }) => [
        {
          result:
            op === "prepare" || op === "verify"
              ? { x: 20, y: 30 }
              : op === "wait_check"
                ? { matched: false }
                : { ok: true },
        },
      ],
    },
  };
  await import(
    `../extension/background.js?transport-test=${crypto.randomUUID()}`
  );
  await flush();
  const listener = chrome.runtime.onMessage.listeners[0];
  const send = (message) =>
    new Promise((resolve) =>
      listener(
        message,
        { id: "test", url: "chrome-extension://test/popup.html" },
        resolve,
      ),
    );
  return {
    ports,
    commands,
    attached,
    detached,
    scheduled,
    send,
    attempts: () => attempts,
    async fire(name) {
      const alarm = scheduled.get(name);
      assert.ok(alarm, `Missing alarm ${name}`);
      scheduled.delete(name);
      chrome.alarms.onAlarm.fire(alarm);
      await flush();
    },
  };
}

test("worker startup establishes communication, but ready handshake and tab consent remain separate", async () => {
  const env = await setup();
  assert.equal(env.attempts(), 1);
  let state = (await env.send({ type: "status" })).result;
  assert.equal(state.connected, false);
  assert.equal(state.connecting, true);
  assert.deepEqual(state.sessions, []);
  assert.equal(env.attached.length, 0);
  assert.equal(env.commands.length, 0);
  chrome.runtime.onStartup.fire();
  chrome.runtime.onInstalled.fire();
  await flush();
  assert.equal(env.attempts(), 1);
  env.ports[0].onMessage.fire({ type: "ready" });
  state = (await env.send({ type: "status" })).result;
  assert.equal(state.connected, true);
  assert.equal(state.connecting, false);
  const published = env.ports[0].sent.length;
  env.ports[0].onMessage.fire({ type: "ready" });
  assert.equal(env.ports[0].sent.length, published);
  assert.equal(env.attached.length, 0);
});

test("disconnect cancels queued work, reconnect never restores consent, and old port callbacks are inert", async () => {
  const env = await setup(),
    first = env.ports[0];
  first.onMessage.fire({ type: "ready" });
  const s1 = (await env.send({ type: "authorize", tabId: 1 })).result.id;
  const s2 = (await env.send({ type: "authorize", tabId: 2 })).result.id;
  await env.send({ type: "pause", sessionId: s1 });
  await env.send({ type: "takeover", sessionId: s2 });
  const s3 = (await env.send({ type: "authorize", tabId: 3 })).result.id;
  first.onMessage.fire({
    type: "request",
    id: "queued",
    tool: "click",
    args: { sessionId: s3, ref: "old-ref" },
  });
  first.onDisconnect.fire();
  await flush();
  assert.equal(env.commands.length, 0);
  let status = (await env.send({ type: "status" })).result;
  assert.equal(status.sessions.find((s) => s.id === s1).state, "disconnected");
  assert.equal(status.sessions.find((s) => s.id === s2).state, "taken_over");
  assert.equal(status.sessions.find((s) => s.id === s3).state, "disconnected");
  await env.fire("lumi-browser-connect-1");
  const second = env.ports[1];
  assert.equal(env.attached.length, 3);
  first.onMessage.fire({ type: "ready" });
  first.onDisconnect.fire();
  assert.equal((await env.send({ type: "status" })).result.connected, false);
  second.onMessage.fire({ type: "ready" });
  assert.equal((await env.send({ type: "status" })).result.retry.attempt, 0);
  assert.equal(
    (
      await env.send({
        type: "command",
        tool: "click",
        args: { sessionId: s3, ref: "old-ref" },
      })
    ).error.code,
    "cancelled",
  );
  const fresh = (await env.send({ type: "authorize", tabId: 4 })).result.id;
  first.onDisconnect.fire();
  first.onMessage.fire({
    type: "request",
    id: "stale-port",
    tool: "click",
    args: { sessionId: fresh, ref: "r" },
  });
  await flush();
  status = (await env.send({ type: "status" })).result;
  assert.equal(status.connected, true);
  assert.equal(status.sessions.find((s) => s.id === fresh).state, "active");
  assert.equal(env.commands.length, 0);
});

test("missing host has finite alarm backoff; status reads do not bypass it, manual retry does", async () => {
  const env = await setup({ fail: true });
  assert.equal(env.attempts(), 1);
  for (let i = 1; i <= 5; i++) {
    for (let j = 0; j < 3; j++) await env.send({ type: "status" });
    assert.equal(env.attempts(), i);
    assert.ok(
      env.scheduled.get(`lumi-browser-connect-${i}`).scheduledTime > Date.now(),
    );
    await env.fire(`lumi-browser-connect-${i}`);
  }
  assert.equal(env.attempts(), 6);
  assert.equal((await env.send({ type: "status" })).result.retry.paused, true);
  await env.fire("lumi-browser-connect-paused");
  assert.equal(env.attempts(), 6);
  await env.send({ type: "reconnect" });
  await flush();
  assert.equal(env.attempts(), 7);
  assert.ok(env.scheduled.has("lumi-browser-connect-1"));
  assert.equal(env.attached.length, 0);
});

test("MV3 restart respects an existing retry alarm and an exhausted marker", async () => {
  const env = await setup({
    fail: true,
    alarms: [
      { name: "lumi-browser-connect-3", scheduledTime: Date.now() + 60000 },
    ],
  });
  assert.equal(env.attempts(), 0);
  await env.send({ type: "status" });
  assert.equal(env.attempts(), 0);
  await env.fire("lumi-browser-connect-3");
  assert.equal(env.attempts(), 1);
  assert.ok(env.scheduled.has("lumi-browser-connect-4"));
  const paused = await setup({
    fail: true,
    alarms: [
      {
        name: "lumi-browser-connect-paused",
        scheduledTime: Date.now() + 60000,
      },
    ],
  });
  assert.equal(paused.attempts(), 0);
  assert.equal(
    (await paused.send({ type: "status" })).result.retry.paused,
    true,
  );
  chrome.runtime.onStartup.fire();
  await flush();
  assert.equal(paused.attempts(), 1);
});

test("a host without the new ready handshake times out safely through alarms", async () => {
  const env = await setup();
  const handshake = [...env.scheduled.keys()].find((name) =>
    name.startsWith("lumi-browser-handshake-"),
  );
  await env.fire(handshake);
  const state = (await env.send({ type: "status" })).result;
  assert.equal(state.connected, false);
  assert.equal(state.connecting, false);
  assert.match(state.transportError, /handshake timed out/);
  assert.equal(env.attempts(), 1);
  assert.ok(env.scheduled.has("lumi-browser-connect-1"));
  assert.equal(env.attached.length, 0);
});

test("disconnect during authorization cannot leave a newly active session", async () => {
  const env = await setup();
  env.ports[0].onMessage.fire({ type: "ready" });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  chrome.tabs.get = async (id) => {
    await gate;
    return { id, url: "https://example.test/", title: "Fixture" };
  };
  const authorizing = env.send({ type: "authorize", tabId: 11 });
  await flush();
  env.ports[0].onDisconnect.fire();
  release();
  assert.equal((await authorizing).error.code, "cancelled");
  assert.ok(
    (await env.send({ type: "status" })).result.sessions.every(
      (session) => session.state !== "active",
    ),
  );
  assert.equal(env.detached.length, 1);
});

test("a pending resume never overrides disconnect or explicit takeover", async () => {
  for (const change of ["disconnect", "takeover"]) {
    const env = await setup();
    env.ports[0].onMessage.fire({ type: "ready" });
    const sessionId = (await env.send({ type: "authorize", tabId: 12 })).result
      .id;
    await env.send({ type: "pause", sessionId });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    chrome.tabs.get = async (id) => {
      await gate;
      return { id, url: "https://example.test/", title: "Fixture" };
    };
    const resuming = env.send({ type: "resume", sessionId });
    await flush();
    if (change === "disconnect") env.ports[0].onDisconnect.fire();
    else await env.send({ type: "takeover", sessionId });
    release();
    assert.equal((await resuming).error.code, "cancelled");
    assert.equal(
      (await env.send({ type: "status" })).result.sessions.find(
        (session) => session.id === sessionId,
      ).state,
      change === "disconnect" ? "disconnected" : "taken_over",
    );
    assert.equal(env.commands.length, 0);
  }
});

test("browser-startup reset survives asynchronous worker initialization", async () => {
  let release;
  const initializationGate = new Promise((resolve) => {
    release = resolve;
  });
  const env = await setup({
    initializationGate,
    alarms: [
      {
        name: "lumi-browser-connect-paused",
        scheduledTime: Date.now() + 60000,
      },
    ],
  });
  chrome.runtime.onStartup.fire();
  assert.equal(env.attempts(), 0);
  release();
  await flush();
  assert.equal(env.attempts(), 1);
  assert.equal(env.attached.length, 0);
});
