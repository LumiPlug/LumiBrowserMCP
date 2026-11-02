import {
  installWebSocketMock,
  settleWebSocketMock,
} from "./helpers/websocket.mjs";
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
  await settleWebSocketMock();
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
      createTestPort() {
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
    permissions: {
      contains: async () => true,
      onAdded: event(),
      onRemoved: event(),
    },
    storage: {
      local: {
        setAccessLevel: async () => {},
        get: async () => ({ lumiAutoConsent: false }),
        set: async () => {},
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: {
      get: async (id) => ({
        id,
        url: "https://example.test/",
        title: "Fixture",
      }),
      query: async () => [],
      onCreated: event(),
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
  installWebSocketMock(() => chrome.runtime.createTestPort());
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
  await flush();
  state = (await env.send({ type: "status" })).result;
  assert.equal(state.connected, true);
  assert.equal(state.connecting, false);
  const published = env.ports[0].sent.length;
  env.ports[0].onMessage.fire({ type: "ready" });
  await flush();
  assert.equal(env.ports[0].sent.length, published);
  assert.equal(env.attached.length, 0);
});

test("disconnected Core is probed within its enrollment window without opening popup", async () => {
  const env = await setup({ fail: true });
  assert.equal(env.attempts(), 1);
  for (let i = 1; i <= 5; i++) {
    for (let j = 0; j < 3; j++) await env.send({ type: "status" });
    assert.equal(env.attempts(), i);
    assert.ok(
      env.scheduled.get(`lumi-browser-connect-${i}`).scheduledTime > Date.now(),
    );
    assert.ok(
      env.scheduled.get(`lumi-browser-connect-${i}`).scheduledTime <=
        Date.now() + 60000,
    );
    await env.fire(`lumi-browser-connect-${i}`);
  }
  assert.equal(env.attempts(), 6);
  assert.equal((await env.send({ type: "status" })).result.retry.paused, false);
  assert.ok(
    env.scheduled.get("lumi-browser-connect-paused").scheduledTime <=
      Date.now() + 60000,
  );
  await env.fire("lumi-browser-connect-paused");
  assert.equal(env.attempts(), 7);
  await env.send({ type: "status", probe: true });
  await flush();
  assert.equal(env.attempts(), 8);
  assert.ok(env.scheduled.has("lumi-browser-connect-1"));
  assert.equal(env.attached.length, 0);
});

test("MV3 restart respects an existing retry alarm and the low-frequency probe timer", async () => {
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
    false,
  );
  chrome.runtime.onStartup.fire();
  await flush();
  assert.equal(paused.attempts(), 1);
});

test("a Core without the application ready handshake times out safely through alarms", async () => {
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

test("late callbacks from an old secure connection cannot mark or break the new connection", async () => {
  const env = await setup();
  const first = env.ports[0];
  first.onMessage.fire({ type: "ready" });
  first.onDisconnect.fire();
  await flush();
  await env.fire("lumi-browser-connect-1");
  const second = env.ports[1];
  first.onMessage.fire({ type: "ready" });
  first.onDisconnect.fire();
  assert.equal((await env.send({ type: "status" })).result.connected, false);
  second.onMessage.fire({ type: "ready" });
  await flush();
  first.onDisconnect.fire();
  assert.equal((await env.send({ type: "status" })).result.connected, true);
  assert.equal(env.attached.length, 0);
});

test("upgrading long retry alarms clamps discovery to one minute", async () => {
  for (const name of [
    "lumi-browser-connect-paused",
    "lumi-browser-connect-4",
  ]) {
    const env = await setup({
      fail: true,
      alarms: [{ name, scheduledTime: Date.now() + 30 * 60000 }],
    });
    assert.equal(env.attempts(), 0);
    assert.ok(env.scheduled.get(name).scheduledTime <= Date.now() + 60000);
    await env.fire(name);
    assert.equal(env.attempts(), 1);
    assert.equal(
      env.attached.length,
      0,
      "A communication probe cannot authorize or enable Core",
    );
  }
});
