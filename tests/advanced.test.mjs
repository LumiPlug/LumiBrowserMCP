// SPDX-License-Identifier: MPL-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { createAdvanced, scrub, safeUrl } from "../extension/advanced.mjs";
import { validateRemoteRequest } from "../extension/core.mjs";
const event = () => ({
  listeners: [],
  addListener(fn) {
    this.listeners.push(fn);
  },
  fire(...args) {
    for (const fn of this.listeners) fn(...args);
  },
});
function setup() {
  const s = {
    id: "s",
    tabId: 1,
    url: "https://example.test/page",
    state: "active",
    epoch: 0,
  };
  const sessions = new Map([["s", s]]),
    commands = [],
    pages = [],
    held = [];
  const frame = {
    frameId: 2,
    parentFrameId: 0,
    url: "https://frame.test/page",
    documentId: "doc",
  };
  const chrome = {
    debugger: { onEvent: event(), sendCommand: async () => ({}) },
    downloads: {
      onCreated: event(),
      download: async () => 42,
      search: async ({ id }) => [
        {
          id,
          url: "https://example.test/file",
          finalUrl: "https://example.test/file",
          state: "complete",
          filename: "/downloads/report.csv",
          bytesReceived: 3,
          totalBytes: 3,
          exists: true,
        },
      ],
    },
    permissions: { contains: async () => true },
    tabs: {
      get: async () => ({
        id: 1,
        windowId: 4,
        active: true,
        status: "complete",
        url: s.url,
        title: "Test",
        openerTabId: 3,
      }),
      query: async () => [],
    },
    windows: { get: async () => ({ focused: true }) },
    webNavigation: {
      getAllFrames: async () => [
        frame,
        { ...frame, frameId: 3, url: "chrome://settings/" },
      ],
      getFrame: async () => frame,
    },
    scripting: {
      executeScript: async () => [{ result: { text: "frame data" } }],
    },
  };
  globalThis.chrome = chrome;
  const replies = new Map([
    ["Page.getFrameTree", { frameTree: { frame: { id: "main" } } }],
    ["Page.createIsolatedWorld", { executionContextId: 1 }],
    [
      "Accessibility.getFullAXTree",
      {
        nodes: [
          {
            nodeId: "1",
            role: { value: "RootWebArea" },
            frameId: "main",
            childIds: ["2", "3"],
          },
          {
            nodeId: "2",
            role: { value: "button" },
            name: { value: "OK" },
            backendDOMNodeId: 7,
          },
          { nodeId: "3", role: { value: "Iframe" }, childIds: ["4"] },
          {
            nodeId: "4",
            role: { value: "button" },
            name: { value: "blocked secret" },
            backendDOMNodeId: 8,
          },
        ],
      },
    ],
    ["DOM.resolveNode", { object: { objectId: "obj" } }],
    ["Runtime.callFunctionOn", { result: { value: { dispatched: true } } }],
    ["Page.captureScreenshot", { data: btoa("\x89PNG\r\n\x1a\nfixture") }],
    ["Page.printToPDF", { data: btoa("%PDF-fixture") }],
    [
      "Network.getResponseBody",
      { body: '{"password":"secret","ok":"hello"}', base64Encoded: false },
    ],
  ]);
  const api = createAdvanced({
    sessions,
    guard: async () => {
      if (s.state !== "active") throw Error("paused");
    },
    allowedUrl: (u) => /^https?:/.test(u) && !u.includes("blocked"),
    holdTab: async () => held.push("paused"),
    cdp: async (_, e, m, p) => {
      commands.push([m, p]);
      if (
        m === "Input.dispatchMouseEvent" &&
        p.type === "mouseMoved" &&
        p.buttons === 1 &&
        replies.has("dragFixture")
      ) {
        chrome.debugger.onEvent.fire({ tabId: 1 }, "Input.dragIntercepted", {
          data: { items: [], dragOperationsMask: 1 },
        });
        return new Promise(() => {});
      }
      if (replies.get(m) instanceof Error) throw replies.get(m);
      return replies.get(m) || {};
    },
    page: async (_, op, args) => {
      pages.push([op, args]);
      if (op === "document_state") return { readyState: "complete" };
      if (op === "ref_state") return { visible: false, enabled: true };
      if (op === "capture_bounds")
        return { x: 0, y: 0, width: 100, height: 100, dpr: 1 };
      if (op === "viewport") return { width: 100, height: 100 };
      if (op === "prepare" || op === "verify") return { x: 10, y: 20 };
      if (op === "file_marker") return { marker: "marker" };
      return { rows: [[{ text: "A" }]] };
    },
  });
  return {
    api,
    s,
    sessions,
    chrome,
    frame,
    commands,
    pages,
    held,
    replies,
    run: (tool, args = {}) => api.run(tool, s, 0, { sessionId: "s", ...args }),
  };
}

test("advanced validator rejects unknown fields, arbitrary actions and unbounded payloads", () => {
  for (const [tool, args] of [
    ["emulate", { sessionId: "s", action: "set", width: 99999 }],
    ["frame_action", { sessionId: "s", frameToken: "f", action: "eval" }],
    ["upload_files", { sessionId: "s", ref: "r", paths: [] }],
    ["dialog", { sessionId: "s", action: "accept", script: "evil" }],
    ["drag", { sessionId: "s", sourceRef: "r", targetRef: "b", steps: 1000 }],
    ["response_body", { sessionId: "s", requestId: "id", maxBytes: 1000000 }],
  ])
    assert.throws(() => validateRemoteRequest({ tool, args }));
});
test("tab metadata and ready/hidden waits return actual observed state", async () => {
  const e = setup();
  assert.equal((await e.run("tab_info")).windowFocused, true);
  assert.equal(
    (await e.run("wait_state", { condition: "ready" })).matched,
    true,
  );
  assert.equal(
    (await e.run("wait_state", { condition: "hidden", ref: "r" })).matched,
    true,
  );
  await assert.rejects(
    e.run("wait_state", {
      condition: "url",
      url: "chrome://settings",
      timeoutMs: 1,
    }),
  );
});
test("frames exclude restricted URLs and reject document changes before reading", async () => {
  const e = setup();
  const { frames } = await e.run("list_frames");
  assert.equal(frames.length, 1);
  assert.equal(
    (
      await e.run("frame_action", {
        frameToken: frames[0].frameToken,
        action: "snapshot",
      })
    ).text,
    "frame data",
  );
  e.frame.documentId = "new";
  await assert.rejects(
    e.run("frame_action", {
      frameToken: frames[0].frameToken,
      action: "snapshot",
    }),
    { code: "stale_frame" },
  );
});
test("frame mutation failures never claim safe retry", async () => {
  const e = setup();
  const { frames } = await e.run("list_frames");
  e.chrome.scripting.executeScript = async () => {
    throw Error("lost response");
  };
  await assert.rejects(
    e.run("frame_action", {
      frameToken: frames[0].frameToken,
      action: "click",
      ref: "r",
    }),
    { code: "outcome_unknown" },
  );
  assert.equal(e.held.length, 1);
});
test("semantic tree excludes iframe subtree and expires old semantic refs", async () => {
  const e = setup();
  const result = await e.run("semantic_snapshot");
  assert.ok(!JSON.stringify(result).includes("blocked secret"));
  const ref = result.nodes.find((n) => n.name === "OK").ref;
  assert.equal(
    (await e.run("semantic_action", { ref, action: "click" })).dispatched,
    true,
  );
  await e.run("semantic_snapshot");
  await assert.rejects(e.run("semantic_action", { ref, action: "click" }), {
    code: "stale_ref",
  });
});
test("download reads only explicitly associated IDs and rejects traversal names", async () => {
  const e = setup();
  assert.deepEqual((await e.run("downloads")).downloads, []);
  await assert.rejects(
    e.run("download_start", {
      url: "https://example.test/file",
      filename: "../secret",
    }),
  );
  await e.run("download_start", {
    url: "https://example.test/file",
    filename: "report.csv",
  });
  assert.equal((await e.run("downloads")).downloads[0].state, "complete");
  assert.deepEqual(
    (await e.run("downloads", { downloadId: 999 })).downloads,
    [],
  );
});
test("download watch excludes unrelated referrers and blocked destinations", async () => {
  const e = setup();
  await e.run("download_watch");
  e.chrome.downloads.onCreated.fire({
    id: 4,
    url: "https://example.test/file",
    referrer: "https://other.test",
  });
  assert.equal((await e.run("downloads")).downloads.length, 0);
  e.chrome.downloads.onCreated.fire({
    id: 5,
    url: "https://example.test/file",
    referrer: e.s.url,
  });
  assert.equal((await e.run("downloads")).downloads[0].id, 5);
});
test("downloads are unavailable without Chrome permission", async () => {
  const e = setup();
  e.chrome.permissions.contains = async () => false;
  await assert.rejects(
    e.run("download_start", { url: "https://example.test" }),
    { code: "permission_required" },
  );
});
test("dialogs are observed and handled explicitly, not automatically", async () => {
  const e = setup();
  assert.equal((await e.run("dialog", { action: "read" })).dialog, null);
  e.chrome.debugger.onEvent.fire({ tabId: 1 }, "Page.javascriptDialogOpening", {
    type: "confirm",
    message: "Delete?",
    url: e.s.url,
  });
  assert.equal(
    (await e.run("dialog", { action: "read" })).dialog.type,
    "confirm",
  );
  assert.ok(!e.commands.length);
  await e.run("dialog", { action: "dismiss" });
  assert.deepEqual(e.commands.at(-1), [
    "Page.handleJavaScriptDialog",
    { accept: false, promptText: "" },
  ]);
});
test("diagnostics omit headers, request data and child-frame console; redact explicit bodies", async () => {
  const e = setup();
  await e.run("diagnostics", { action: "start" });
  const emit = (method, p) =>
    e.chrome.debugger.onEvent.fire({ tabId: 1 }, method, p);
  emit("Runtime.executionContextCreated", {
    context: { id: 2, auxData: { frameId: "child", isDefault: true } },
  });
  emit("Runtime.consoleAPICalled", {
    executionContextId: 2,
    args: [{ value: "secret child" }],
  });
  emit("Runtime.executionContextCreated", {
    context: { id: 1, auxData: { frameId: "main", isDefault: true } },
  });
  emit("Runtime.consoleAPICalled", {
    executionContextId: 1,
    args: [{ value: "token=secret" }],
  });
  emit("Network.requestWillBeSent", {
    requestId: "r",
    documentURL: e.s.url,
    request: {
      url: "https://example.test/data?token=secret",
      method: "GET",
      headers: { Authorization: "secret" },
      postData: "secret",
    },
  });
  emit("Network.responseReceived", {
    requestId: "r",
    response: {
      url: "https://example.test/data",
      status: 200,
      mimeType: "application/json",
    },
  });
  const result = JSON.stringify(await e.run("diagnostics", { action: "read" }));
  assert.ok(!result.includes("secret"));
  assert.ok(
    (await e.run("response_body", { requestId: "r" })).text.includes(
      "[redacted]",
    ),
  );
  await e.run("diagnostics", { action: "stop" });
  assert.equal((await e.run("diagnostics", { action: "read" })).enabled, false);
});
test("capture and PDF create bounded session-scoped chunks; wrong session rejected", async () => {
  const e = setup();
  const a = await e.run("capture_page", { mode: "full" });
  assert.equal(a.mimeType, "image/png");
  assert.equal(
    (await e.run("artifact_chunk", { artifactId: a.artifactId, offset: 0 }))
      .eof,
    true,
  );
  e.api.forget(e.s);
  await assert.rejects(
    e.run("artifact_chunk", { artifactId: a.artifactId, offset: 0 }),
  );
  const pdf = await e.run("export_pdf");
  assert.equal(pdf.mimeType, "application/pdf");
});
test("unsupported PDF is explicit and does not pause a session", async () => {
  const e = setup();
  e.replies.set("Page.printToPDF", Error("unsupported"));
  await assert.rejects(e.run("export_pdf"), { code: "unsupported" });
  assert.equal(e.held.length, 0);
});
test("drag emits bounded moves and paired release; emulation reset restores network", async () => {
  const e = setup();
  await e.run("drag", { sourceRef: "a", targetRef: "b", steps: 3 });
  assert.equal(
    e.commands.filter(
      (x) => x[0] === "Input.dispatchMouseEvent" && x[1].type === "mouseMoved",
    ).length,
    4,
  );
  assert.equal(e.commands.at(-1)[1].type, "mouseReleased");
  await e.run("emulate", { action: "reset" });
  assert.deepEqual(e.commands.at(-1), [
    "Network.emulateNetworkConditions",
    {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    },
  ]);
});
test("touch consumes a recent viewport capture once", async () => {
  const e = setup();
  e.s.capture = {
    captureId: "c",
    epoch: 0,
    created: Date.now(),
    viewport: { width: 100, height: 100 },
  };
  assert.equal(
    (await e.run("touch", { captureId: "c", x: 10, y: 10 })).dispatched,
    true,
  );
  await assert.rejects(e.run("touch", { captureId: "c", x: 10, y: 10 }), {
    code: "stale_capture",
  });
});
test("redaction removes common credentials and URL queries", () => {
  assert.equal(
    safeUrl("https://example.test/a?token=x#secret"),
    "https://example.test/a",
  );
  assert.deepEqual(
    scrub({ Authorization: "bearer x", nested: { password: "p", value: 2 } }),
    {
      Authorization: "[redacted]",
      nested: { password: "[redacted]", value: 2 },
    },
  );
});

test("new-tab wait filters opener locally using supported query properties", async () => {
  const e = setup();
  e.chrome.tabs.query = async (args) => {
    assert.deepEqual(args, {});
    return [
      { id: 2, openerTabId: 1, url: "https://example.test/child" },
      { id: 3, openerTabId: 8, url: "https://example.test/other" },
    ];
  };
  e.sessions.set("child", {
    id: "child",
    tabId: 2,
    state: "active",
    url: "https://example.test/child",
  });
  assert.equal(
    (await e.run("wait_state", { condition: "new_tab" })).sessions[0].sessionId,
    "child",
  );
});

test("native drag interception completes drop without awaiting blocked mouse movement", async () => {
  const e = setup();
  e.replies.set("dragFixture", true);
  assert.equal(
    (await e.run("drag", { sourceRef: "a", targetRef: "b" })).dispatched,
    true,
  );
  assert.deepEqual(
    e.commands
      .filter(([m]) => m === "Input.dispatchDragEvent")
      .map(([, p]) => p.type),
    ["dragEnter", "dragOver", "drop"],
  );
  assert.ok(
    e.commands.some(([m, p]) => m === "Input.setInterceptDrags" && p.enabled),
  );
});
test("noopener navigation targets remain bound to the creating session", async () => {
  const e = setup();
  e.s.childTabs = new Set([2]);
  e.sessions.set("child", {
    id: "child",
    tabId: 2,
    state: "active",
    url: "https://example.test/child",
  });
  e.chrome.tabs.query = async () => [
    { id: 2, url: "https://example.test/child" },
  ];
  assert.equal(
    (await e.run("wait_state", { condition: "new_tab" })).sessions[0].sessionId,
    "child",
  );
  e.api.forget(e.s);
  assert.equal(e.s.childTabs, null);
});
