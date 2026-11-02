import { normalizePolicyUrl } from "./core.mjs";
const $ = (id) => document.getElementById(id);
let busy = false;
let currentTab;
let currentUrl;
let nextAllowed = true;
let lastStatus;
async function request(message) {
  const answer = await chrome.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error.message);
  return answer.result;
}
function showError(message = "") {
  $("error").textContent = message;
  $("error").hidden = !message;
}
async function refresh(probe = false) {
  const status = await request({
    type: "status",
    ...(probe ? { probe: true } : {}),
  });
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    currentUrl = normalizePolicyUrl(currentTab?.url);
  } catch {
    currentUrl = null;
  }
  lastStatus = status;
  $("connection").title = status.transportError || "";
  const ready = status.connected && status.policyReady;
  const held = status.tabHolds?.[currentTab?.id];
  const allowed = currentUrl && !status.blockedUrls?.includes(currentUrl);
  nextAllowed =
    !allowed || !status.autoConsent || !status.hostGranted || !!held;
  $("toggle").textContent = nextAllowed ? "允许此页" : "禁止此页";
  $("toggle").disabled = busy || !ready || !currentUrl;
  if (
    !ready &&
    !status.pairingId &&
    /配对凭据|重新配对/.test(status.transportError || "")
  ) {
    $("toggle").textContent = "重新配对";
    $("toggle").disabled = busy;
  }
  if (
    !ready &&
    status.pairingId &&
    /^[0-9]{6}$/.test(status.pairingCode || "")
  ) {
    $("toggle").textContent = status.pairingConfirmed
      ? "等待 Lumi 确认"
      : "核对一致，确认配对";
    $("toggle").disabled = busy || !!status.pairingConfirmed;
  }
  $("connection").textContent = !ready
    ? /^[0-9]{6}$/.test(status.pairingCode || "")
      ? `配对码 ${status.pairingCode} · 请在 Lumi 核对`
      : status.connecting
        ? "正在连接 Lumi…"
        : /配对凭据/.test(status.transportError || "")
          ? "Lumi 未连接 · 配对凭据不匹配"
          : "Lumi 未连接"
    : !currentUrl
      ? "Lumi 已连接 · 此页不支持"
      : held
        ? "Lumi 已连接 · 此页已接管"
        : !status.autoConsent || !status.hostGranted
          ? "Lumi 已连接 · 待授权"
          : !allowed
            ? "Lumi 已连接 · 此页已禁止"
            : status.limitReached || status.publicationTruncated
              ? "Lumi 已连接 · 页面数量已达上限"
              : "Lumi 已连接";
}
$("toggle").addEventListener("click", async () => {
  if (
    !busy &&
    !lastStatus?.connected &&
    !lastStatus?.pairingId &&
    /配对凭据|重新配对/.test(lastStatus?.transportError || "")
  ) {
    if (
      !window.confirm(
        "清除此扩展的旧配对凭据并断开？还需在 Lumi 中确认重新配对，之后必须在两端重新核对短码。",
      )
    )
      return;
    busy = true;
    $("toggle").disabled = true;
    showError();
    try {
      await request({ type: "reset_pairing", confirmed: true });
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
      try {
        await refresh();
      } catch {
        $("toggle").disabled = true;
      }
    }
    return;
  }
  if (
    !busy &&
    !lastStatus?.connected &&
    lastStatus?.pairingId &&
    !lastStatus.pairingConfirmed &&
    /^[0-9]{6}$/.test(lastStatus.pairingCode || "")
  ) {
    const pairingId = lastStatus.pairingId;
    busy = true;
    $("toggle").disabled = true;
    showError();
    try {
      await request({ type: "confirm_pairing", pairingId });
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
      try {
        await refresh();
      } catch {
        $("toggle").disabled = true;
      }
    }
    return;
  }
  if (busy || !lastStatus?.connected || !lastStatus?.policyReady || !currentUrl)
    return;
  busy = true;
  $("toggle").disabled = true;
  showError();
  // Capture the displayed target. Worker checks that the tab has not navigated.
  const tabId = currentTab.id,
    url = currentUrl,
    allowed = nextAllowed;
  try {
    if (allowed) {
      // Chrome's permission prompt must remain in this explicit user gesture.
      const granted = await chrome.permissions.request({
        origins: ["http://*/*", "https://*/*"],
      });
      if (!granted) throw new Error("未授予网站权限。此页未允许。");
    }
    await request({ type: "set_page_allowed", tabId, url, allowed });
  } catch (error) {
    showError(error.message);
  } finally {
    busy = false;
    try {
      await refresh();
    } catch {
      showError("无法读取连接状态，请重新打开扩展。");
      $("toggle").disabled = true;
    }
  }
});
try {
  await refresh(true);
} catch {
  showError("无法读取连接状态，请重新打开扩展。");
}
let polling = false;
const timer = setInterval(async () => {
  if (polling || busy) return;
  polling = true;
  try {
    await refresh();
  } catch {
    $("connection").textContent = "Lumi 未连接";
    $("toggle").disabled = true;
  } finally {
    polling = false;
  }
}, 1000);
window.addEventListener("unload", () => clearInterval(timer), { once: true });
