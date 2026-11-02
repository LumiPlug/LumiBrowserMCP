const $ = (id) => document.getElementById(id);
let currentTab;
let currentSession;
const labels = {
  active: "已授权 · 运行中",
  paused: "已暂停",
  taken_over: "已接管",
  disconnected: "已断开",
  origin_changed: "来源已改变",
  detached: "调试连接已断开",
  closed: "标签页已关闭",
  revoked: "已撤销",
};
async function request(message) {
  const answer = await chrome.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error.message);
  return answer.result;
}
async function act(message) {
  $("error").textContent = "";
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  try {
    await request(message);
  } catch (e) {
    $("error").textContent = e.message;
  } finally {
    await refresh();
    $("authorize").disabled =
      !currentTab || !/^https?:/.test(currentTab.url || "");
    $("run").disabled = false;
  }
}
async function refresh() {
  const status = await request({ type: "status" });
  currentSession = status.sessions.find(
    (s) => s.tabId === currentTab?.id && s.state === "active",
  );
  $("connection").textContent = status.connected
    ? "● Lumi 已连接"
    : `○ Lumi 未连接${status.transportError ? " · " + status.transportError : "（请先在 Lumi 设置中启用 Browser User）"}`;
  $("sessions").replaceChildren();
  for (const s of status.sessions.filter((s) => s.tabId === currentTab?.id)) {
    const box = document.createElement("section");
    box.className = "session";
    const state = document.createElement("div");
    state.className = "state";
    state.textContent = labels[s.state] || s.state;
    box.append(state);
    const title = document.createElement("p");
    title.textContent = s.title || s.origin;
    box.append(title);
    for (const [type, label, danger] of s.state === "active"
      ? [
          ["pause", "暂停"],
          ["takeover", "立即接管", true],
          ["disconnect", "断开"],
        ]
      : s.state === "paused"
        ? [
            ["resume", "继续"],
            ["takeover", "立即接管", true],
            ["disconnect", "断开"],
          ]
        : []) {
      const button = document.createElement("button");
      button.textContent = label;
      if (danger) button.className = "danger";
      button.addEventListener("click", () => act({ type, sessionId: s.id }));
      box.append(button);
    }
    $("sessions").append(box);
  }
}
$("authorize").addEventListener("click", () =>
  act({ type: "authorize", tabId: currentTab.id }),
);
try {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("tabTitle").textContent = currentTab?.title || "未找到标签页";
  $("origin").textContent = currentTab?.url
    ? new URL(currentTab.url).origin
    : "";
  $("authorize").disabled =
    !currentTab || !/^https?:/.test(currentTab.url || "");
  await refresh();
} catch (e) {
  $("error").textContent = e.message;
}

$("run").addEventListener("click", async () => {
  $("error").textContent = "";
  $("run").disabled = true;
  try {
    const args = JSON.parse($("args").value);
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("参数必须为 JSON 对象");
    const result = await request({
      type: "command",
      tool: $("tool").value,
      args: { ...args, sessionId: currentSession?.id },
    });
    $("result").textContent = JSON.stringify(result, null, 2);
  } catch (e) {
    $("result").textContent = e.message;
  } finally {
    $("run").disabled = false;
    await refresh();
  }
});
