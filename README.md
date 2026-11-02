# Lumi Browser — AI Browser Automation & MCP

**本仓库现在只交付一份跨 Windows/macOS 通用的 Chrome MV3 扩展。** 本地 MCP、连接管理和 Native Messaging Host 已集成到 [Lumi](https://github.com/LumiPlug/Lumi)；不再单独安装或发布适配器软件。

> 0.4 开发预览版需要包含 **Browser User** 设置的 Lumi 集成构建，见 [Lumi PR #17](https://github.com/LumiPlug/Lumi/pull/17)。旧 main/发行版没有此入口时，不能仅更新扩展就认为迁移完成。两个 PR 均待审阅，不自动合并。

## 三步使用

1. 下载本仓库成功 Actions run 的 `lumi-browser-extension`，校验产品 ZIP 的 SHA256 并解压。在 `chrome://extensions` 加载含 `manifest.json` 的目录。官方公钥固定 ID 为 `hfhigjgopbjmojflbhhnahpfpnmiaman`，无需复制粘贴。
2. 打开 Lumi → 设置 → **Browser User**，阅读共享控制域范围并首次确认“启用并注册”；官方扩展身份已内置。Lumi 负责当前用户的宿主注册与诊断，不需另配第二个 MCP 服务。Agent 使用已有 Lumi MCP 连接方式。
3. 在扩展首次点击允许普通网页访问并确认 Chrome 权限。此后普通 HTTP(S) 标签页自动接入；在 Lumi 的 Browser User 添加不允许访问的单个链接。Agent 使用 `Lumi.browser_list_sessions` 获取当前允许的会话。

扩展不移动系统鼠标、不主动切换前台窗口。暂停、接管、断开均在扩展内，优先于自动接入。跨页、Core 停止或通信断线会失效旧会话；连接恢复后只为仍允许且未暂停/接管的标签页创建新会话。

**所有接入 Lumi 的 Agent 共享一个控制域，操作串行，不是逐 Agent 独立授权。** Browser User 默认关闭，MCP 工具不能自行启用、改禁止列表或代替 Chrome 权限确认。

## 自动连接与必要确认

扩展启动、浏览器启动、打开扩展或通信中断后会自动尝试连接正在运行且已启用 Browser User 的 Lumi。Native Host 确认 Core 握手后才显示已连接；未启动/未注册时显示未连接，不假报成功。`alarms` 权限仅用于 MV3 worker 休眠后的有限退避重试，不读取网页或扩大站点权限。重试耗尽后可以在扩展中明确重试。

首次确认后默认允许普通 HTTP(S) 页面，不设复杂模式。新旧升级均不能省略范围确认和 Chrome 必要权限；旧逐页版本的启用偏好不自动升级为全部网页访问。重连可按最新策略建立新会话，但绝不恢复旧 ref、旧动作队列或重放结果未知的点击。暂停/接管会阻止自动恢复，需用户明确继续。Lumi 可选的“自动维护连接注册”需用户明确选择，只维护同身份、本安装的升级路径，未知/其他安装的注册不会自动覆盖。

更新旧开发包后请在 Chrome 重新加载扩展并确认显示官方 ID；旧 ID 对应会话失效。Lumi 会对旧自有身份迁移另行确认，不应保留两个开发版同时控制。此公钥不是私钥，也不是对未打包代码的防篡改证明；未执行 Web Store 发布。

## 禁止单个链接

在 Browser User 添加链接后立即生效，取消相关动作并停止该页访问；MCP 不能修改列表。匹配使用标准 URL 的 `origin + pathname`，忽略查询参数与 `#fragment`，但不扩大为整个域名：`https://example.com/orders?id=1` 与 `?id=2` 都匹配 `/orders`，`/orders/` 是另一条路径。带用户名密码的 URL 拒绝保存；`file:`、`chrome:` 等始终不支持。

禁止项移除后允许重新接入，但不会解除用户对标签页设置的暂停/接管。每次读取与输入都复核策略版本与当前页面；已送达 Chrome 的动作无法撤回。

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

## 品牌素材

扩展图标直接复用 Lumi 应用素材：16/32/48px 来自 Lumi `src-tauri/icons/icon.ico` 对应图层，128px 来自 `128x128.png`，未重画。源仓库 https://github.com/LumiPlug/Lumi ，素材版本 `0cb8e894de5392d26af49018017ba78500cacc35`；保留原 MPL-2.0 来源说明（见 `extension/icons/LICENSE.txt`）。副标题描述用途，不承诺商店搜索排名或已上架。

为避免无限占用浏览器调试连接，开发版同时接入上限为 200 个标签页；超限/传输截断会在扩展状态明确提示。关闭标签后可补入符合规则的页面。权限范围“全部普通网页”不代表无限并发连接。
