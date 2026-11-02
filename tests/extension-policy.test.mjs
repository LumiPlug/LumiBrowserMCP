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
async function flush() {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
}
const normalTab = (id, url = "https://example.test/orders") => ({
  id,
  url,
  title: `Synthetic tab ${id}`,
});
function storageArea(data) {
  return {
    async get(keys) {
      if (typeof keys === "string") return { [keys]: data[keys] };
      if (Array.isArray(keys))
        return Object.fromEntries(keys.map((key) => [key, data[key]]));
      return { ...(keys || {}), ...data };
    },
    async set(value) {
      Object.assign(data, structuredClone(value));
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys)
        delete data[key];
    },
  };
}
async function setup({
  tabs = [normalTab(1)],
  granted = true,
  consent = true,
  localData,
  sessionData = {},
} = {}) {
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const local = localData || { lumiAutoConsent: consent };
  const ports = [],
    attached = [],
    detached = [],
    commands = [],
    pageOps = [];
  const alarms = new Map();
  let permissionsGranted = granted;
  const chromeMock = {
    runtime: {
      id: "test",
      getURL: (file) => `chrome-extension://test/${file}`,
      onMessage: event(),
      onStartup: event(),
      onInstalled: event(),
      connectNative(name) {
        assert.equal(name, "com.lumiplug.browser");
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
        return port;
      },
    },
    permissions: {
      contains: async () => permissionsGranted,
      onAdded: event(),
      onRemoved: event(),
    },
    storage: {
      local: storageArea(local),
      session: storageArea(sessionData),
      onChanged: event(),
    },
    alarms: {
      onAlarm: event(),
      getAll: async () => [...alarms.values()],
      create: async (name, info) => {
        alarms.set(name, { name, scheduledTime: info.when });
      },
      clear: async (name) => alarms.delete(name),
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: {
      query: async () => [...tabMap.values()].map((tab) => ({ ...tab })),
      get: async (id) => {
        if (!tabMap.has(id)) throw new Error("Tab closed");
        return { ...tabMap.get(id) };
      },
      onCreated: event(),
      onRemoved: event(),
      onUpdated: event(),
    },
    webNavigation: { onCommitted: event(), onBeforeNavigate: event() },
    debugger: {
      onDetach: event(),
      attach: async (target) => attached.push({ ...target }),
      detach: async (target) => detached.push({ ...target }),
      sendCommand: async (...args) => {
        commands.push(args);
        return {};
      },
    },
    scripting: {
      executeScript: async ({ target, args: [op] }) => {
        pageOps.push({ tabId: target.tabId, op });
        return [
          {
            result:
              op === "prepare" || op === "verify"
                ? { x: 20, y: 30 }
                : op === "wait_check"
                  ? { matched: false }
                  : op === "snapshot"
                    ? {
                        url: tabMap.get(target.tabId)?.url,
                        text: "Synthetic page",
                        controls: [],
                      }
                    : { ok: true },
          },
        ];
      },
    },
  };
  globalThis.chrome = chromeMock;
  await import(`../extension/background.js?policy-test=${crypto.randomUUID()}`);
  await flush();
  const listener = chromeMock.runtime.onMessage.listeners[0];
  const send = (message) =>
    new Promise((resolve) =>
      listener(
        message,
        { id: "test", url: "chrome-extension://test/popup.html" },
        resolve,
      ),
    );
  const status = async () => (await send({ type: "status" })).result;
  return {
    chrome: chromeMock,
    tabMap,
    ports,
    attached,
    detached,
    commands,
    pageOps,
    local,
    sessionData,
    send,
    status,
    active: async () =>
      (await status()).sessions.filter((session) => session.state === "active"),
    async ready(epoch = 1, blockedUrls = []) {
      const port = ports.at(-1);
      assert.ok(port, "Native connection opened");
      port.onMessage.fire({ type: "ready" });
      port.onMessage.fire({ type: "policy", epoch, blockedUrls });
      await flush();
      return port;
    },
    async policy(epoch, blockedUrls) {
      ports.at(-1).onMessage.fire({ type: "policy", epoch, blockedUrls });
      await flush();
    },
    async navigate(tabId, url) {
      tabMap.get(tabId).url = url;
      chromeMock.tabs.onUpdated.fire(tabId, { url }, { ...tabMap.get(tabId) });
      chromeMock.webNavigation.onCommitted.fire({ tabId, frameId: 0, url });
      await flush();
    },
    async grant(value) {
      permissionsGranted = value;
      (value
        ? chromeMock.permissions.onAdded
        : chromeMock.permissions.onRemoved
      ).fire({ origins: ["http://*/*", "https://*/*"] });
      await flush();
    },
    async nativeRequest(tool, args, policyEpoch = 1) {
      const id = crypto.randomUUID(),
        port = ports.at(-1);
      port.onMessage.fire({ type: "request", id, tool, args, policyEpoch });
      await flush();
      return port.sent.find(
        (message) => message.type === "response" && message.id === id,
      );
    },
  };
}

test("all-web automation waits for ready, policy, browser permission and explicit persisted consent", async () => {
  const env = await setup();
  assert.equal(env.attached.length, 0);
  env.ports[0].onMessage.fire({ type: "policy", epoch: 1, blockedUrls: [] });
  await flush();
  assert.equal(
    env.attached.length,
    0,
    "Policy sent before ready must not authorize tabs",
  );
  env.ports[0].onMessage.fire({ type: "ready" });
  await flush();
  assert.equal(env.attached.length, 0, "Ready alone must not authorize tabs");
  await env.policy(1, []);
  assert.deepEqual(
    (await env.active()).map((session) => session.tabId),
    [1],
  );
  const noConsent = await setup({ consent: false });
  await noConsent.ready();
  assert.equal(noConsent.attached.length, 0);
  await noConsent.send({ type: "enable_auto" });
  await flush();
  assert.equal(noConsent.local.lumiAutoConsent, true);
  assert.deepEqual(
    (await noConsent.active()).map((session) => session.tabId),
    [1],
  );
  const noPermission = await setup({ granted: false });
  await noPermission.ready();
  assert.equal(noPermission.attached.length, 0);
  assert.ok((await noPermission.send({ type: "enable_auto" })).error);
  assert.equal(noPermission.attached.length, 0);
});

test("policy blocks query and fragment variants, distinguishes trailing slash, and excludes privileged or credential URLs", async () => {
  const env = await setup({
    tabs: [
      normalTab(1, "https://example.test/orders?secret=1#part"),
      normalTab(2, "https://example.test/orders/"),
      normalTab(3, "http://example.test/orders"),
      normalTab(4, "chrome://settings"),
      normalTab(5, "file:///tmp/private"),
      normalTab(6, "https://user:password@example.test/open"),
    ],
  });
  await env.ready(1, ["https://example.test/orders"]);
  assert.deepEqual(
    (await env.active()).map((session) => session.tabId).sort(),
    [2, 3],
  );
  assert.ok(env.attached.every((target) => [2, 3].includes(target.tabId)));
});

test("policy update cancels pending work immediately and removes matching links from active sessions", async () => {
  const env = await setup();
  const port = await env.ready();
  const original = (await env.active())[0];
  assert.ok(original);
  port.onMessage.fire({
    type: "request",
    id: "queued-click",
    tool: "click",
    args: { sessionId: original.id, ref: "old-ref" },
    policyEpoch: 1,
  });
  port.onMessage.fire({
    type: "policy",
    epoch: 2,
    blockedUrls: ["https://example.test/orders"],
  });
  await flush();
  assert.equal(env.commands.length, 0);
  assert.equal((await env.active()).length, 0);
  assert.ok(env.detached.some((target) => target.tabId === 1));
  const response = port.sent.find(
    (message) => message.id === "queued-click" && message.type === "response",
  );
  assert.ok(
    response?.error,
    "A cancelled queued mutation must not report success",
  );
});

test("navigation to a blocked link stops access and allowed cross-origin navigation creates a fresh session", async () => {
  const env = await setup();
  await env.ready(1, ["https://example.test/blocked"]);
  const original = (await env.active())[0];
  await env.navigate(1, "https://example.test/blocked?x=1#ignored");
  assert.equal((await env.active()).length, 0);
  const denied = await env.nativeRequest("read_text", {
    sessionId: original.id,
  });
  assert.ok(denied?.error);
  await env.navigate(1, "https://other.test/allowed");
  const next = (await env.active())[0];
  assert.ok(next);
  assert.notEqual(next.id, original.id);
  assert.equal(next.origin, "https://other.test");
  assert.ok(
    (
      await env.nativeRequest("click", {
        sessionId: original.id,
        ref: "old-ref",
      })
    )?.error,
  );
  assert.equal(env.commands.length, 0);
});

test("request policy epochs must match and every read rechecks the current tab URL", async () => {
  const env = await setup();
  await env.ready(3, ["https://example.test/blocked"]);
  const session = (await env.active())[0];
  const before = env.pageOps.length;
  const stale = await env.nativeRequest(
    "read_text",
    { sessionId: session.id },
    2,
  );
  assert.ok(stale?.error);
  assert.equal(env.pageOps.length, before);
  // Simulate navigation before webNavigation/onUpdated delivery.
  env.tabMap.get(1).url = "https://example.test/blocked?changed=1";
  const blocked = await env.nativeRequest(
    "read_text",
    { sessionId: session.id },
    3,
  );
  assert.ok(blocked?.error);
  assert.equal(env.pageOps.filter((op) => op.op === "read_text").length, 0);
});

test("pause and takeover persist across worker reload and navigation until explicit per-tab resume", async () => {
  const env = await setup({ tabs: [normalTab(1), normalTab(2)] });
  await env.ready();
  const sessions = await env.active();
  await env.send({
    type: "pause",
    sessionId: sessions.find((session) => session.tabId === 1).id,
  });
  await env.send({
    type: "takeover",
    sessionId: sessions.find((session) => session.tabId === 2).id,
  });
  assert.equal(env.sessionData.lumiTabHolds?.["1"], "paused");
  assert.equal(env.sessionData.lumiTabHolds?.["2"], "taken_over");
  await env.navigate(1, "https://other.test/new");
  assert.equal((await env.active()).length, 0);
  const restored = await setup({
    tabs: [normalTab(1, "https://other.test/new"), normalTab(2)],
    localData: env.local,
    sessionData: env.sessionData,
  });
  await restored.ready();
  assert.equal(restored.attached.length, 0);
  await restored.send({ type: "resume_tab", tabId: 1 });
  await flush();
  assert.deepEqual(
    (await restored.active()).map((session) => session.tabId),
    [1],
  );
  assert.equal(restored.sessionData.lumiTabHolds?.["1"], undefined);
  assert.equal(restored.sessionData.lumiTabHolds?.["2"], "taken_over");
  restored.tabMap.delete(2);
  restored.chrome.tabs.onRemoved.fire(2);
  await flush();
  assert.equal(restored.sessionData.lumiTabHolds?.["2"], undefined);
});

test("reconnect requires fresh policy and recreates only allowed tabs without replaying queued actions", async () => {
  const env = await setup({ tabs: [normalTab(1), normalTab(2)] });
  const old = await env.ready();
  const sessions = await env.active(),
    first = sessions.find((session) => session.tabId === 1),
    second = sessions.find((session) => session.tabId === 2);
  await env.send({ type: "takeover", sessionId: second.id });
  old.onMessage.fire({
    type: "request",
    id: "lost-click",
    tool: "click",
    args: { sessionId: first.id, ref: "old-ref" },
    policyEpoch: 1,
  });
  old.onDisconnect.fire();
  await flush();
  assert.equal((await env.active()).length, 0);
  assert.equal(env.commands.length, 0);
  await env.send({ type: "reconnect" });
  await flush();
  const freshPort = env.ports.at(-1);
  freshPort.onMessage.fire({ type: "ready" });
  await flush();
  assert.equal(
    (await env.active()).length,
    0,
    "Reconnect ready alone is insufficient",
  );
  old.onMessage.fire({ type: "policy", epoch: 99, blockedUrls: [] });
  await flush();
  assert.equal((await env.active()).length, 0, "Old port policy must be inert");
  await env.policy(1, []);
  const active = await env.active();
  assert.deepEqual(
    active.map((session) => session.tabId),
    [1],
  );
  assert.notEqual(active[0].id, first.id);
  assert.equal(env.commands.length, 0);
});

test("browser host permission removal immediately stops existing access", async () => {
  const env = await setup();
  await env.ready();
  const session = (await env.active())[0];
  await env.grant(false);
  assert.equal((await env.active()).length, 0);
  assert.ok(
    (
      await env.nativeRequest("click", {
        sessionId: session.id,
        ref: "old-ref",
      })
    )?.error,
  );
  assert.equal(env.commands.length, 0);
});

test("a read already in flight cannot return page data after the policy blocks its URL", async () => {
  const env = await setup();
  const port = await env.ready();
  const session = (await env.active())[0];
  const original = env.chrome.scripting.executeScript;
  let release,
    entered = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  env.chrome.scripting.executeScript = async (request) => {
    if (request.args[0] !== "read_text") return original(request);
    entered = true;
    await gate;
    return [
      {
        result: { text: "Private page data must not escape after revocation" },
      },
    ];
  };
  port.onMessage.fire({
    type: "request",
    id: "late-read",
    tool: "read_text",
    args: { sessionId: session.id },
    policyEpoch: 1,
  });
  await flush();
  assert.equal(entered, true);
  await env.policy(2, ["https://example.test/orders"]);
  release();
  await flush();
  const response = port.sent.find(
    (message) => message.type === "response" && message.id === "late-read",
  );
  assert.ok(
    response?.error,
    "Revoked in-flight reads must fail rather than returning old page data",
  );
  assert.equal(response.result, undefined);
});

test("a newer policy is reconciled after an older pending tab lookup finishes", async () => {
  const env = await setup();
  const get = env.chrome.tabs.get;
  let release,
    entered = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  env.chrome.tabs.get = async (id) => {
    if (!entered) {
      entered = true;
      await gate;
    }
    return get(id);
  };
  await env.ready(1, []);
  assert.equal(entered, true);
  await env.policy(2, []);
  release();
  await flush();
  assert.deepEqual(
    (await env.active()).map((session) => session.tabId),
    [1],
  );
  assert.equal((await env.status()).policyEpoch, 2);
});

test("explicit pause or takeover wins while a policy refresh is attaching a replacement session", async () => {
  for (const action of ["pause", "takeover"]) {
    const env = await setup();
    await env.ready();
    const previous = (await env.active())[0];
    const attach = env.chrome.debugger.attach;
    let release,
      entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    env.chrome.debugger.attach = async (...args) => {
      entered = true;
      await attach(...args);
      await gate;
    };
    await env.policy(2, []);
    assert.equal(entered, true);
    const result = await env.send({
      type: action,
      tabId: 1,
      sessionId: previous.id,
    });
    assert.equal(result.error, undefined);
    release();
    await flush();
    assert.equal((await env.active()).length, 0);
    assert.equal(
      env.sessionData.lumiTabHolds?.["1"],
      action === "pause" ? "paused" : "taken_over",
    );
    assert.equal(env.commands.length, 0);
  }
});

test("malformed policies fail closed and a removed legacy authorize route cannot bypass consent", async () => {
  for (const invalid of [
    { epoch: 0, blockedUrls: [] },
    { epoch: Number.MAX_SAFE_INTEGER + 1, blockedUrls: [] },
    {
      epoch: 2,
      blockedUrls: Array.from(
        { length: 101 },
        (_, i) => `https://example.test/${i}`,
      ),
    },
    { epoch: 2, blockedUrls: ["https://example.test/" + "a".repeat(2048)] },
    { epoch: 2, blockedUrls: ["https://user:password@example.test/"] },
    { epoch: 1, blockedUrls: ["https://example.test/changed-at-same-epoch"] },
  ]) {
    const env = await setup();
    const port = await env.ready();
    port.onMessage.fire({ type: "policy", ...invalid });
    await flush();
    assert.equal((await env.status()).policyReady, false);
    assert.equal((await env.active()).length, 0);
    assert.ok((await env.send({ type: "authorize", tabId: 1 })).error);
  }
});

test("automatic attachments cap at 200 and a closed connected tab frees a slot", async () => {
  const env = await setup({
    tabs: Array.from({ length: 201 }, (_, i) =>
      normalTab(i + 1, `https://example.test/page/${i + 1}`),
    ),
  });
  const port = await env.ready();
  assert.equal((await env.active()).length, 200);
  assert.equal(env.attached.length, 200);
  assert.equal((await env.status()).sessionLimit, 200);
  assert.equal((await env.status()).limitReached, true);
  assert.ok(
    port.sent
      .filter((message) => message.type === "sessions")
      .every((message) => message.sessions.length <= 200),
  );
  env.tabMap.delete(1);
  env.chrome.tabs.onRemoved.fire(1);
  await flush();
  assert.equal((await env.active()).length, 200);
  assert.ok((await env.active()).some((session) => session.tabId === 201));
});

test("UTF-8-truncated session publications retain the current policy epoch", async () => {
  const tabs = Array.from({ length: 200 }, (_, i) => ({
    ...normalTab(i + 1, `https://example.test/page/${i}?q=${"x".repeat(5000)}`),
    title: "标题".repeat(300),
  }));
  const env = await setup({ tabs });
  const port = await env.ready(7);
  const publications = port.sent.filter(
    (message) => message.type === "sessions" && message.truncated,
  );
  assert.ok(publications.length > 0);
  for (const message of publications) {
    assert.equal(message.policyEpoch, 7);
    assert.ok(message.sessions.length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 900 * 1024);
  }
  assert.equal((await env.status()).publicationTruncated, true);
});

test("late intentional detach does not hold a replacement session but real user detach does", async () => {
  const env = await setup();
  await env.ready();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const detach = env.chrome.debugger.detach;
  env.chrome.debugger.detach = async (target) => {
    await detach(target);
    await gate;
  };
  env.tabMap.get(1).url = "https://another.test/page";
  env.chrome.tabs.onUpdated.fire(1, { url: env.tabMap.get(1).url });
  await flush();
  assert.equal(env.attached.length, 1, "Replacement must wait for old detach");
  release();
  await flush();
  assert.equal(env.attached.length, 2);
  const replacement = (await env.active())[0];
  env.chrome.debugger.getTargets = async () => [{ tabId: 1, attached: true }];
  env.chrome.debugger.onDetach.fire({ tabId: 1 });
  await flush();
  assert.equal((await env.active())[0].id, replacement.id);
  env.chrome.debugger.onDetach.fire({ tabId: 1 }, "canceled_by_user");
  await flush();
  assert.equal((await env.active()).length, 0);
  assert.equal(env.sessionData.lumiTabHolds["1"], "taken_over");
  await env.navigate(1, "https://another.test/next");
  assert.equal((await env.active()).length, 0);
});

test("permission revocation wins even if an in-flight permission check later resolves true", async () => {
  const env = await setup();
  const port = await env.ready();
  const session = (await env.active())[0];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  env.chrome.permissions.contains = async () => {
    await gate;
    return true;
  };
  port.onMessage.fire({
    type: "request",
    id: "permission-race",
    policyEpoch: 1,
    tool: "click",
    args: { sessionId: session.id, ref: "r" },
  });
  await flush();
  env.chrome.permissions.onRemoved.fire({ origins: ["https://*/*"] });
  release();
  await flush();
  assert.equal(env.commands.length, 0);
  assert.ok(
    port.sent.find((message) => message.id === "permission-race").error,
  );
});
