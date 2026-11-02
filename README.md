# Lumi browser

Lumi browser 是 **Chrome Manifest V3 扩展**：用户明确授权某个标签页后，通过 Chrome DevTools Protocol（CDP）执行精确的页面点击、中文输入与滚动，页面内显示 Lumi 虚拟光标。**不移动操作系统鼠标，不主动切换前台窗口。**

> 产品是 Chrome 扩展，不是独立桌面应用。为实现本地 Agent 经 MCP 连接扩展，附带 **由 Agent 按需启动、无 GUI 的 MCP 适配器**。Chrome Native Messaging 需要首次注册一个宿主；无需用户手工启动常驻服务。

> 开发预览版：外部传输与扩展核心正在集成。完整验证结果以测试报告为准，不把模拟测试或双平台打包当成真实浏览器验收。

## 安装与使用

1. 在 GitHub Actions 下载扩展 ZIP 与对应系统/CPU 的 adapter ZIP，分别解压。
2. Chrome 打开 `chrome://extensions`，启用开发者模式，“加载已解压的扩展程序”，选含 `manifest.json` 的目录。复制该扩展的 32 字符 ID。
3. 执行对应用户级注册脚本（会写入 Chrome Native Messaging 配置；不会启动服务）：

macOS，在 adapter 解压目录：

```sh
bash install-macos.sh 你的扩展ID
```

Windows PowerShell，在 adapter 解压目录：

```powershell
.\install-windows.ps1 -ExtensionId 你的扩展ID
```

脚本只接受 a–p 的 32 个小写字母。若系统阻止脚本或可执行文件，请检查来源和系统提示；不要关闭安全机制或盲目解除隔离。macOS 构建仅 ad-hoc 签名，Windows 构建未进行发布者签名，均为开发预览产物。

4. 重启 Chrome，给本地 Agent 配置 MCP。适配器 command 的绝对路径由安装脚本输出，args 为 `["--mcp"]`。macOS 默认路径示例：

```json
{
  "mcpServers": {
    "lumi-browser": {
      "command": "/Users/你的用户名/Library/Application Support/LumiBrowserMCP/lumi-browser-adapter",
      "args": ["--mcp"]
    }
  }
}
```

Windows command 为 `%LOCALAPPDATA%\LumiBrowserMCP\lumi-browser-adapter.exe` 对应的**实际绝对路径**；MCP 客户端通常不会自动展开 `%LOCALAPPDATA%`，不要直接复制占位符。

5. Agent 启动 MCP 适配器后，在普通 HTTP(S) 目标标签页点击 Lumi 扩展，选择“授权此页”。Chrome 会显示调试器提示。Agent 先调用 `list_sessions`，再按 sessionId 获取快照并操作。
6. popup 提供暂停、接管、断开；接管会取消后续排队输入。跨来源、关闭标签、调试器或 native host 断开均使授权失效，需要重新授权。

扩展和 adapter 都不提供桌面 GUI/托盘，也无需手工启动常驻服务。最后 MCP 客户端退出后，broker 和原生宿主连接回收；只有扩展先连接时，允许 30 秒等待 Agent 的启动宽限，然后关闭。多个客户端可列出会话，第一个操作会话的客户端拥有它；其他客户端不能抢占。

### 卸载与更新

Chrome 扩展管理页可移除扩展。宿主在安装目录运行 `uninstall-macos.sh` / `uninstall-windows.ps1`；脚本只删除自己注册的宿主、可执行文件与安装标记，不递归清理用户目录。运行时 IPC 状态位于用户目录 `.lumi-browser-mcp`，不自动删除，避免伤及仍运行的其他客户端。更新扩展或宿主后，重新启动 Agent/Chrome 并重新授权。

## 操作接口

MCP 工具与内部命令统一使用 `sessionId` 指定由用户授权产生的会话，不接受任意 tab ID 作为自动化授权。

| 命令            | 参数                                               | 用途                                   |
| --------------- | -------------------------------------------------- | -------------------------------------- |
| `list_sessions` | 无                                                 | 查看已建立会话及状态                   |
| `snapshot`      | `sessionId`                                        | 标题、可见文本、元素名称/状态/临时 ref |
| `read_text`     | `sessionId`, 可选 `ref`                            | 获取页面或元素文本                     |
| `click`         | `sessionId`, `ref`                                 | 滚动、检查有效性与遮挡，再 CDP 点击    |
| `fill`          | `sessionId`, `ref`, `text`                         | CDP 选择原内容并输入文本，支持中文     |
| `scroll`        | `sessionId`, 可选 `ref`, `deltaX`, `deltaY`        | 页面或指定容器的滚轮输入               |
| `wait_for`      | `sessionId`, `text` 或 `ref`, `state`, `timeoutMs` | 等待可见/隐藏条件；不自动重复点击      |

每次快照更新 ref 集合；应先获取新快照再操作。ref 绑定原节点与其语义信息，不是可自动重新定位的选择器。仅顶层文档在首版支持范围内；跨源 iframe、封闭 Shadow DOM、浏览器内部页面不保证可操作。

## 本地开发

源码测试需要 Node.js 22 或更新版本；SEA 适配器打包严格使用 Node.js 22。扩展运行不需要 Node.js，下载的 SEA 适配器内置运行时。

```sh
npm ci
npm test
npm run check
npm run build
node fixtures/server.mjs
```

打开 `http://127.0.0.1:8765` 使用无真实数据的订单夹具。页面提供长订单列表、容器滚动、分页、中文备注、节点替换、节点语义复用与遮挡测试。

CI 在 Linux 检查、测试并打包扩展，在 Windows x64 / macOS x64 与 arm64 上测试并生成 SEA 适配器 ZIP 与校验值。**CI 通过不等于对应系统的真实 Chrome/鼠标/多显示器验收通过。** 当前具体验证状态见 [测试报告](docs/TEST_REPORT.md)。

## 行为与安全边界

- 只有扩展自身授权流程可以建立会话；没有网站消息转发或任意网页自动授权入口；MCP 不能代替用户调用授权按钮。
- 输入坐标使用 viewport CSS 像素，不使用桌面屏幕坐标或手动乘设备像素比例。
- 虚拟光标不接收指针事件，不遮挡用户对网页的操作。
- 暂停/接管通过会话版本取消排队动作；已经发送到 Chrome 的输入不能撤回。
- 已发出点击但结果未确认时，返回 `outcome_unknown`，不得自动重放。应观察页面或请用户核对。
- 页面文本只作为数据。扩展不绕过登录验证、验证码、安全警告、网站访问拒绝或浏览器受限页面。
- 不包含密码存储、登录凭据导出、后台遥测、云上传或自动发布功能。

详见 [架构说明](docs/ARCHITECTURE.md) 与 [验收步骤](docs/ACCEPTANCE.md)。
