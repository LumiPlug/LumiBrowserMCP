import {
  LumiError,
  originOf,
  normalizePolicyUrl,
  assertLive,
  enqueue,
  invalidate,
  validateRemoteRequest,
} from "./core.mjs";
import { pageOperation } from "./page.js";
import { createCorePort, resetCorePairing } from "./transport.mjs";
let resettingPairing = false;

const sessions = new Map();
let corePort = null;
let coreReady = false;
let handshakeAlarm = null;
let transportEpoch = 0;
let transportError = "";
const remoteRequests = new Map();
const pagePolicyRequests = new Map();
function policyRpc(type, args) {
  if (!corePort || !coreReady || !policy)
    return Promise.reject(
      new LumiError("not_connected", "Lumi 未连接，无法同步此页规则。"),
    );
  if (pagePolicyRequests.size >= 8)
    return Promise.reject(new LumiError("busy", "请等待正在同步的规则。"));
  const port = corePort,
    id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pagePolicyRequests.delete(id);
      reject(
        new LumiError(
          "policy_timeout",
          "Lumi 未确认规则，请检查连接；不会自动重试此次修改。",
        ),
      );
    }, 20000);
    const finish = (error, result) => {
      clearTimeout(timer);
      pagePolicyRequests.delete(id);
      if (error)
        reject(
          new LumiError(
            error.code || "policy_error",
            error.message || "规则同步失败。",
          ),
        );
      else resolve(result);
    };
    pagePolicyRequests.set(id, { port, type: `${type}_result`, finish });
    try {
      postCore(port, { type, id, ...args });
    } catch (error) {
      finish(error);
    }
  });
}
async function setPageAllowed(message) {
  if (
    !Number.isInteger(message.tabId) ||
    typeof message.allowed !== "boolean" ||
    typeof message.url !== "string"
  )
    throw new LumiError("invalid_argument", "无效的页面规则。");
  const url = normalizePolicyUrl(message.url);
  if (url.length > 2048)
    throw new LumiError("invalid_argument", "页面链接过长。");
  const current = await chrome.tabs.get(message.tabId);
  if (normalizePolicyUrl(current.url) !== url)
    throw new LumiError("navigation_changed", "页面已变化，请重新打开扩展。");
  if (!coreReady || !policy)
    throw new LumiError("not_connected", "Lumi 未连接。");
  const port = corePort,
    epoch = policy.epoch,
    holdRevision = holdRevisions.get(message.tabId) || 0;
  if (!message.allowed) await holdTabId(message.tabId, "taken_over");
  if (
    message.allowed &&
    !(await chrome.permissions.contains({ origins: HOST_ORIGINS }))
  )
    throw new LumiError("permission_required", "请先确认 Chrome 网站权限。");
  const stillCurrent = async () => {
    const tab = await chrome.tabs.get(message.tabId);
    if (
      corePort !== port ||
      !coreReady ||
      policy?.epoch !== epoch ||
      normalizePolicyUrl(tab.url) !== url
    )
      throw new LumiError("policy_changed", "页面或连接已变化，请重新操作。");
  };
  await stillCurrent();
  const context = await policyRpc("page_context", {
    tabId: message.tabId,
    url,
    title: (current.title || "").slice(0, 1024),
    policyEpoch: epoch,
  });
  if (
    !context ||
    typeof context.contextId !== "string" ||
    context.contextId.length > 128 ||
    !context.contextId ||
    context.url !== url ||
    context.policyEpoch !== epoch
  )
    throw new LumiError("invalid_context", "Lumi 返回了无效页面上下文。");
  await stillCurrent();
  const permission = message.allowed ? "allow" : "block";
  const result = await policyRpc("page_rule", {
    contextId: context.contextId,
    permission,
    policyEpoch: epoch,
  });
  if (
    corePort !== port ||
    !coreReady ||
    !result ||
    result.url !== url ||
    result.permission !== permission ||
    result.policyEpoch !== policy?.epoch ||
    policy.blocked.has(url) === message.allowed
  )
    throw new LumiError(
      "policy_not_synced",
      "Lumi 尚未确认此页规则，未报告成功。",
    );
  if (message.allowed) {
    if (normalizePolicyUrl((await chrome.tabs.get(message.tabId)).url) !== url)
      throw new LumiError(
        "navigation_changed",
        "页面已变化；规则已同步，当前页面未恢复。",
      );
    if (
      corePort !== port ||
      !coreReady ||
      result.policyEpoch !== policy?.epoch ||
      !(await chrome.permissions.contains({ origins: HOST_ORIGINS }))
    )
      throw new LumiError("permission_required", "连接或网站权限已变化。");
    await chrome.storage.local.set({ lumiAutoConsent: true });
    // Consent alone cannot bypass a closed Core or its current policy.
    if (
      corePort !== port ||
      !coreReady ||
      result.policyEpoch !== policy?.epoch ||
      (holdRevisions.get(message.tabId) || 0) !== holdRevision
    )
      throw new LumiError(
        "policy_changed",
        "连接或接管状态已变化；规则已同步，页面未恢复。",
      );
    autoConsent = true;
    hostGranted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
    if (
      !hostGranted ||
      corePort !== port ||
      !coreReady ||
      result.policyEpoch !== policy?.epoch ||
      (holdRevisions.get(message.tabId) || 0) !== holdRevision
    )
      throw new LumiError(
        "permission_required",
        "连接、接管或网站权限已变化。",
      );
    tabHolds.delete(message.tabId);
    await persistHolds();
    await reconcileAll();
  }
  return transportStatus();
}
const HOST_ORIGINS = ["http://*/*", "https://*/*"];
let autoConsent = false;
let hostGranted = false;
let authorityInitialized;
let storageTrusted = false;
let policy = null;
const tabHolds = new Map();
const holdRevisions = new Map();
const reconciling = new Map();
const reconcileAgain = new Set();
const SESSION_LIMIT = 200;
const attachmentSlots = new Set();
const detaching = new Map();
const expectedDetach = new Set();
let limitReached = false;
let publicationTruncated = false;
function detachTab(tabId) {
  if (detaching.has(tabId)) return detaching.get(tabId);
  expectedDetach.add(tabId);
  const pending = chrome.debugger
    .detach({ tabId })
    .catch(() => {})
    .finally(() => detaching.delete(tabId));
  detaching.set(tabId, pending);
  return pending;
}
function initializeAuthority() {
  if (!authorityInitialized)
    authorityInitialized = (async () => {
      await chrome.storage.local.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
      storageTrusted = true;
      const [local, session] = await Promise.all([
        chrome.storage.local.get("lumiAutoConsent"),
        chrome.storage.session.get("lumiTabHolds"),
      ]);
      autoConsent = local.lumiAutoConsent === true;
      for (const [id, state] of Object.entries(session.lumiTabHolds || {})) {
        if (/^\d+$/.test(id) && ["paused", "taken_over"].includes(state))
          tabHolds.set(Number(id), state);
      }
      hostGranted = await chrome.permissions.contains({
        origins: HOST_ORIGINS,
      });
    })().catch(() => {
      autoConsent = false;
      hostGranted = false;
    });
  return authorityInitialized;
}
function allowedUrl(url) {
  try {
    return !!policy && !policy.blocked.has(normalizePolicyUrl(url));
  } catch {
    return false;
  }
}
function canAutoControl() {
  return autoConsent && hostGranted && coreReady && !!policy;
}
async function persistHolds() {
  try {
    await chrome.storage.session.set({
      lumiTabHolds: Object.fromEntries(tabHolds),
    });
  } catch (error) {
    autoConsent = false;
    for (const s of sessions.values())
      if (s.state === "active") revoke(s, "permission_required");
    await chrome.storage.local.set({ lumiAutoConsent: false }).catch(() => {});
    throw error;
  }
}
function holdTabId(tabId, state) {
  holdRevisions.set(tabId, (holdRevisions.get(tabId) || 0) + 1);
  tabHolds.set(tabId, state);
  for (const s of sessions.values()) if (s.tabId === tabId) revoke(s, state);
  return persistHolds();
}
function holdTab(s, state) {
  return holdTabId(s.tabId, state);
}
function rejectPolicy() {
  policy = null;
  for (const s of sessions.values())
    if (s.state === "active") revoke(s, "policy_required");
  publish();
}
function acceptPolicy(message) {
  if (
    !Number.isSafeInteger(message.epoch) ||
    message.epoch < 1 ||
    !Array.isArray(message.blockedUrls) ||
    message.blockedUrls.length > 100
  ) {
    rejectPolicy();
    return;
  }
  let blocked;
  try {
    blocked = new Set(
      message.blockedUrls.map((url) => {
        if (typeof url !== "string" || url.length > 2048)
          throw Error("invalid policy URL");
        return normalizePolicyUrl(url);
      }),
    );
  } catch {
    rejectPolicy();
    return;
  }
  if (policy && message.epoch < policy.epoch) return;
  if (policy && message.epoch === policy.epoch) {
    if (
      blocked.size !== policy.blocked.size ||
      [...blocked].some((url) => !policy.blocked.has(url))
    )
      rejectPolicy();
    return;
  }
  policy = { epoch: message.epoch, blocked };
  // Synchronously cancel every old-policy operation before any async tab lookup.
  for (const s of sessions.values()) {
    if (s.state === "active")
      revoke(s, allowedUrl(s.url) ? "policy_changed" : "blocked");
  }
  publish();
  void reconcileAll();
}
async function reconcileAll() {
  await initializeAuthority();
  if (!canAutoControl()) return;
  const tabs = await chrome.tabs.query({ url: HOST_ORIGINS });
  limitReached =
    tabs.filter((tab) => allowedUrl(tab.url) && !tabHolds.has(tab.id)).length >
    SESSION_LIMIT;
  await Promise.all(tabs.map((tab) => reconcileTab(tab.id)));
}
function reconcileTab(tabId) {
  if (!Number.isInteger(tabId)) return Promise.resolve();
  if (reconciling.has(tabId)) {
    reconcileAgain.add(tabId);
    return reconciling.get(tabId);
  }
  const operation = (async () => {
    do {
      reconcileAgain.delete(tabId);
      await initializeAuthority();
      if (!canAutoControl() || tabHolds.has(tabId)) return;
      const expectedPolicy = policy.epoch;
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return;
      }
      if (
        !canAutoControl() ||
        policy.epoch !== expectedPolicy ||
        tabHolds.has(tabId)
      )
        return;
      if (!allowedUrl(tab.url)) {
        for (const s of sessions.values())
          if (s.tabId === tabId && s.state === "active") revoke(s, "blocked");
        return;
      }
      const existing = [...sessions.values()].find(
        (s) =>
          s.tabId === tabId &&
          s.state === "active" &&
          s.policyEpoch === expectedPolicy &&
          s.url === tab.url,
      );
      if (!existing) {
        if (
          !attachmentSlots.has(tabId) &&
          attachmentSlots.size >= SESSION_LIMIT
        ) {
          limitReached = true;
          return;
        }
        attachmentSlots.add(tabId);
        try {
          await attachAllowedTab(tabId);
        } catch {
          /* Restricted Chrome pages and lost races remain fail-closed. */
        } finally {
          if (
            ![...sessions.values()].some(
              (s) => s.tabId === tabId && s.state === "active",
            )
          )
            attachmentSlots.delete(tabId);
        }
      }
    } while (reconcileAgain.has(tabId));
  })().finally(() => {
    const again = reconcileAgain.has(tabId);
    reconciling.delete(tabId);
    reconcileAgain.delete(tabId);
    if (again) void reconcileTab(tabId);
  });
  reconciling.set(tabId, operation);
  return operation;
}

const RETRY_PREFIX = "lumi-browser-connect-";
// Chrome 118 alarms have a one-minute floor. Keep discovery inside Core's
// 120-second explicit enrollment window; probing never launches/enables Core.
const RETRY_DELAYS_MINUTES = [1, 1, 1, 1, 1];
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
      .then(async (alarms) => {
        const paused = alarms.find((alarm) => alarm.name === EXHAUSTED_ALARM);
        if (paused) {
          retryPaused = false;
          retryAttempt = RETRY_DELAYS_MINUTES.length;
          retryAt = Math.min(paused.scheduledTime, Date.now() + 60000);
          if (retryAt < paused.scheduledTime)
            await chrome.alarms.create(paused.name, { when: retryAt });
          retryAlarm = EXHAUSTED_ALARM;
          return;
        }
        const pending = alarms
          .filter((alarm) => /^lumi-browser-connect-[1-5]$/.test(alarm.name))
          .sort((a, b) => b.scheduledTime - a.scheduledTime)[0];
        if (pending) {
          retryAttempt = Number(pending.name.slice(RETRY_PREFIX.length));
          retryAt = Math.min(pending.scheduledTime, Date.now() + 60000);
          if (retryAt < pending.scheduledTime)
            await chrome.alarms.create(pending.name, { when: retryAt });
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
    if (expectedPort && (corePort !== expectedPort || !coreReady)) return;
    if (alarm.name.startsWith(RETRY_PREFIX))
      await chrome.alarms.clear(alarm.name);
  }
}
function scheduleReconnect() {
  if (retryAttempt >= RETRY_DELAYS_MINUTES.length) {
    retryPaused = false;
    retryAt = Date.now() + 60000;
    retryAlarm = EXHAUSTED_ALARM;
    // Keep one-minute discovery after the initial attempts, without process spawn.
    // This never enables Core, restores refs or authorizes a page.
    void chrome.alarms
      .create(EXHAUSTED_ALARM, { when: retryAt })
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
  for (const request of [...pagePolicyRequests.values()])
    request.finish({
      code: "disconnected",
      message: "Lumi 连接已断开，规则未确认。",
    });
  policy = null;
  transportEpoch++;
  corePort = null;
  coreReady = false;
  if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
  handshakeAlarm = null;
  transportError = reason;
  for (const id of remoteRequests.keys()) recentRequestIds.set(id, Date.now());
  remoteRequests.clear();
  pruneRecentIds();
  for (const session of sessions.values()) {
    if (["active", "paused"].includes(session.state))
      revoke(session, tabHolds.get(session.tabId) || "disconnected");
  }
  scheduleReconnect();
  publish();
}
function ensureConnection({ resetBudget = false } = {}) {
  if (resettingPairing) return Promise.resolve();
  if (connecting) {
    // Lifecycle/manual reset requests must survive an in-progress MV3 restore.
    return resetBudget
      ? connecting.then(() => ensureConnection({ resetBudget: true }))
      : connecting;
  }
  connecting = (async () => {
    await Promise.all([initializeTransport(), initializeAuthority()]);
    if (!storageTrusted) {
      transportError = "无法保护本地连接凭据，连接已停止。";
      return;
    }
    if (corePort) return;
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
      openCorePort();
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
    sessions: localList(),
    autoConsent,
    hostGranted,
    policyReady: !!policy,
    policyEpoch: policy?.epoch ?? null,
    blockedUrls: policy ? [...policy.blocked] : [],
    tabHolds: Object.fromEntries(tabHolds),
    sessionLimit: SESSION_LIMIT,
    limitReached,
    publicationTruncated,
    connected: coreReady,
    connecting: !!corePort && !coreReady,
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
const recentRequestIds = new Map();
function pruneRecentIds() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, time] of recentRequestIds)
    if (time < cutoff) recentRequestIds.delete(id);
  while (recentRequestIds.size > 1024)
    recentRequestIds.delete(recentRequestIds.keys().next().value);
}
const describe = (s) => ({
  id: s.id,
  tabId: s.tabId,
  title: s.title.slice(0, 512),
  url: s.url.slice(0, 4096),
  origin: s.origin,
  state: s.state,
});
const list = () =>
  !canAutoControl()
    ? []
    : [...sessions.values()]
        .filter(
          (s) =>
            s.state === "active" &&
            s.policyEpoch === policy.epoch &&
            !tabHolds.has(s.tabId) &&
            allowedUrl(s.url),
        )
        .map(describe);
const localList = () =>
  [...sessions.values()].map((s) => {
    const item = describe(s);
    if (policy && !allowedUrl(s.url)) {
      item.title = "";
      try {
        item.url = normalizePolicyUrl(s.url);
      } catch {
        item.url = "";
      }
      item.state = tabHolds.get(s.tabId) || "blocked";
    }
    return item;
  });
function postCore(port, message) {
  if (message.type === "sessions") {
    publicationTruncated = message.sessions.length > SESSION_LIMIT;
    if (publicationTruncated)
      message = {
        ...message,
        sessions: message.sessions.slice(0, SESSION_LIMIT),
        truncated: true,
      };
  }
  const encodedSize = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  if (encodedSize(message) > 450 * 1024) {
    if (message.type === "response") {
      message = {
        type: "response",
        id: message.id,
        error: {
          code: "response_too_large",
          message:
            "Browser response exceeds the safe transport budget. Narrow the request.",
        },
      };
    } else if (message.type === "sessions") {
      const sessions = [];
      let bytes = 256;
      for (const session of message.sessions) {
        const size = encodedSize(session) + 1;
        if (bytes + size > 450 * 1024) break;
        sessions.push(session);
        bytes += size;
      }
      message = { ...message, sessions, truncated: true };
      publicationTruncated = true;
    } else return;
  }
  port.postMessage(message);
}
function publish() {
  try {
    if (corePort)
      postCore(corePort, {
        type: "sessions",
        policyEpoch: policy?.epoch ?? null,
        sessions: list(),
      });
  } catch {}
  chrome.action.setBadgeText({
    text: [...sessions.values()].some((s) => s.state === "active") ? "ON" : "",
  });
  chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
}
function errorJSON(e) {
  return {
    code: e.code || "browser_error",
    message: e.message || String(e),
    ...(e.details ? { details: e.details } : {}),
  };
}
function openCorePort() {
  if (corePort) return;
  const port = createCorePort({ storage: chrome.storage.local });
  corePort = port;
  coreReady = false;
  handshakeAlarm = `lumi-browser-handshake-${crypto.randomUUID()}`;
  void chrome.alarms
    .create(handshakeAlarm, { when: Date.now() + 180000 })
    .catch(() => {});
  transportError = "";
  port.onMessage.addListener((message) => {
    if (corePort !== port) return;
    if (message?.type === "ready") {
      if (coreReady) return;
      coreReady = true;
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
    if (coreReady && message?.type === "policy") {
      acceptPolicy(message);
      return;
    }
    if (
      !coreReady ||
      typeof message?.id !== "string" ||
      !message.id ||
      message.id.length > 128
    )
      return;
    if (["page_context_result", "page_rule_result"].includes(message.type)) {
      const pending = pagePolicyRequests.get(message.id);
      if (pending?.port === port && pending.type === message.type)
        pending.finish(message.error, message.result);
      return;
    }
    if (message.type === "cancel") {
      const pending = remoteRequests.get(message.id);
      if (pending?.port === port && pending.session?.state === "active") {
        // The Core authenticates request cancellation. Only the request's bound
        // session is paused; no other tab/session is affected by cancellation.
        void holdTab(pending.session, "paused").catch(() => {});
      }
      return;
    }
    if (message.type !== "request") return;
    if (!canAutoControl() || message.policyEpoch !== policy.epoch) {
      postCore(port, {
        type: "response",
        id: message.id,
        error: {
          code: "policy_required",
          message: "Current browser permission and policy epoch are required.",
        },
      });
      return;
    }
    pruneRecentIds();
    if (remoteRequests.has(message.id) || recentRequestIds.has(message.id)) {
      postCore(port, {
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
    if (remoteRequests.size >= 128) {
      postCore(port, {
        type: "response",
        id: message.id,
        error: { code: "busy", message: "Too many pending browser requests." },
      });
      return;
    }
    let args;
    try {
      args = validateRemoteRequest(message);
    } catch (error) {
      postCore(port, {
        type: "response",
        id: message.id,
        error: errorJSON(error),
      });
      return;
    }
    const pending = { port, session: sessions.get(args.sessionId) };
    remoteRequests.set(message.id, pending);
    handleRequest(message.tool, args)
      .then(
        (result) => {
          if (corePort === port)
            postCore(port, { type: "response", id: message.id, result });
        },
        (error) => {
          if (corePort === port)
            postCore(port, {
              type: "response",
              id: message.id,
              error: errorJSON(error),
            });
        },
      )
      .catch(() => {})
      .finally(() => {
        recentRequestIds.set(message.id, Date.now());
        pruneRecentIds();
        if (remoteRequests.get(message.id) === pending)
          remoteRequests.delete(message.id);
      });
  });
  port.onDisconnect.addListener(() => {
    // A late callback from an old port must never revoke a newer connection.
    if (corePort !== port) return;
    const reason =
      port.error ||
      "Lumi disconnected. Browser control is blocked until a new authenticated policy arrives.";
    transportFailed(reason);
  });
  publish();
}
async function page(s, operation, args = {}) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: s.tabId, frameIds: [0] },
    world: "ISOLATED",
    func: pageOperation,
    args: [
      operation,
      {
        ...args,
        expectedOrigin: s.origin,
        expectedUrl: s.url,
        sessionToken: s.id,
      },
    ],
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
  if (
    !canAutoControl() ||
    tabHolds.has(s.tabId) ||
    s.policyEpoch !== policy.epoch
  )
    throw new LumiError(
      "policy_required",
      "Current browser policy is not available.",
    );
  const policyEpoch = policy.epoch;
  const granted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  assertLive(s, epoch);
  if (
    !granted ||
    !canAutoControl() ||
    policy.epoch !== policyEpoch ||
    tabHolds.has(s.tabId)
  )
    throw new LumiError(
      "permission_required",
      "Browser permission or policy changed.",
    );
  const tab = await chrome.tabs.get(s.tabId);
  assertLive(s, epoch);
  if (
    !canAutoControl() ||
    policy.epoch !== policyEpoch ||
    !allowedUrl(tab.url) ||
    tabHolds.has(s.tabId)
  )
    throw new LumiError("policy_changed", "This URL is no longer allowed.");
  if (originOf(tab.url) !== s.origin || tab.url !== s.url) {
    revoke(s, "navigation_changed");
    void reconcileTab(s.tabId);
    throw new LumiError(
      "navigation_changed",
      "Navigation invalidated this session. Take a fresh snapshot in the new session.",
    );
  }
}
async function cdp(s, epoch, method, params) {
  await guard(s, epoch);
  // No await between this final epoch check and the actual CDP dispatch.
  assertLive(s, epoch);
  if (
    !canAutoControl() ||
    tabHolds.has(s.tabId) ||
    s.policyEpoch !== policy.epoch
  )
    throw new LumiError("policy_changed", "Policy changed before dispatch.");
  return chrome.debugger.sendCommand({ tabId: s.tabId }, method, params);
}
function revoke(s, state = "revoked") {
  invalidate(s, state);
  page(s, "remove_overlay").catch(() => {});
  attachmentSlots.delete(s.tabId);
  void detachTab(s.tabId);
  publish();
}
async function attachAllowedTab(tabId) {
  const consentEpoch = transportEpoch;
  if (!canAutoControl() || tabHolds.has(tabId))
    throw new LumiError(
      "permission_required",
      "Automatic browser control is not available.",
    );
  const policyEpoch = policy.epoch;
  const tab = await chrome.tabs.get(tabId);
  const origin = originOf(tab.url);
  if (!allowedUrl(tab.url))
    throw new LumiError("blocked_url", "This URL is blocked.");
  for (const old of sessions.values())
    if (old.tabId === tabId) {
      invalidate(old, "revoked");
      await detachTab(tabId);
      sessions.delete(old.id);
    }
  const granted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  if (
    !granted ||
    !canAutoControl() ||
    policy.epoch !== policyEpoch ||
    tabHolds.has(tabId) ||
    consentEpoch !== transportEpoch
  )
    throw new LumiError(
      "cancelled",
      "Browser policy changed before attachment.",
    );
  if (detaching.has(tabId)) await detaching.get(tabId);
  if (
    !canAutoControl() ||
    policy.epoch !== policyEpoch ||
    tabHolds.has(tabId) ||
    consentEpoch !== transportEpoch
  )
    throw new LumiError(
      "cancelled",
      "Policy changed while detaching the old session.",
    );
  await chrome.debugger.attach({ tabId }, "1.3");
  const current = await chrome.tabs.get(tabId);
  if (
    !allowedUrl(current.url) ||
    originOf(current.url) !== origin ||
    current.url !== tab.url
  ) {
    await detachTab(tabId);
    throw new LumiError(
      "origin_changed",
      "Page navigated during authorization; authorize again.",
    );
  }
  if (
    consentEpoch !== transportEpoch ||
    !canAutoControl() ||
    policy.epoch !== policyEpoch ||
    tabHolds.has(tabId)
  ) {
    await detachTab(tabId);
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
    policyEpoch,
    queue: Promise.resolve(),
  };
  sessions.set(s.id, s);
  try {
    await guard(s, s.epoch);
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
  if (!canAutoControl())
    throw new LumiError(
      "policy_required",
      "Allow browser permissions and wait for Lumi policy first.",
    );
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
    if (tool === "snapshot" || tool === "read_text") {
      const result = await page(s, tool, args);
      await guard(s, epoch);
      return result;
    }
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
        const observation = await page(s, "wait_check", args);
        await guard(s, epoch);
        if (observation.matched) return { matched: true };
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
          await holdTab(s, "paused").catch(() => {});
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
      await ensureConnection({ resetBudget: message.probe === true });
      return transportStatus();
    }
    if (message.type === "reconnect") {
      await ensureConnection({ resetBudget: true });
      return transportStatus();
    }
    if (message.type === "reset_pairing") {
      if (message.confirmed !== true || coreReady || resettingPairing)
        throw new LumiError(
          "confirmation_required",
          "仅在未连接时明确确认重新配对。",
        );
      resettingPairing = true;
      try {
        const oldPort = corePort;
        if (oldPort) await oldPort.resetPairing();
        else await resetCorePairing(chrome.storage.local);
        transportError = "扩展旧凭据已清除；还需在 Lumi 中确认重新配对。";
      } finally {
        resettingPairing = false;
      }
      await ensureConnection({ resetBudget: true });
      return transportStatus();
    }
    if (message.type === "set_page_allowed") return setPageAllowed(message);
    if (message.type === "command")
      return handleRequest(message.tool, message.args || {});
    if (message.type === "enable_auto") {
      await initializeAuthority();
      if (!(await chrome.permissions.contains({ origins: HOST_ORIGINS })))
        throw new LumiError(
          "permission_required",
          "Grant Chrome website permissions first.",
        );
      await chrome.storage.local.set({ lumiAutoConsent: true });
      autoConsent = true;
      hostGranted = true;
      await ensureConnection({ resetBudget: true });
      await reconcileAll();
      return transportStatus();
    }
    if (message.type === "resume_tab") {
      if (!Number.isInteger(message.tabId))
        throw new LumiError("invalid_argument", "A tab ID is required.");
      tabHolds.delete(message.tabId);
      await persistHolds();
      await reconcileTab(message.tabId);
      return transportStatus();
    }
    if (["pause", "takeover", "disconnect"].includes(message.type)) {
      const tabId = message.tabId ?? sessions.get(message.sessionId)?.tabId;
      if (!Number.isInteger(tabId))
        throw new LumiError("unknown_session", "A current tab ID is required.");
      await holdTabId(
        tabId,
        message.type === "pause" ? "paused" : "taken_over",
      );
      return transportStatus();
    }
    const s = sessions.get(message.sessionId);
    if (!s) throw new LumiError("unknown_session", "Session no longer exists.");
    if (message.type === "pause") await holdTab(s, "paused");
    else if (message.type === "takeover" || message.type === "disconnect")
      await holdTab(s, "taken_over");
    else if (message.type === "resume") {
      tabHolds.delete(s.tabId);
      await persistHolds();
      await reconcileTab(s.tabId);
    } else
      throw new LumiError("invalid_operation", "Unsupported popup action.");
    publish();
    return transportStatus();
  })().then(
    (result) => respond({ result }),
    (error) => respond({ error: errorJSON(error) }),
  );
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  holdRevisions.delete(tabId);
  attachmentSlots.delete(tabId);
  expectedDetach.delete(tabId);
  tabHolds.delete(tabId);
  void persistHolds().catch(() => {});
  for (const s of sessions.values())
    if (s.tabId === tabId) {
      invalidate(s, "closed");
      sessions.delete(s.id);
    }
  publish();
  void reconcileAll();
});
function navigationChanged(tabId, url) {
  for (const s of sessions.values())
    if (s.tabId === tabId) {
      if (s.state === "active")
        revoke(s, allowedUrl(url) ? "navigation_changed" : "blocked");
      if (!allowedUrl(url)) {
        s.title = "";
        try {
          s.url = normalizePolicyUrl(url);
        } catch {
          s.url = "";
        }
      }
    }
  void reconcileTab(tabId);
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) navigationChanged(tabId, change.url);
  else if (change.status === "complete") void reconcileTab(tabId);
  if (change.title)
    for (const s of sessions.values())
      if (s.tabId === tabId && s.state === "active") s.title = change.title;
  publish();
});
chrome.tabs.onCreated.addListener((tab) => {
  void reconcileTab(tab.id);
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) navigationChanged(details.tabId, details.url);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (
    ["canceled_by_user", "replaced_with_devtools"].includes(reason) &&
    Number.isInteger(source.tabId)
  ) {
    void holdTabId(source.tabId, "taken_over").catch(() => {});
    return;
  }
  void (async () => {
    if (detaching.has(source.tabId)) {
      expectedDetach.delete(source.tabId);
      return;
    }
    const current = [...sessions.values()].find(
      (s) => s.tabId === source.tabId && s.state === "active",
    );
    if (!current) {
      expectedDetach.delete(source.tabId);
      return;
    }
    if (expectedDetach.has(source.tabId)) {
      expectedDetach.delete(source.tabId);
      try {
        const targets = await chrome.debugger.getTargets();
        if (
          targets.some(
            (target) => target.tabId === source.tabId && target.attached,
          )
        )
          return;
      } catch {
        /* Unknown target state remains conservative: honor takeover. */
      }
    }
    if (sessions.get(current.id) === current && current.state === "active")
      await holdTabId(source.tabId, "taken_over");
    publish();
  })().catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => {
  hostGranted = false;
  for (const s of sessions.values())
    if (s.state === "active") revoke(s, "permission_required");
  publish();
});
chrome.permissions.onAdded.addListener(() => {
  void (async () => {
    hostGranted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
    if (hostGranted) await reconcileAll();
  })();
});

// The transport alone grants nothing. A fresh policy plus persisted website
// permission may create new sessions; held tabs and old actions never resume.
chrome.runtime.onStartup.addListener(() => {
  void ensureConnection({ resetBudget: true });
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureConnection({ resetBudget: true });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    await initializeTransport();
    if (alarm.name === handshakeAlarm && corePort && !coreReady) {
      const timedOutPort = corePort;
      transportFailed(
        "Lumi connection handshake timed out. Check Browser User settings.",
      );
      timedOutPort.disconnect();
      return;
    }
    if (corePort || retryPaused || alarm.name !== retryAlarm) return;
    retryAt = null;
    retryAlarm = null;
    await ensureConnection();
  })();
});
void ensureConnection();
