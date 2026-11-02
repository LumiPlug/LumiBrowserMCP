import {
  LumiError,
  originOf,
  assertLive,
  enqueue,
  invalidate,
  validateNativeRequest,
} from "./core.mjs";
import { pageOperation } from "./page.js";

const sessions = new Map();
let nativePort = null;
let nativeReady = false;
let handshakeAlarm = null;
let transportEpoch = 0;
let transportError = "";
const nativeRequests = new Map();
const RETRY_PREFIX = "lumi-browser-connect-";
const RETRY_DELAYS_MINUTES = [1, 2, 5, 10, 30];
const EXHAUSTED_ALARM = `${RETRY_PREFIX}paused`;
let retryAttempt = 0;
let retryAt = null;
let retryPaused = false;
let retryAlarm = null;
let initialization;
let connecting;

// Alarm names retain the retry budget across MV3 worker suspension without
// storing page consent, refs, requests, or adding a storage permission.
function initializeTransport() {
  if (!initialization)
    initialization = chrome.alarms
      .getAll()
      .then((alarms) => {
        const paused = alarms.find((alarm) => alarm.name === EXHAUSTED_ALARM);
        if (paused) {
          retryPaused = true;
          retryAlarm = EXHAUSTED_ALARM;
          return;
        }
        const pending = alarms
          .filter((alarm) => /^lumi-browser-connect-[1-5]$/.test(alarm.name))
          .sort((a, b) => b.scheduledTime - a.scheduledTime)[0];
        if (pending) {
          retryAttempt = Number(pending.name.slice(RETRY_PREFIX.length));
          retryAt = pending.scheduledTime;
          retryAlarm = pending.name;
        }
      })
      .catch(() => {
        retryPaused = true;
        transportError = "无法读取连接重试状态，请手动重新连接 Lumi。";
      });
  return initialization;
}
async function clearRetryAlarms(expectedPort = null) {
  for (const alarm of await chrome.alarms.getAll()) {
    if (expectedPort && (nativePort !== expectedPort || !nativeReady)) return;
    if (alarm.name.startsWith(RETRY_PREFIX))
      await chrome.alarms.clear(alarm.name);
  }
}
function scheduleReconnect() {
  if (retryAttempt >= RETRY_DELAYS_MINUTES.length) {
    retryPaused = true;
    retryAt = null;
    retryAlarm = EXHAUSTED_ALARM;
    // One-off exhaustion marker, never a connection timer. Browser startup or
    // explicit retry resets it. Chrome may clear alarms; this is not permanent storage.
    void chrome.alarms
      .create(EXHAUSTED_ALARM, { when: Date.now() + 365 * 24 * 60 * 60 * 1000 })
      .catch(() => {});
    return;
  }
  retryAttempt++;
  retryAt = Date.now() + RETRY_DELAYS_MINUTES[retryAttempt - 1] * 60000;
  retryAlarm = `${RETRY_PREFIX}${retryAttempt}`;
  void chrome.alarms.create(retryAlarm, { when: retryAt }).catch(() => {
    retryPaused = true;
    retryAt = null;
  });
}
function transportFailed(reason) {
  transportEpoch++;
  nativePort = null;
  nativeReady = false;
  if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
  handshakeAlarm = null;
  transportError = reason;
  for (const id of nativeRequests.keys()) recentNativeIds.set(id, Date.now());
  nativeRequests.clear();
  pruneRecentIds();
  for (const session of sessions.values()) {
    if (["active", "paused"].includes(session.state))
      revoke(session, "disconnected");
  }
  scheduleReconnect();
  publish();
}
function ensureConnection({ resetBudget = false } = {}) {
  if (connecting) {
    // Lifecycle/manual reset requests must survive an in-progress MV3 restore.
    return resetBudget
      ? connecting.then(() => ensureConnection({ resetBudget: true }))
      : connecting;
  }
  connecting = (async () => {
    await initializeTransport();
    if (nativePort) return;
    if (resetBudget) {
      await clearRetryAlarms();
      retryAttempt = 0;
      retryAt = null;
      retryPaused = false;
      retryAlarm = null;
    }
    if (retryPaused || (retryAt !== null && retryAt > Date.now())) return;
    retryAt = null;
    retryAlarm = null;
    try {
      openNativePort();
    } catch (error) {
      transportFailed(
        error.message || "无法连接 Lumi，请检查 Browser User 设置。",
      );
    }
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}
function transportStatus() {
  return {
    sessions: list(),
    connected: nativeReady,
    connecting: !!nativePort && !nativeReady,
    transportError,
    retry: {
      attempt: retryAttempt,
      maxAttempts: RETRY_DELAYS_MINUTES.length,
      nextAttemptAt: retryAt,
      paused: retryPaused,
    },
  };
}

// Bounded per-worker replay protection, in addition to Lumi's UUID request IDs.
// A completed request is never executed twice, including after ambiguous input.
const recentNativeIds = new Map();
function pruneRecentIds() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, time] of recentNativeIds)
    if (time < cutoff) recentNativeIds.delete(id);
  while (recentNativeIds.size > 1024)
    recentNativeIds.delete(recentNativeIds.keys().next().value);
}
const describe = (s) => ({
  id: s.id,
  tabId: s.tabId,
  title: s.title.slice(0, 512),
  url: s.url.slice(0, 4096),
  origin: s.origin,
  state: s.state,
});
const list = () => [...sessions.values()].map(describe);
function postNative(port, message) {
  const encodedSize = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  if (encodedSize(message) > 900 * 1024) {
    if (message.type === "response") {
      message = {
        type: "response",
        id: message.id,
        error: {
          code: "response_too_large",
          message:
            "Browser response exceeds the safe native transport budget. Narrow the request.",
        },
      };
    } else if (message.type === "sessions") {
      const sessions = [];
      let bytes = 256;
      for (const session of message.sessions) {
        const size = encodedSize(session) + 1;
        if (bytes + size > 900 * 1024) break;
        sessions.push(session);
        bytes += size;
      }
      message = { type: "sessions", sessions, truncated: true };
    } else return;
  }
  port.postMessage(message);
}
function publish() {
  try {
    if (nativePort)
      postNative(nativePort, { type: "sessions", sessions: list() });
  } catch {}
  chrome.action.setBadgeText({
    text: [...sessions.values()].some((s) => s.state === "active") ? "ON" : "",
  });
  chrome.action.setBadgeBackgroundColor({ color: "#7955f5" });
}
function errorJSON(e) {
  return {
    code: e.code || "browser_error",
    message: e.message || String(e),
    ...(e.details ? { details: e.details } : {}),
  };
}
function openNativePort() {
  if (nativePort) return;
  const port = chrome.runtime.connectNative("com.lumiplug.browser");
  nativePort = port;
  nativeReady = false;
  handshakeAlarm = `lumi-browser-handshake-${crypto.randomUUID()}`;
  void chrome.alarms
    .create(handshakeAlarm, { when: Date.now() + 60000 })
    .catch(() => {});
  transportError = "";
  port.onMessage.addListener((message) => {
    if (nativePort !== port) return;
    if (message?.type === "ready") {
      if (nativeReady) return;
      nativeReady = true;
      retryAttempt = 0;
      retryAt = null;
      retryPaused = false;
      retryAlarm = null;
      void clearRetryAlarms(port).catch(() => {});
      transportError = "";
      if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
      handshakeAlarm = null;
      publish();
      return;
    }
    if (
      !nativeReady ||
      typeof message?.id !== "string" ||
      !message.id ||
      message.id.length > 128
    )
      return;
    if (message.type === "cancel") {
      const pending = nativeRequests.get(message.id);
      if (pending?.port === port && pending.session?.state === "active") {
        // The host authenticates client ownership. Only the request's bound
        // session is paused; no other tab/session is affected by cancellation.
        invalidate(pending.session, "paused");
        page(pending.session, "remove_overlay").catch(() => {});
        publish();
      }
      return;
    }
    if (message.type !== "request") return;
    pruneRecentIds();
    if (nativeRequests.has(message.id) || recentNativeIds.has(message.id)) {
      postNative(port, {
        type: "response",
        id: message.id,
        error: {
          code: "duplicate_request",
          message:
            "Request ID was already accepted; it will not be executed again.",
        },
      });
      return;
    }
    if (nativeRequests.size >= 128) {
      postNative(port, {
        type: "response",
        id: message.id,
        error: { code: "busy", message: "Too many pending browser requests." },
      });
      return;
    }
    let args;
    try {
      args = validateNativeRequest(message);
    } catch (error) {
      postNative(port, {
        type: "response",
        id: message.id,
        error: errorJSON(error),
      });
      return;
    }
    const pending = { port, session: sessions.get(args.sessionId) };
    nativeRequests.set(message.id, pending);
    handleRequest(message.tool, args)
      .then(
        (result) => {
          if (nativePort === port)
            postNative(port, { type: "response", id: message.id, result });
        },
        (error) => {
          if (nativePort === port)
            postNative(port, {
              type: "response",
              id: message.id,
              error: errorJSON(error),
            });
        },
      )
      .catch(() => {})
      .finally(() => {
        recentNativeIds.set(message.id, Date.now());
        pruneRecentIds();
        if (nativeRequests.get(message.id) === pending)
          nativeRequests.delete(message.id);
      });
  });
  port.onDisconnect.addListener(() => {
    // A late callback from an old port must never revoke a newer connection.
    if (nativePort !== port) return;
    const reason =
      chrome.runtime.lastError?.message ||
      "Lumi disconnected. Reconnect communication, then explicitly authorize tabs again.";
    transportFailed(reason);
  });
  publish();
}
async function page(s, operation, args = {}) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: s.tabId, frameIds: [0] },
    world: "ISOLATED",
    func: pageOperation,
    args: [operation, { ...args, expectedOrigin: s.origin }],
  });
  const value = results[0]?.result;
  if (!value)
    throw new LumiError(
      "page_unavailable",
      "The authorized page could not be read.",
    );
  if (value.error) throw new LumiError(value.error.code, value.error.message);
  return value;
}
async function guard(s, epoch) {
  assertLive(s, epoch);
  const tab = await chrome.tabs.get(s.tabId);
  if (originOf(tab.url) !== s.origin) {
    revoke(s, "origin_changed");
    throw new LumiError(
      "origin_changed",
      "New origin needs explicit authorization.",
    );
  }
  assertLive(s, epoch);
}
async function cdp(s, epoch, method, params) {
  await guard(s, epoch);
  return chrome.debugger.sendCommand({ tabId: s.tabId }, method, params);
}
function revoke(s, state = "revoked") {
  invalidate(s, state);
  page(s, "remove_overlay").catch(() => {});
  chrome.debugger.detach({ tabId: s.tabId }).catch(() => {});
  publish();
}
async function authorize(tabId) {
  const consentEpoch = transportEpoch;
  const tab = await chrome.tabs.get(tabId);
  const origin = originOf(tab.url);
  for (const old of sessions.values())
    if (old.tabId === tabId) {
      invalidate(old, "revoked");
      await chrome.debugger.detach({ tabId }).catch(() => {});
      sessions.delete(old.id);
    }
  await chrome.debugger.attach({ tabId }, "1.3");
  const current = await chrome.tabs.get(tabId);
  if (originOf(current.url) !== origin) {
    await chrome.debugger.detach({ tabId });
    throw new LumiError(
      "origin_changed",
      "Page navigated during authorization; authorize again.",
    );
  }
  if (consentEpoch !== transportEpoch) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw new LumiError(
      "cancelled",
      "Connection changed during authorization; authorize again.",
    );
  }
  const s = {
    id: crypto.randomUUID(),
    tabId,
    title: current.title || "",
    url: current.url,
    origin,
    state: "active",
    epoch: 0,
    queue: Promise.resolve(),
  };
  sessions.set(s.id, s);
  try {
    await page(s, "snapshot");
    if (consentEpoch !== transportEpoch || s.state !== "active")
      throw new LumiError(
        "cancelled",
        "Connection changed during authorization; authorize again.",
      );
    publish();
    return describe(s);
  } catch (e) {
    revoke(s);
    throw e;
  }
}
async function handleRequest(tool, args) {
  if (tool === "list_sessions") return { sessions: list() };
  if (
    !["snapshot", "read_text", "click", "fill", "scroll", "wait_for"].includes(
      tool,
    )
  )
    throw new LumiError("unknown_tool", "Unsupported browser tool.");
  const s = sessions.get(args.sessionId);
  if (!s)
    throw new LumiError(
      "unknown_session",
      "Authorize a tab from the Lumi extension popup first.",
    );
  return enqueue(s, async (epoch) => {
    await guard(s, epoch);
    if (tool === "snapshot" || tool === "read_text") return page(s, tool, args);
    if (tool === "wait_for") {
      if (!args.ref && (typeof args.text !== "string" || !args.text.length))
        throw new LumiError(
          "invalid_argument",
          "wait_for requires ref or nonempty text.",
        );
      if (args.state && !["visible", "hidden"].includes(args.state))
        throw new LumiError(
          "invalid_argument",
          "state must be visible or hidden.",
        );
      const timeout = Math.min(
        30000,
        Math.max(0, Number(args.timeoutMs ?? 5000)),
      );
      if (!Number.isFinite(timeout))
        throw new LumiError("invalid_argument", "timeoutMs must be finite.");
      const deadline = Date.now() + timeout;
      do {
        await guard(s, epoch);
        if ((await page(s, "wait_check", args)).matched)
          return { matched: true };
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (true);
      throw new LumiError(
        "timeout",
        "Requested page condition did not appear before timeout.",
      );
    }
    if (tool !== "scroll" && typeof args.ref !== "string")
      throw new LumiError(
        "invalid_argument",
        "A current snapshot ref is required.",
      );
    if (
      tool === "fill" &&
      (typeof args.text !== "string" || args.text.length > 100000)
    )
      throw new LumiError(
        "invalid_argument",
        "fill.text must be a string of at most 100000 characters.",
      );
    const deltaX = Number(args.deltaX ?? 0),
      deltaY = Number(args.deltaY ?? 500);
    if (
      tool === "scroll" &&
      (![deltaX, deltaY].every(Number.isFinite) ||
        Math.abs(deltaX) > 10000 ||
        Math.abs(deltaY) > 10000)
    )
      throw new LumiError(
        "invalid_argument",
        "Scroll deltas must be finite and at most 10000 CSS pixels.",
      );
    let emitted = false;
    try {
      await page(s, "validate", { ...args, action: tool });
      await guard(s, epoch);
      // scrollIntoView may fire page scroll handlers even before a click.
      if (args.ref) emitted = true;
      const point = await page(s, "prepare", { ...args, action: tool });
      await guard(s, epoch);
      await page(s, "cursor", point);
      await page(s, "verify", { ...args, ...point, action: tool });
      // Hover itself can trigger application actions; do not treat it as inert.
      emitted = true;
      await cdp(s, epoch, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await page(s, "verify", { ...args, ...point, action: tool });
      await guard(s, epoch);
      // Once a mutating CDP command is sent, a transport error may mean it executed.
      // Never retry it automatically. The next call must be an observation.
      emitted = true;
      if (tool === "scroll") {
        await cdp(s, epoch, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...point,
          deltaX,
          deltaY,
        });
      } else {
        await cdp(s, epoch, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          clickCount: 1,
        });
        await cdp(s, epoch, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...point,
          button: "left",
          clickCount: 1,
        });
        if (tool === "fill") {
          await guard(s, epoch);
          if (!(await page(s, "check_focus", args)).focused)
            throw new LumiError(
              "focus_changed",
              "The target did not retain keyboard focus.",
            );
          await cdp(s, epoch, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Unidentified",
            commands: ["selectAll"],
          });
          await cdp(s, epoch, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Unidentified",
          });
          await guard(s, epoch);
          if (!(await page(s, "check_focus", args)).focused)
            throw new LumiError(
              "focus_changed",
              "Keyboard focus changed before text insertion.",
            );
          if (args.text === "") {
            await cdp(s, epoch, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Backspace",
              code: "Backspace",
              windowsVirtualKeyCode: 8,
            });
            await cdp(s, epoch, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Backspace",
              code: "Backspace",
              windowsVirtualKeyCode: 8,
            });
          } else await cdp(s, epoch, "Input.insertText", { text: args.text });
        }
      }
      assertLive(s, epoch);
      return {
        ok: true,
        dispatched: true,
        point,
        note: "Input dispatched; inspect a fresh snapshot to confirm the page outcome.",
      };
    } catch (e) {
      if (emitted) {
        if (s.state === "active") {
          invalidate(s, "paused");
          publish();
        }
        throw new LumiError(
          "outcome_unknown",
          "Input may have executed. Session paused; inspect the page, then explicitly resume. Never retry automatically.",
          {
            cause: errorJSON(e),
            possiblePageEvents: ["scroll", "hover", "input"],
          },
        );
      }
      throw e;
    }
  });
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own popup may change consent; page content cannot invoke these controls.
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("popup.html")
  )
    return;
  (async () => {
    if (message.type === "status") {
      await ensureConnection();
      return transportStatus();
    }
    if (message.type === "reconnect") {
      await ensureConnection({ resetBudget: true });
      return transportStatus();
    }
    if (message.type === "command")
      return handleRequest(message.tool, message.args || {});
    if (message.type === "authorize") return authorize(message.tabId);
    const s = sessions.get(message.sessionId);
    if (!s) throw new LumiError("unknown_session", "Session no longer exists.");
    if (message.type === "pause") {
      invalidate(s, "paused");
      await page(s, "remove_overlay").catch(() => {});
    } else if (message.type === "resume") {
      if (s.state !== "paused")
        throw new LumiError(
          "reauthorize_required",
          "Authorize this tab again to restore control.",
        );
      const resumeEpoch = s.epoch;
      const tab = await chrome.tabs.get(s.tabId);
      if (s.state !== "paused" || s.epoch !== resumeEpoch)
        throw new LumiError(
          "cancelled",
          "Session changed while resuming; authorize again.",
        );
      if (originOf(tab.url) !== s.origin) {
        revoke(s, "origin_changed");
        throw new LumiError("origin_changed", "Authorize the new origin.");
      }
      invalidate(s, "active");
    } else if (message.type === "takeover" || message.type === "disconnect")
      revoke(s, message.type === "takeover" ? "taken_over" : "disconnected");
    else throw new LumiError("invalid_operation", "Unsupported popup action.");
    publish();
    return { sessions: list() };
  })().then(
    (result) => respond({ result }),
    (error) => respond({ error: errorJSON(error) }),
  );
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const s of sessions.values())
    if (s.tabId === tabId) {
      invalidate(s, "closed");
      publish();
    }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  for (const s of sessions.values())
    if (s.tabId === tabId) {
      if (change.url) {
        s.url = change.url;
        try {
          if (originOf(change.url) !== s.origin) revoke(s, "origin_changed");
        } catch {
          revoke(s, "restricted_page");
        }
      }
      if (change.title) s.title = change.title;
    }
  if (change.url || change.title) publish();
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  for (const s of sessions.values())
    if (s.tabId === details.tabId) {
      // Every full navigation cancels actions already queued in the old document.
      s.epoch++;
      try {
        if (originOf(details.url) !== s.origin) revoke(s, "origin_changed");
      } catch {
        revoke(s, "restricted_page");
      }
      s.url = details.url;
    }
  publish();
});
chrome.debugger.onDetach.addListener((source) => {
  for (const s of sessions.values())
    if (s.tabId === source.tabId && ["active", "paused"].includes(s.state)) {
      invalidate(s, "detached");
      page(s, "remove_overlay").catch(() => {});
    }
  publish();
});

// Reconnecting restores only the communication channel. No tab is attached,
// authorized, resumed, or replayed by any of these lifecycle paths.
chrome.runtime.onStartup.addListener(() => {
  void ensureConnection({ resetBudget: true });
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureConnection({ resetBudget: true });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    await initializeTransport();
    if (alarm.name === handshakeAlarm && nativePort && !nativeReady) {
      const timedOutPort = nativePort;
      transportFailed(
        "Lumi connection handshake timed out. Check Browser User settings.",
      );
      timedOutPort.disconnect();
      return;
    }
    if (alarm.name === EXHAUSTED_ALARM) return;
    if (nativePort || retryPaused || alarm.name !== retryAlarm) return;
    retryAt = null;
    retryAlarm = null;
    await ensureConnection();
  })();
});
void ensureConnection();
