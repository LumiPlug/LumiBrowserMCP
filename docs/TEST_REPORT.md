# 首版测试报告

状态：开发预览版，已提交 draft PR，未合并、未安装到用户电脑。用户已接手真实 Chrome 实机测试。以下为 2026-11-02 云端工作区实际验证；不代表用户 PRO 或 Windows 机器验收。

## 验证分类

- 源码语法与清单验证：`npm run check` 通过。
- 自动化行为/队列取消测试：`npm test` 44 项：43 通过、1 跳过（真实 OS socket 被沙箱拒绝）。包括 Node 单元、模拟 Chrome API、内存 Duplex 的完整 MCP↔broker↔NativeMessaging 协议集成、实际 stdio 子进程及打包测试；非真实浏览器。
- Linux Chromium 集成验证：未执行成功。正常沙箱启动因 Chromium 必需的本机 socket 被拒而中止；经执行工具申请隔离浏览器测试后，环境初始化失败。未绕过限制。
- Windows/macOS Actions 构建与产物：首轮全部通过，Linux/Windows x64/macOS x64/macOS arm64 均 44/44 测试通过、0 跳过，包含真实 OS IPC handshake；三个 SEA 构建及内置 `--help` 通过。
  - 验证 commit：`9c2badbfe5d14c035e8638fc03776f760bbb18a3`。
  - [首轮工作流](https://github.com/LumiPlug/LumiBrowserMCP/actions/runs/41401323605)；扩展 ZIP、3 个平台适配器 ZIP 及 SHA256 已上传 artifacts。
  - 官方 Actions v7 的复验亦已通过：commit `f37997fe9483382691f1733ce4cb75098dc6ffc0`，[run 41401722607](https://github.com/LumiPlug/LumiBrowserMCP/actions/runs/41401722607)，四 job 成功、各 44/44。
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

## 一次性配置增量

本轮云端最终总检：68 项，67 通过、1 真实 IPC 环境限制跳过；语法检查与扩展 ZIP 构建通过。

- `--setup` 默认只读预演，不启动 Codex、安装程序或 broker。`--apply` 才做用户级宿主注册和明确选择的 Codex 配置；其他客户端仅 snippet。
- 校验包平台/CPU/最终二进制 SHA256，拒绝同名异配置、符号链接和未知安装目录；配置与被替换安装文件保留本地私密备份。
- 自动调用分层 `--doctor`；真实连接未就绪不会声称成功。Doctor 连接不计为 MCP 客户端，不维持 broker 存活，也不导致现有会话撤销。
- 自动测试覆盖预演无写入/无外部进程、平台/CPU/哈希拒绝、Codex 合并/备份/冲突/卸载，以及诊断注册与真实连接证据；安装测试使用临时目录与 mock，不在用户电脑注册。
- 新适配器的 CI 增加真实 SEA `--setup` 预演 smoke，不执行真实安装。最新增量 CI 结果与精确 commit 见 PR #1 最新验证评论；不以先前成功 run 代替本次验证。
