# 首版测试报告

状态：开发预览版，已提交 draft PR，未合并、未安装到用户电脑。以下为 2026-11-02 云端工作区实际验证；不代表用户 PRO 或 Windows 机器验收。

## 验证分类

- 源码语法与清单验证：`npm run check` 通过。
- 自动化行为/队列取消测试：`npm test` 44 项：43 通过、1 跳过（真实 OS socket 被沙箱拒绝）。包括 Node 单元、模拟 Chrome API、内存 Duplex 的完整 MCP↔broker↔NativeMessaging 协议集成、实际 stdio 子进程及打包测试；非真实浏览器。
- Linux Chromium 集成验证：未执行成功。正常沙箱启动因 Chromium 必需的本机 socket 被拒而中止；经执行工具申请隔离浏览器测试后，环境初始化失败。未绕过限制。
- Windows/macOS Actions 构建与产物：首轮全部通过，Linux/Windows x64/macOS x64/macOS arm64 均 44/44 测试通过、0 跳过，包含真实 OS IPC handshake；三个 SEA 构建及内置 `--help` 通过。
  - 验证 commit：`9c2badbfe5d14c035e8638fc03776f760bbb18a3`。
  - [首轮工作流](https://github.com/LumiPlug/LumiBrowserMCP/actions/runs/41401323605)；扩展 ZIP、3 个平台适配器 ZIP 及 SHA256 已上传 artifacts。
  - 工作流依赖由旧 Node20 Actions 升级官方 v7 后，将以最新 commit 再次核验。
- macOS 真实 Chrome 订单端到端：未验收。
- Windows 真实 Chrome 订单端到端：未验收。
- 另一应用选中文字/不移动系统光标：未验收。
- 125% 缩放与不同显示器实际点击：未验收。
- 外部 AI Agent/MCP 连接：适配器代码与完整协议模拟集成已通过；尚未完成真实 Chrome + 本地 Agent 端到端验收。

本地 `npm run build` 成功生成可解压扩展 ZIP；尚未签名或发布 Chrome Web Store。

## 首轮产物校验值

- 扩展 ZIP：`b7d1ff18e40ba216d8e7616ce9353809330b4caf2269649e398a67203ecc4475`
- Windows x64：`477cf3842c8c44747f1ce49b29707d5c00dd6271d7dadcf90ae518dedd0e3f6e`
- macOS x64：`c3aaeaa1bc4797e6a98ce2b8879fb023eb2041e558426ea61b0274ec13296dd0`
- macOS arm64：`aaf6961f2c5671c7759558ce9710dbc9a408c800726cecd3414cfc1fdb6fa23f`

不同构建的适配器 ZIP 字节可能变化，请优先使用同一 artifact 内的 SHA256 文件。
