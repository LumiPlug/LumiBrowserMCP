# Lumi browser

Lumi browser 是 **Chrome Manifest V3 扩展**：用户明确授权某个标签页后，通过 Chrome DevTools Protocol（CDP）执行精确的页面点击、中文输入与滚动，页面内显示 Lumi 虚拟光标。**不移动操作系统鼠标，不主动切换前台窗口。**

> 产品是 Chrome 扩展，不是独立桌面应用。为实现本地 Agent 经 MCP 连接扩展，附带 **由 Agent 按需启动、无 GUI 的 MCP 适配器**。Chrome Native Messaging 需要首次注册一个宿主；无需用户手工启动常驻服务。

> 开发预览版：扩展与按需 MCP 适配器已实现，真实浏览器验收由用户进行。完整验证结果以测试报告为准，不把模拟测试或双平台打包当成真实浏览器验收。

## 安装与使用

1. 从同一个明确 commit 的成功 GitHub Actions run 下载**一份通用扩展 ZIP**和对应 CPU 的适配器 ZIP。Windows/macOS 的区分是适配器，不是 Chrome 扩展。校验 ZIP 的 SHA256 后解压。
2. Chrome 打开 `chrome://extensions`，开启开发者模式并加载含 `manifest.json` 的扩展目录，复制实际 32 字符 ID。
3. 将 [Agent 一次性安装指南](docs/AGENT_SETUP.md) 交给已获授权、能在本机执行的 Agent。适配器内置 `--setup` 合并预检、用户级注册、所选客户端配置和诊断，不需要另装 Node。

Apple Silicon Mac 在适配器解压目录，先预演：

```sh
./lumi-browser-adapter --setup --extension-id 实际扩展ID --client codex
```

确认修改范围并授权后，同一命令加 `--apply`。Windows 使用 `.\lumi-browser-adapter.exe`。首版自动写入 **明确选择的 Codex**；其他客户端使用 `--client snippet` 输出配置，不猜测其安装路径。不会自动请求管理员权限、安装桌面应用或启动常驻服务。系统安全提示不能自动绕过。

4. 重启 Agent / Chrome，在普通 HTTP(S) 目标标签页打开 Lumi，点击“授权此页”并确认 Chrome 调试器提示。Agent 先调用 `list_sessions`，再按 sessionId 获取快照并操作。
5. 使用 `--doctor --extension-id 实际扩展ID` 分别核对适配器、Native Host 注册、扩展真实连接；没有正在运行的 Agent / 授权标签页时，不会伪称连接成功。

完整命令、校验方式、权限边界、配置备份和卸载说明见 [AGENT_SETUP.md](docs/AGENT_SETUP.md)。原有 `install-macos.sh` / `install-windows.ps1` 仍可手动注册宿主，但不会自动配置 MCP 客户端。

扩展 popup 提供暂停、接管、断开；接管取消后续排队输入。跨来源、关闭标签、调试器或 native host 断开使授权失效，需要重新授权。最后 MCP 客户端退出后，broker 和原生宿主连接回收；只有扩展先连接时允许 30 秒启动宽限。多个客户端可列出会话，第一个操作会话的客户端拥有它，其他客户端不能抢占。

macOS 适配器仅 ad-hoc 签名，Windows 未进行发布者签名，均为开发预览产物。未在用户电脑安装；完整真实 Chrome 验收由用户负责。保留 draft PR，不自动合并。

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
