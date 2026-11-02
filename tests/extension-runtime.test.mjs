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
    if (args[0]?.type === "request") args[0] = { policyEpoch: 1, ...args[0] };
    this.listeners.forEach((f) => f(...args));
  },
});
let tab = { id: 7, url: "https://example.org/", title: "Fixture" };
const commands = [];
let failCommand = null;
let failPage = null;
let largeResult = false;
const port = {
  onMessage: event(),
  onDisconnect: event(),
  sent: [],
  postMessage(m) {
    this.sent.push(m);
  },
};
globalThis.chrome = {
  runtime: {
    createTestPort() {
      return port;
    },
    id: "test",
    getURL: (p) => "chrome-extension://test/" + p,
    onMessage: event(),
    onStartup: event(),
    onInstalled: event(),
  },
  alarms: {
    getAll: async () => [],
    create: async () => {},
    clear: async () => true,
    onAlarm: event(),
  },
  permissions: {
    contains: async () => true,
    onAdded: event(),
    onRemoved: event(),
  },
  storage: {
    local: {
      setAccessLevel: async () => {},
      get: async () => ({ lumiAutoConsent: true }),
      set: async () => {},
    },
    session: { get: async () => ({}), set: async () => {} },
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  tabs: {
    get: async (id) => ({ ...tab, id }),
    query: async () => [{ ...tab }],
    onCreated: event(),
    onRemoved: event(),
    onUpdated: event(),
  },
  webNavigation: { onCommitted: event() },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    onDetach: event(),
    sendCommand: async (target, method, params) => {
      commands.push({ target, method, params });
      if (failCommand?.(method, params)) throw new Error("CDP lost");
      return {};
    },
  },
  scripting: {
    executeScript: async ({ args: [op] }) => [
      {
        result:
          largeResult && op === "snapshot"
            ? { text: "中".repeat(400000) }
            : failPage?.(op)
              ? { error: { code: "stale_ref", message: "Target changed" } }
              : op === "prepare" || op === "verify"
                ? { x: 150.5, y: 99.25 }
                : op === "check_focus"
                  ? { focused: true }
                  : op === "wait_check"
                    ? { matched: false }
                    : { ok: true },
      },
    ],
  },
};
const wsMock = installWebSocketMock(() => chrome.runtime.createTestPort());
await import("../extension/background.js");
await settleWebSocketMock();
await new Promise((resolve) => setTimeout(resolve, 0));
port.onMessage.fire({ type: "ready" });
port.onMessage.fire({ type: "policy", epoch: 1, blockedUrls: [] });
await settleWebSocketMock();
await new Promise((resolve) => setTimeout(resolve, 0));
const listener = chrome.runtime.onMessage.listeners[0];
async function waitForResponse(requestId) {
  const deadline = Date.now() + 2000;
  do {
    await settleWebSocketMock();
    const response = port.sent.find((message) => message.id === requestId);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for encrypted response ${requestId}`);
}
const rawSend = (message) =>
  new Promise((resolve) =>
    listener(
      message,
      { id: "test", url: "chrome-extension://test/popup.html" },
      resolve,
    ),
  );
let id;
const send = async (message) => {
  const result = await rawSend(message);
  if (message.type === "resume" && result.result)
    id =
      result.result.sessions.find(
        (session) => session.tabId === 7 && session.state === "active",
      )?.id ?? id;
  return result;
};

test("extension runtime consent and CDP behavior", async (t) => {
  await t.test("reject page-origin messages", () => {
    let responded = false;
    assert.equal(
      listener(
        { type: "authorize", tabId: 7 },
        { id: "test", url: "https://example.org/" },
        () => (responded = true),
      ),
      undefined,
    );
    assert.equal(responded, false);
  });
  await t.test("accepted policy creates an allowed-page session", async () => {
    const r = (await send({ type: "status" })).result.sessions.find(
      (session) => session.tabId === 7,
    );
    assert.equal(r.state, "active");
    id = r.id;
  });
  await t.test(
    "click dispatches CSS pixels without tab activation",
    async () => {
      commands.length = 0;
      const r = await send({
        type: "command",
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      assert.equal(r.result.ok, true);
      assert.deepEqual(
        commands.map((c) => c.params.type),
        ["mouseMoved", "mousePressed", "mouseReleased"],
      );
      assert.ok(
        commands.every(
          (c) =>
            c.target.tabId === 7 &&
            c.params.x === 150.5 &&
            c.params.y === 99.25,
        ),
      );
    },
  );
  await t.test("Chinese fill uses CDP insertText", async () => {
    commands.length = 0;
    const r = await send({
      type: "command",
      tool: "fill",
      args: { sessionId: id, ref: "r", text: "你好，Lumi" },
    });
    assert.equal(r.result.ok, true);
    assert.deepEqual(commands.at(-1), {
      target: { tabId: 7 },
      method: "Input.insertText",
      params: { text: "你好，Lumi" },
    });
  });
  await t.test(
    "ambiguous input failure is outcome_unknown, no retry",
    async () => {
      commands.length = 0;
      failCommand = (_, p) => p.type === "mousePressed";
      const r = await send({
        type: "command",
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      assert.equal(r.error.code, "outcome_unknown");
      assert.equal(
        commands.filter((c) => c.params.type === "mousePressed").length,
        1,
      );
      failCommand = null;
    },
  );
  await t.test(
    "initial stale validation is not ambiguous, hover failure is",
    async () => {
      await send({ type: "resume", sessionId: id });
      failPage = (op) => op === "validate";
      let r = await send({
        type: "command",
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      assert.equal(r.error.code, "stale_ref");
      assert.equal(
        (await send({ type: "status" })).result.sessions[0].state,
        "active",
      );
      failPage = null;
      failCommand = (_, p) => p.type === "mouseMoved";
      r = await send({
        type: "command",
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      assert.equal(r.error.code, "outcome_unknown");
      assert.ok(r.error.details.possiblePageEvents.includes("hover"));
      assert.equal(
        (await send({ type: "status" })).result.sessions[0].state,
        "paused",
      );
      failCommand = null;
      await send({ type: "resume", sessionId: id });
      let verifies = 0;
      failPage = (op) => op === "verify" && ++verifies === 2;
      r = await send({
        type: "command",
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      assert.equal(r.error.code, "outcome_unknown");
      assert.equal(r.error.details.cause.code, "stale_ref");
      failPage = null;
      await send({ type: "resume", sessionId: id });
      failPage = (op) => op === "prepare";
      r = await send({
        type: "command",
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      assert.equal(r.error.code, "outcome_unknown");
      assert.ok(r.error.details.possiblePageEvents.includes("scroll"));
      failPage = null;
    },
  );
  await t.test("pause blocks work and resume allows it", async () => {
    await send({ type: "pause", sessionId: id });
    assert.equal(
      (
        await send({
          type: "command",
          tool: "snapshot",
          args: { sessionId: id },
        })
      ).error.code,
      "cancelled",
    );
    await send({ type: "resume", sessionId: id });
    assert.equal(
      (
        await send({
          type: "command",
          tool: "snapshot",
          args: { sessionId: id },
        })
      ).result.ok,
      true,
    );
  });
  await t.test(
    "secure Core route exposes only tools and publishes sessions",
    async () => {
      await settleWebSocketMock();
      assert.ok(
        port.sent.some(
          (m) => m.type === "sessions" && m.sessions.some((s) => s.id === id),
        ),
      );
      port.onMessage.fire({
        type: "request",
        id: "n1",
        tool: "snapshot",
        args: { sessionId: id },
      });
      await settleWebSocketMock();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(port.sent.find((m) => m.id === "n1").result.ok, true);
      port.onMessage.fire({
        type: "request",
        id: "n2",
        tool: "authorize",
        args: { tabId: 9 },
      });
      await settleWebSocketMock();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        port.sent.find((m) => m.id === "n2").error.code,
        "unknown_tool",
      );
    },
  );
  await t.test(
    "secure Core duplicate IDs never overwrite or replay an accepted click",
    async () => {
      commands.length = 0;
      const message = {
        type: "request",
        id: "one-click",
        tool: "click",
        args: { sessionId: id, ref: "r" },
      };
      port.onMessage.fire(message);
      port.onMessage.fire(message);
      await settleWebSocketMock();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        commands.filter((c) => c.params.type === "mousePressed").length,
        1,
      );
      assert.ok(
        port.sent.some(
          (m) => m.id === "one-click" && m.error?.code === "duplicate_request",
        ),
      );
      assert.ok(port.sent.some((m) => m.id === "one-click" && m.result?.ok));
      port.onMessage.fire(message);
      await settleWebSocketMock();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        commands.filter((c) => c.params.type === "mousePressed").length,
        1,
      );
      assert.equal(
        port.sent.filter(
          (m) => m.id === "one-click" && m.error?.code === "duplicate_request",
        ).length,
        2,
      );
    },
  );
  await t.test(
    "secure Core malformed arguments are rejected before dispatch",
    async () => {
      commands.length = 0;
      for (const [suffix, args] of [
        ["array", []],
        ["null", null],
        ["numeric", { sessionId: id, deltaY: "500" }],
        ["extra", { sessionId: id, arbitrary: true }],
      ]) {
        port.onMessage.fire({
          type: "request",
          id: "bad-" + suffix,
          tool: "scroll",
          args,
        });
        await settleWebSocketMock();
        assert.equal(
          port.sent.find((m) => m.id === "bad-" + suffix).error.code,
          "invalid_argument",
        );
      }
      const before = port.sent.length;
      port.onMessage.fire({
        type: "request",
        id: "x".repeat(129),
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      port.onMessage.fire({
        type: "request",
        id: 123,
        tool: "click",
        args: { sessionId: id, ref: "r" },
      });
      await settleWebSocketMock();
      assert.equal(port.sent.length, before);
      assert.equal(commands.length, 0);
    },
  );
  await t.test(
    "secure Core response guard replaces oversized output with a bounded error",
    async () => {
      largeResult = true;
      port.onMessage.fire({
        type: "request",
        id: "large-response",
        tool: "snapshot",
        args: { sessionId: id },
      });
      await settleWebSocketMock();
      await new Promise((r) => setTimeout(r, 10));
      largeResult = false;
      const response = port.sent.find((m) => m.id === "large-response");
      assert.equal(response.error.code, "response_too_large");
      assert.ok(
        new TextEncoder().encode(JSON.stringify(response)).length < 1024,
      );
    },
  );
  await t.test(
    "secure Core cancel stops pending request and only its session",
    async () => {
      chrome.tabs.onCreated.fire({ ...tab, id: 8 });
      await settleWebSocketMock();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const other = (await send({ type: "status" })).result.sessions.find(
        (session) => session.tabId === 8,
      ).id;
      commands.length = 0;
      port.onMessage.fire({
        type: "request",
        id: "cancel-me",
        tool: "wait_for",
        args: { sessionId: id, text: "never appears", timeoutMs: 3000 },
      });
      await settleWebSocketMock();
      assert.equal(
        port.sent.some((m) => m.id === "cancel-me"),
        false,
      );
      port.onMessage.fire({ type: "cancel", id: "cancel-me" });
      await settleWebSocketMock();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        (await waitForResponse("cancel-me")).error.code,
        "cancelled",
      );
      assert.equal(commands.length, 0);
      const status = (await send({ type: "status" })).result;
      assert.equal(status.sessions.find((s) => s.id === id).state, "paused");
      assert.equal(status.sessions.find((s) => s.id === other).state, "active");
      await send({ type: "resume", sessionId: id });
    },
  );
  await t.test(
    "cross-origin navigation immediately revokes consent",
    async () => {
      tab.url = "https://other.example/";
      chrome.tabs.onUpdated.fire(7, { url: tab.url });
      await settleWebSocketMock();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const current = (await send({ type: "status" })).result.sessions.find(
        (session) => session.tabId === 7,
      );
      assert.notEqual(current.id, id);
      assert.equal(current.origin, "https://other.example");
      assert.equal(
        (
          await send({
            type: "command",
            tool: "click",
            args: { sessionId: id, ref: "r" },
          })
        ).error.code,
        "unknown_session",
      );
    },
  );
  await t.test(
    "secure Core disconnection fails closed without reconnecting",
    async () => {
      port.onDisconnect.fire();
      const status = (await send({ type: "status" })).result;
      assert.equal(status.connected, false);
      assert.equal(
        status.sessions.find((s) => s.tabId === 8).state,
        "disconnected",
      );
      assert.match(status.transportError, /未连接/);
    },
  );
});
