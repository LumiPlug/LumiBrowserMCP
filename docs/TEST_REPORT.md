# 验证记录

当前为0.5.2 Lumi集成开发预览：本仓库只包含扩展。连接服务已内嵌Lumi Core，以loopback WebSocket直连扩展；不发布或执行独立宿主。旧commit仅作历史记录。

迁移前已在 Lumi PR #17 的平台CI确认真实HTTP MCP → Core → OS IPC → Native Host → 模拟Chrome帧往返，多客户端按一个共享控制域串行。macOS 460项测试通过；Windows平台特有既有测试有明确跳过，浏览器链路测试实际执行通过。

本仓库的测试覆盖官方公钥ID/品牌PNG尺寸、ready握手/退避重连、默认普通网页访问与精确禁链策略、Chrome权限撤销/用户hold、授权/跨源/epoch、失效ref与语义替换、遮挡/焦点、取消/unknown、中文输入及通用ZIP确定性。最终精确commit与CI结果见PR #1验证评论，不把旧版本成功run当本版通过。

首次范围确认与Chrome主机权限仍需用户实际操作。真实Chrome、Windows/macOS桌面输入、125%与多显示器由用户实机测试；未在用户电脑安装、注册或自动验收。Lumi原生包完整构建状态以PR #17为准。无Web Store发布或正式发行者签名声明。

0.5 新增精简 popup 模拟测试、两步 Core 策略请求/ACK验证、断线与导航race、接管不覆盖回归。实际 Chrome 弹窗与用户报告 ERR_FILE_NOT_FOUND 仍未实机复现；打包资源静态校验通过不能证明该问题已解决。

新增真实 WebCrypto 客户端测试覆盖承诺/揭示、自动TOFU登记与服务端证明后落盘、明文ready拒绝、加密序号重放拒绝、存储隔离失败关闭。测试使用模拟 WebSocket，不等于 Chrome 实机或真实跨平台发行验收。

0.5.1 删除配对码与人工确认 API，独立 enroll_* 协议自动首次固定凭据；首次身份未验证，不把密钥连续性测试称作本机身份验证。

0.5.2 根因修复：旧 lumiAutoConsent 隐藏门槛及 popup 混淆网站权限/页面策略。回归覆盖新装、旧 false、导航、新标签、权限撤销恢复、禁链与hold；改为 Chrome required HTTP/HTTPS 权限。按用户要求仅运行检查与测试，未重新打包交付物、未实机安装。

## 2026-11-05 常用操作补齐（本机）

- 插件版本 0.5.6：`npm run check`、108 项 Node 测试通过；通用 ZIP 构建成功。
- 同步 Lumi Core：`pnpm check` 完整通过（527 项 Vitest、TypeScript、ESLint、Rust fmt/check/clippy）。
- 真实 Chrome + Lumi MCP + 本机 HTTP 测试页：新页前台打开、activate_tab、悬停、双击、右键、Enter、原生 select 选择、复选框 true/false 与重复 true 不再点击、前进/后退、关闭后会话移除均验证成功。只使用本机测试数据，未提交任何外部业务表单。
- 自动测试额外覆盖禁用页面、非法历史 URL、参数白名单、Shift+Tab、窗口聚焦失败不重复创建、禁用下拉选项、ARIA mixed 状态。
- 未实测 Windows、多窗口/多屏、原生右键菜单后续选择、框架自定义下拉、多选 select；iframe、文件上传/下载、网络诊断不在本轮范围。右键仅派发网页鼠标事件，不控制 Chrome 原生菜单。

## 2026-11-05 扩展 0.6.0 / Lumi 0.1.8

以下记录补充上述历史版本，不将旧版本或模拟测试算作本版实机验收。

- 插件静态检查、130 项 Node 测试和确定性 ZIP 构建通过。
- 真实 Chrome + Lumi MCP + 本机测试页验证：开放 Shadow DOM 填写、封闭 Shadow DOM 的 AX 引用填写、跨域 iframe 快照/填写、文件选择、主动下载及页面下载监听/完成状态、原生表格提取、整页和元素 PNG、PDF 文件生成、鼠标拖拽、console/network 诊断和响应体脱敏、JavaScript confirm 读取/取消、关联新标签等待/关闭、移动视口/触摸/弱网设置与重置。
- 触摸使用刚获取的截图坐标，页面 touchend 回显 tapped；文件选择回显 upload.txt；拖拽回显 dropped。所有测试仅用本机测试文件，没有提交外部业务表单。
- 实机发现并修复：模态弹窗阻塞 CDP 输入请求；tabs.query 不接受 openerTabId；noopener 新标签需要 webNavigation 创建事件关联。新增对应回归覆盖。
- iframe 和 AX 写操作使用明确标识的 DOM 事件，不保证依赖 isTrusted 的网站兼容。表格仅提取当前已加载行；页面下载仅按完整 referrer 关联。PDF 对不支持 printToPDF 的目标返回 unsupported。
- 未实测 Windows 浏览器、多屏缩放、浏览器商店发布、所有前端框架；跨平台自动化以本次 GitHub CI 为准。

- 拖拽复测发现拖动文本/原生拖动可能阻塞 mouseMoved；使用 Input.setInterceptDrags 关联 dragIntercepted 并发送 dragEnter/dragOver/drop，成功/失败后关闭拦截，失败取消拖动。130 项测试包含被阻塞鼠标命令的回归。
