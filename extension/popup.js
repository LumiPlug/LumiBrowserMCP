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
  $("toggle").textContent = !status.hostGranted
    ? "需 Chrome 网站权限"
    : nextAllowed
      ? !status.autoConsent && allowed && !held
        ? "恢复页面控制"
        : "允许此页"
      : "禁止此页";
  $("toggle").disabled = busy || !ready || !currentUrl || !status.hostGranted;
  if (!ready && /配对凭据|重新配对/.test(status.transportError || "")) {
    $("toggle").textContent = "重新配对";
    $("toggle").disabled = busy;
  }
  $("connection").textContent = !ready
    ? status.connecting
      ? "正在连接 Lumi…"
      : /配对凭据/.test(status.transportError || "")
        ? "Lumi 未连接 · 配对凭据不匹配"
        : "Lumi 未连接"
    : !currentUrl
      ? "Lumi 已连接 · 此页不支持"
      : held
        ? "Lumi 已连接 · 此页已接管"
        : !status.hostGranted
          ? "Lumi 已连接 · 需 Chrome 网站权限"
          : !status.autoConsent
            ? "Lumi 已连接 · 页面控制已暂停"
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
    /配对凭据|重新配对/.test(lastStatus?.transportError || "")
  ) {
    if (
      !window.confirm(
        "清除此扩展的旧配对凭据并断开？还需在 Lumi 中确认重新配对，之后会重新首次信任，无法识别本机恶意冒充。",
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
    busy ||
    !lastStatus?.connected ||
    !lastStatus?.policyReady ||
    !lastStatus?.hostGranted ||
    !currentUrl
  )
    return;
  busy = true;
  $("toggle").disabled = true;
  showError();
  // Capture the displayed target. Worker checks that the tab has not navigated.
  const tabId = currentTab.id,
    url = currentUrl,
    allowed = nextAllowed;
  try {
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
