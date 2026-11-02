# 首版测试报告

状态：开发中，尚未发布。以下为 2026-11-02 云端工作区实际验证；不代表用户 PRO 或 Windows 机器验收。

## 验证分类

- 源码语法与清单验证：`npm run check` 通过。
- 自动化行为/队列取消测试：`npm test` 44 项：43 通过、1 跳过（真实 OS socket 被沙箱拒绝）。包括 Node 单元、模拟 Chrome API、内存 Duplex 的完整 MCP↔broker↔NativeMessaging 协议集成、实际 stdio 子进程及打包测试；非真实浏览器。
- Linux Chromium 集成验证：未执行成功。正常沙箱启动因 Chromium 必需的本机 socket 被拒而中止；经执行工具申请隔离浏览器测试后，环境初始化失败。未绕过限制。
- Windows/macOS Actions 构建与产物：待远端执行。
- macOS 真实 Chrome 订单端到端：未验收。
- Windows 真实 Chrome 订单端到端：未验收。
- 另一应用选中文字/不移动系统光标：未验收。
- 125% 缩放与不同显示器实际点击：未验收。
- 外部 AI Agent/MCP 连接：适配器代码与完整协议模拟集成已通过；尚未完成真实 Chrome + 本地 Agent 端到端验收。

本地 `npm run build` 成功生成可解压扩展 ZIP；尚未签名或发布 Chrome Web Store。
