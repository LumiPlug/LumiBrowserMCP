# LumiBrowserMCP — Lumi browser 扩展

**本仓库现在只交付一份跨 Windows/macOS 通用的 Chrome MV3 扩展。** 本地 MCP、连接管理和 Native Messaging Host 已集成到 [Lumi](https://github.com/LumiPlug/Lumi)；不再单独安装或发布适配器软件。

> 0.2 开发预览版需要包含 **Browser User** 设置的 Lumi 集成构建，见 [Lumi PR #17](https://github.com/LumiPlug/Lumi/pull/17)。旧 main/发行版没有此入口时，不能仅更新扩展就认为迁移完成。两个 PR 均待审阅，不自动合并。

## 三步使用

1. 下载本仓库成功 Actions run 的 `lumi-browser-extension`，校验产品 ZIP 的 SHA256 并解压。在 `chrome://extensions` 加载含 `manifest.json` 的目录，复制实际扩展 ID。
2. 打开 Lumi → 设置 → **Browser User**，填写 ID，阅读共享控制域范围并确认“启用并注册”。Lumi 负责当前用户的宿主注册与诊断，不需另配第二个 MCP 服务。Agent 使用已有 Lumi MCP 连接方式。
3. 在普通 HTTP(S) 目标网页打开 Lumi 扩展，选择“授权当前标签页”，确认 Chrome 调试提示。Agent 调用 `Lumi.browser_list_sessions`，随后获取快照、按 ref 操作。

扩展不移动系统鼠标、不主动切换前台窗口。暂停、接管、断开均在扩展内；跨站导航、Core 停止、Native Host 断开会撤销授权，需要重新授权。

**所有接入 Lumi 的 Agent 共享一个控制域，操作串行，不是逐 Agent 独立授权。** Browser User 默认关闭，MCP 工具不能自行启用或授予标签页权限。

## MCP 工具（由 Lumi 提供）

`Lumi.browser_list_sessions`、`Lumi.browser_snapshot`、`Lumi.browser_read_text`、`Lumi.browser_click`、`Lumi.browser_fill`、`Lumi.browser_scroll`、`Lumi.browser_wait_for`。

扩展内部协议仍使用对应不带前缀的工具名。`ref` 是临时节点/语义标识，不是可静默重新定位的 selector。已派发动作结果未知时返回 `outcome_unknown`，不得自动重放。

## 旧预览版迁移

如果已安装独立 adapter：退出旧 MCP 客户端，使用旧包自带卸载脚本移除旧 Native Host；再从 Lumi 的 Browser User 确认注册。移除旧客户端的 `lumi-browser` 独立 MCP 条目，保留已有 Lumi MCP 配置。新版本拒绝直接覆盖无法确认归属的旧注册。

旧独立实现留在 Git 历史 commit `293951b66e513b7b28475be9382530ba2ab0140b`，仅用于回退/旧版卸载，不作为当前交付。不要同时运行旧 broker 和新 Lumi 链路。

## 开发与验收

```sh
npm ci
npm run check
npm test
npm run build
node fixtures/server.mjs
```

开发测试需要 Node 22+；扩展用户不需要安装 Node。`dist/lumi-browser-extension.zip` 解压后直接加载。Actions 在三种系统测试，最后只输出**一份**通用扩展 ZIP 和 SHA256。宿主随 Lumi 桌面包分发，参见 Lumi 的 [Browser User 文档](https://github.com/LumiPlug/Lumi/blob/feat/browser-user-integration/docs/BROWSER_USER.md)。

真实 Chrome、订单流程、中文输入、125% 缩放、多显示器及跨应用鼠标验收仍交用户进行；模拟 Chrome API 测试与平台 CI 不等于实机验收。详见 [架构](docs/ARCHITECTURE.md)、[验收](docs/ACCEPTANCE.md)、[验证记录](docs/TEST_REPORT.md)。
