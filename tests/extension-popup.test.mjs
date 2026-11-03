import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizePolicyUrl } from "../extension/core.mjs";

// Synthetic popup-only DOM: these tests do not claim a real Chrome UI run.
async function popup({
  url = "https://example.test/orders?id=7#details",
  status: initialStatus = {},
  grant = true,
  actionError,
  actionGate,
  confirm = false,
} = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: "",
        disabled: false,
        hidden: false,
        dataset: {},
        listeners: new Map(),
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        },
        setAttribute(name, value) {
          this[name] = value;
        },
        classList: { add() {}, remove() {}, toggle() {} },
      });
    return elements.get(id);
  };
  const status = {
    connected: true,
    connecting: false,
    policyReady: true,
    policyEpoch: 1,
    autoConsent: true,
    hostGranted: true,
    blockedUrls: [],
    tabHolds: {},
    sessions: [{ id: "session-7", tabId: 7, state: "active" }],
    ...initialStatus,
  };
  const messages = [],
    permissionRequests = [],
    calls = [];
  const intervals = [];
  const tab = { id: 7, url, title: "Synthetic page" };
  const chrome = {
    tabs: { query: async () => [{ ...tab }] },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        calls.push(message.type);
        if (message.type === "status")
          return { result: structuredClone(status) };
        if (actionGate) await actionGate;
        if (actionError) return { error: { message: actionError } };
        if (message.type === "set_page_allowed") {
          const target = normalizePolicyUrl(message.url);
          status.blockedUrls = message.allowed
            ? status.blockedUrls.filter((value) => value !== target)
            : [...new Set([...status.blockedUrls, target])];
          if (message.allowed) {
            status.autoConsent = true;
            status.hostGranted = true;
          }
        }
        return { result: structuredClone(status) };
      },
    },
    permissions: {
      async request(options) {
        calls.push("permissions.request");
        permissionRequests.push(options);
        return grant;
      },
    },
  };
  const document = {
    getElementById: element,
    querySelectorAll: () => [...elements.values()],
  };
  const confirmations = [];
  const window = {
    addEventListener() {},
    confirm(message) {
      confirmations.push(message);
      return confirm;
    },
  };
  const source = (
    await readFile(new URL("../extension/popup.js", import.meta.url), "utf8")
  ).replace(/^import \{ normalizePolicyUrl \} from "\.\/core\.mjs";\s*/, "");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(
    "chrome",
    "document",
    "window",
    "normalizePolicyUrl",
    "setInterval",
    "clearInterval",
    source,
  )(
    chrome,
    document,
    window,
    normalizePolicyUrl,
    (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    () => {},
  );
  return {
    status,
    messages,
    permissionRequests,
    confirmations,
    calls,
    element,
    tab,
    async click() {
      const toggle = element("toggle");
      assert.equal(
        toggle.disabled,
        false,
        "action must be enabled before click",
      );
      await toggle.listeners.get("click")();
    },
    async poll() {
      for (const fn of intervals) await fn();
    },
  };
}

test("popup only offers current-page policy action and uses Lumi theme tokens", async () => {
  const html = await readFile(
    new URL("../extension/popup.html", import.meta.url),
    "utf8",
  );
  const css = await readFile(
    new URL("../extension/popup.css", import.meta.url),
    "utf8",
  );
  assert.match(html, /id="toggle"/);
  assert.match(html, /id="connection"/);
  assert.doesNotMatch(
    html,
    /<details|<textarea|<select|id="(?:run|reconnect|sessions|authorize)"/,
  );
  assert.match(css, /#0e0e11/i);
  assert.match(css, /#f59e0b/i);
});

test("disconnected or unsupported pages cannot change rules", async () => {
  for (const options of [
    { status: { connected: false } },
    { status: { policyReady: false } },
    { url: "chrome://extensions" },
    { url: "file:///tmp/orders.html" },
    { url: "https://user:secret@example.test/orders" },
  ]) {
    const ui = await popup(options);
    assert.equal(ui.element("toggle").disabled, true);
    assert.equal(ui.permissionRequests.length, 0);
    assert.ok(ui.messages.every((message) => message.type === "status"));
  }
});

test("allowed page can be blocked without requesting additional Chrome permissions", async () => {
  const ui = await popup();
  assert.match(ui.element("toggle").textContent, /禁止/);
  await ui.click();
  const action = ui.messages.find(
    (message) => message.type === "set_page_allowed",
  );
  assert.equal(action.tabId, 7);
  assert.equal(normalizePolicyUrl(action.url), "https://example.test/orders");
  assert.equal(action.allowed, false);
  assert.equal(ui.permissionRequests.length, 0);
  assert.match(ui.element("toggle").textContent, /允许/);
});

test("blocked page can be explicitly allowed and waits for the Core response", async () => {
  const ui = await popup({
    status: { blockedUrls: ["https://example.test/orders"] },
  });
  assert.match(ui.element("toggle").textContent, /允许/);
  await ui.click();
  const action = ui.messages.find(
    (message) => message.type === "set_page_allowed",
  );
  assert.equal(action.allowed, true);
  assert.match(ui.element("toggle").textContent, /禁止/);
});

test("missing required Chrome permission is not presented as a per-page allow rule", async () => {
  const ui = await popup({ status: { autoConsent: true, hostGranted: false } });
  assert.equal(ui.element("toggle").disabled, true);
  assert.match(ui.element("toggle").textContent, /Chrome.*权限/);
  await ui.element("toggle").listeners.get("click")();
  assert.equal(ui.permissionRequests.length, 0);
  assert.equal(
    ui.messages.some(
      (message) =>
        message.type === "set_page_allowed" || message.type === "enable_auto",
    ),
    false,
  );
});

test("ordinary permitted page defaults to block action without an allow click", async () => {
  const ui = await popup({
    status: { autoConsent: true, hostGranted: true, blockedUrls: [] },
  });
  assert.equal(ui.element("toggle").textContent, "禁止此页");
  assert.equal(ui.element("toggle").disabled, false);
  assert.equal(
    ui.messages.every((message) => message.type === "status"),
    true,
  );
  assert.equal(ui.permissionRequests.length, 0);
});

test("Core failure is shown without optimistic policy success", async () => {
  const ui = await popup({ actionError: "Lumi connection closed" });
  await ui.click();
  assert.match(ui.element("error").textContent, /Lumi connection closed/);
  assert.match(ui.element("toggle").textContent, /禁止/);
  assert.deepEqual(ui.status.blockedUrls, []);
});

test("pending Core operation disables repeat clicks and does not claim completion", async () => {
  let release;
  const actionGate = new Promise((resolve) => {
    release = resolve;
  });
  const ui = await popup({ actionGate });
  const pending = ui.click();
  assert.equal(ui.element("toggle").disabled, true);
  assert.match(ui.element("toggle").textContent, /禁止/);
  await ui.element("toggle").listeners.get("click")();
  assert.equal(
    ui.messages.filter((m) => m.type === "set_page_allowed").length,
    1,
  );
  release();
  await pending;
  assert.match(ui.element("toggle").textContent, /允许/);
});

test("popup polling refreshes active-tab URL rather than mutating an obsolete page", async () => {
  const ui = await popup();
  ui.tab.url = "https://example.test/new-path?ignored=1#fragment";
  await ui.poll();
  await ui.click();
  const action = ui.messages.find((m) => m.type === "set_page_allowed");
  assert.equal(action.url, "https://example.test/new-path");
});

test("held current tab offers explicit allow rather than silently clearing a takeover", async () => {
  const ui = await popup({ status: { tabHolds: { 7: "taken_over" } } });
  assert.match(ui.element("toggle").textContent, /允许/);
  assert.match(ui.element("connection").textContent, /接管/);
  assert.ok(ui.messages.every((m) => m.type === "status"));
});

test("legacy pairing status never displays a code or confirmation UI", async () => {
  for (const connected of [false, true]) {
    for (const pairingConfirmed of [false, true]) {
      const ui = await popup({
        status: {
          connected,
          policyReady: connected,
          pairingId: "legacy-pair",
          pairingCode: "482917",
          pairingConfirmed,
        },
      });
      assert.doesNotMatch(
        ui.element("connection").textContent,
        /482917|配对码|核对/,
      );
      assert.doesNotMatch(
        ui.element("toggle").textContent,
        /确认配对|等待 Lumi 确认/,
      );
      assert.equal(ui.element("toggle").disabled, !connected);
      assert.equal(ui.permissionRequests.length, 0);
      assert.ok(ui.messages.every((message) => message.type === "status"));
      await ui.poll();
      assert.ok(ui.messages.every((message) => message.type === "status"));
    }
  }
});

test("popup source does not retain the removed pairing confirmation API", async () => {
  const source = await readFile(
    new URL("../extension/popup.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /confirm_pairing|pairingCode|pairingConfirmed|pairingId/,
  );
});

test("connected status does not expose credential reset even with a stale error", async () => {
  const ui = await popup({
    status: { connected: true, transportError: "请重新配对" },
    confirm: true,
  });
  assert.notEqual(ui.element("toggle").textContent, "重新配对");
  await ui.click();
  assert.equal(ui.confirmations.length, 0);
  assert.equal(
    ui.messages.some((message) => message.type === "reset_pairing"),
    false,
  );
});

test("ordinary disconnected status does not expose reset or silently clear credentials", async () => {
  const ui = await popup({
    status: {
      connected: false,
      policyReady: false,
      transportError: "Lumi 未连接",
    },
    confirm: true,
  });
  assert.notEqual(ui.element("toggle").textContent, "重新配对");
  assert.equal(ui.element("toggle").disabled, true);
  assert.equal(ui.confirmations.length, 0);
  assert.ok(ui.messages.every((message) => message.type === "status"));
});

test("internal safety pause is not misreported as missing Chrome permission", async () => {
  const ui = await popup({
    status: { autoConsent: false, hostGranted: true, blockedUrls: [] },
  });
  assert.match(ui.element("connection").textContent, /页面控制已暂停/);
  assert.doesNotMatch(ui.element("connection").textContent, /Chrome.*权限/);
  assert.equal(ui.element("toggle").textContent, "恢复页面控制");
  assert.equal(ui.element("toggle").disabled, false);
});
