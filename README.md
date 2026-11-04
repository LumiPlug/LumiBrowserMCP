# Lumi Browser — AI Browser Automation & MCP

**本仓库现在只交付一份跨 Windows/macOS 通用的 Chrome MV3 扩展。** MCP 与连接管理运行在 [Lumi](https://github.com/LumiPlug/Lumi) 的既有 Core 进程；扩展通过固定 loopback WebSocket 直连，不安装 Native Host、不启动独立适配器进程。

> 0.5.3 开发预览版改进了自定义菜单项的识别。Lumi v0.1.7-preview.28 可使用现有快照和点击工具。新建标签页、当前页导航和刷新另需提供相应 MCP 工具的 Lumi Core。

## 三步使用

1. 下载本仓库成功 Actions run 的 `lumi-browser-extension`，校验产品 ZIP 的 SHA256 并解压。在 `chrome://extensions` 加载含 `manifest.json` 的目录。官方公钥固定 ID 为 `hfhigjgopbjmojflbhhnahpfpnmiaman`，无需复制粘贴。
2. 打开 Lumi → 设置 → **Browser User**。“安装插件”仅打开官方固定商店页，不自动安装；开发预览扩展仍可按上一步加载。点击“检查连接”，确认范围后等待真实扩展连接；连接成功后可用“关闭连接”停用。官方扩展身份已内置，无需填写 ID。不需另配第二个 MCP 服务；Agent 使用已有 Lumi MCP 连接方式。
3. Chrome 安装/升级扩展时确认普通 HTTP(S) 网站权限；连接 Lumi 后页面默认允许并自动接入，无需逐页点击允许。在扩展点击“禁止此页”可把当前链接规则持久同步到 Lumi；点击“允许此页”恢复。Agent 使用 `Lumi.browser_list_sessions` 获取当前允许的会话。

扩展不移动系统鼠标；默认保持后台操作，仅显式调用 activate_tab 或 open_tab(active=true) 时将标签及窗口置前。弹窗仅显示连接状态及允许/禁止此页按钮。Chrome 停止调试与内部安全接管仍优先于自动接入；明确点击“允许此页”才恢复当前标签页。跨页、Core 停止或通信断线会失效旧会话；连接恢复后只为仍允许且未暂停/接管的标签页创建新会话。

**所有接入 Lumi 的 Agent 共享一个控制域，操作串行，不是逐 Agent 独立授权。** Browser User 默认关闭，MCP 工具不能自行启用、改禁止列表或代替 Chrome 权限确认。

## 自动连接与必要确认

扩展启动、浏览器启动、打开扩展或通信中断后会自动尝试连接正在运行且已启用 Browser User 的 Lumi。经过首次信任登记或已固定凭据认证，以及加密 ready/policy 后才显示可用；Core 未启动或关闭连接时显示未连接，不假报成功。`alarms` 权限仅用于 MV3 worker 休眠后的退避重试，不读取网页或扩大站点权限。断线后按 Chrome 118 的最小间隔，每分钟仅探测一次通信；打开弹窗会立即尝试。Lumi 关闭连接后这些探测不能将其重新启用。Chrome 休眠或系统调度可能推迟 alarm；若错过首次登记窗口，可在 Lumi 重新点击连接，不能把计划间隔当作实机时限保证。

首次确认后默认允许普通 HTTP(S) 页面，不设复杂模式。新装与升级均以 Chrome 实际授予的网站权限为前提；旧的 lumiAutoConsent 缺失或 false 不再额外阻止默认允许。明确禁链和安全接管保持有效。重连可按最新策略建立新会话，但绝不恢复旧 ref、旧动作队列或重放结果未知的点击。暂停/接管会阻止自动恢复，需用户明确继续。0.5.1 不显示配对码或配对确认：点击 Lumi 连接会打开 120 秒首次登记窗口，扩展自动以 TOFU（首次使用时信任）固定凭据。**首次连接无法识别本机恶意冒充，不能把密钥证明理解为已验证 Lumi 的本地身份。** 后续校验已固定凭据，不会因认证失败自动擦除或降级；凭据不进入 URL 或日志。

更新旧开发包后请在 Chrome 重新加载扩展并确认显示官方 ID；旧 ID 对应会话失效。Lumi 会对旧自有身份迁移另行确认，不应保留两个开发版同时控制。此公钥不是私钥，也不是对未打包代码的防篡改证明；未执行 Web Store 发布。

## 禁止单个链接

弹窗“禁止此页”先立即取消当前页控制，再通过一次性页面上下文向 Core 保存规则；只有收到策略广播和成功确认才报告同步完成。断线、导航变化或超时不会伪报成功，也不自动重放修改。MCP 不能修改列表。匹配使用标准 URL 的 `origin + pathname`，忽略查询参数与 `#fragment`，但不扩大为整个域名：`https://example.com/orders?id=1` 与 `?id=2` 都匹配 `/orders`，`/orders/` 是另一条路径。带用户名密码的 URL 拒绝保存；`file:`、`chrome:` 等始终不支持。

Core 禁止项移除不自行解除标签页安全接管；用户在扩展明确点击“允许此页”才解除当前标签页接管。每次读取与输入都复核策略版本与当前页面；已送达 Chrome 的动作无法撤回。

## MCP 工具（由 Lumi 提供）

`Lumi.browser_list_sessions`、`Lumi.browser_snapshot`、`Lumi.browser_read_text`、`Lumi.browser_click`、`Lumi.browser_fill`、`Lumi.browser_scroll`、`Lumi.browser_wait_for`。

扩展内部协议仍使用对应不带前缀的工具名。`ref` 是临时节点/语义标识，不是可静默重新定位的 selector。已派发动作结果未知时返回 `outcome_unknown`，不得自动重放。

## 旧预览版迁移

如果已安装独立 adapter：退出旧 MCP 客户端，使用旧包自带卸载脚本移除旧 Native Host；再从 Lumi 的 Browser User 点击“检查连接”并确认。移除旧客户端的 `lumi-browser` 独立 MCP 条目，保留已有 Lumi MCP 配置。0.5.1 不再读取或依赖旧宿主注册。

旧独立实现留在 Git 历史 commit `293951b66e513b7b28475be9382530ba2ab0140b`，仅用于回退/旧版卸载，不作为当前交付。不要同时运行旧 broker 和新 Lumi 链路。

## 开发与验收

```sh
npm ci
npm run check
npm test
npm run build
node fixtures/server.mjs
```

开发测试需要 Node 22+；扩展用户不需要安装 Node。`dist/lumi-browser-extension.zip` 解压后直接加载。Actions 在三种系统测试，最后只输出**一份**通用扩展 ZIP 和 SHA256。WebSocket 服务复用 Lumi Core 进程，参见 Lumi 的 [Browser User 文档](https://github.com/LumiPlug/Lumi/blob/feat/browser-user-integration/docs/BROWSER_USER.md)。

真实 Chrome、订单流程、中文输入、125% 缩放、多显示器及跨应用鼠标验收仍交用户进行；模拟 Chrome API 测试与平台 CI 不等于实机验收。详见 [架构](docs/ARCHITECTURE.md)、[验收](docs/ACCEPTANCE.md)、[验证记录](docs/TEST_REPORT.md)。

## 品牌素材

扩展图标直接复用 Lumi 应用素材：16/32/48px 来自 Lumi `src-tauri/icons/icon.ico` 对应图层，128px 来自 `128x128.png`，未重画。源仓库 https://github.com/LumiPlug/Lumi ，素材版本 `0cb8e894de5392d26af49018017ba78500cacc35`；保留原 MPL-2.0 来源说明（见 `extension/icons/LICENSE.txt`）。副标题描述用途，不承诺商店搜索排名或已上架。

为避免无限占用浏览器调试连接，开发版同时接入上限为 200 个标签页；超限/传输截断会在扩展状态明确提示。关闭标签后可补入符合规则的页面。权限范围“全部普通网页”不代表无限并发连接。

配对凭据不匹配时不会自动抹除或替换旧凭据；错误状态下可明确确认“重新配对”。扩展只清除自己的凭据，还需在 Lumi 同样确认重新配对，随后在新的登记窗口自动首次信任；单边重置不代表已经连接。

## 标签页导航

`Lumi.browser_open_tab({url})` 在后台新建标签页。`Lumi.browser_navigate({sessionId, url})` 在指定标签页打开网址，`Lumi.browser_reload({sessionId})` 刷新该页。目标必须是允许的 HTTP(S) 网址。返回 dispatched 表示 Chrome 已接收操作；加载后重新列出会话并获取快照。结果未知时不得自动重试。需要同时更新 Lumi Core 和扩展。

## 网页截图与坐标点击

`Lumi.browser_screenshot({sessionId})` 返回 JPEG 图片和 captureId。图片左上角为原点，坐标单位为 CSS 像素，图片尺寸等于视口尺寸。`Lumi.browser_click_at({sessionId, captureId, x, y})` 执行一次左键点击。截图标识一次性使用，30 秒后过期；导航、滚动、窗口尺寸及缩放变化使截图失效。网页动态内容可能变化，点击后重新观察。截图过大时缩小窗口重试。页面暂停、接管及禁止规则仍生效，结果未知的输入禁止自动重试。仅支持网页可视区域。需要 Lumi 与扩展同时升级至提供这两个工具的版本。

## 2026-11-04 本机直接连接更新

此节取代前文关于持久信任、120 秒登记窗口和重新配对的描述。Browser User 开启后，扩展自动连接固定 loopback 端口；每次连接以临时 ECDH 密钥协商建立加密会话，不保存跨连接凭证，不需要用户重新配对。升级自动删除本功能拥有的旧配对记录。Chrome 扩展固定身份、HTTP(S) 网页规则、暂停、用户接管、串行控制和不重放不确定操作继续生效。扩展和 Lumi 均需升级。本机进程可以伪装服务或来源，此模式不验证已配对设备的身份连续性。Lumi MCP 面向 Agent 的令牌独立保留。

## 常用浏览器操作（0.5.6）

新增 `Lumi.browser_activate_tab`（标签及所属窗口置前）、`close_tab`、`go_back`、`go_forward`、`hover`、`press_key`、`select_option`、`set_checked`。`open_tab` 的可选 `active: true` 将新页置前；省略保持后台打开。`click` 支持 `button`（left/right/middle）和 `clickCount`（1/2）。键盘仅支持页面按键与 Shift。原生下拉按 value 选择，勾选操作按目标状态执行，已满足时不重复点击。导航检查历史目标规则，关闭/导航后重新读取会话；任何结果未知的操作不得自动重试。此扩展需要同时更新 Lumi Core，现有权限不扩大。

## 0.1.8 / 0.6.0 扩展范围

实现实时标签元数据、条件等待、独立策略校验的 frame 文档令牌、可访问性树与 Shadow DOM 语义操作、指定文件上传、任务关联下载跟踪、JavaScript 弹窗、显式启用的有界网络/console 诊断、指定响应正文、拖拽、整页/元素截图、结构化表格、PDF 和可恢复的移动端/弱网/触摸模拟。

接口保持白名单；不开放任意 JS/CDP。iframe/语义操作明确使用 DOM 合成事件，不承诺网站信任事件。文件输入仅附加文件、不自动提交。下载仅返回本任务关联项，不读取用户全部下载历史。网络默认不记录 headers、cookies、request body，正文需单独调用。诊断与临时文件受会话/策略约束、数量及大小有界。产物分块传给 Core 并保存在专用 browser-artifacts 目录，不允许覆盖任意路径。PDF 若当前 Chrome 不支持返回明确 unsupported，不伪造成功。

版本 Lumi 0.1.8、插件 0.6.0；新增 downloads 权限。发布前必须通过独立提交内容的测试和真实 Chrome 验证，之后提交两仓库、合并 main 并打包。
