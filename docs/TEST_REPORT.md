# 验证记录

当前为0.5.1 Lumi集成开发预览：本仓库只包含扩展。连接服务已内嵌Lumi Core，以loopback WebSocket直连扩展；不发布或执行独立宿主。旧commit仅作历史记录。

迁移前已在 Lumi PR #17 的平台CI确认真实HTTP MCP → Core → OS IPC → Native Host → 模拟Chrome帧往返，多客户端按一个共享控制域串行。macOS 460项测试通过；Windows平台特有既有测试有明确跳过，浏览器链路测试实际执行通过。

本仓库的测试覆盖官方公钥ID/品牌PNG尺寸、ready握手/退避重连、默认普通网页访问与精确禁链策略、Chrome权限撤销/用户hold、授权/跨源/epoch、失效ref与语义替换、遮挡/焦点、取消/unknown、中文输入及通用ZIP确定性。最终精确commit与CI结果见PR #1验证评论，不把旧版本成功run当本版通过。

首次范围确认与Chrome主机权限仍需用户实际操作。真实Chrome、Windows/macOS桌面输入、125%与多显示器由用户实机测试；未在用户电脑安装、注册或自动验收。Lumi原生包完整构建状态以PR #17为准。无Web Store发布或正式发行者签名声明。

0.5 新增精简 popup 模拟测试、两步 Core 策略请求/ACK验证、断线与导航race、接管不覆盖回归。实际 Chrome 弹窗与用户报告 ERR_FILE_NOT_FOUND 仍未实机复现；打包资源静态校验通过不能证明该问题已解决。

新增真实 WebCrypto 客户端测试覆盖承诺/揭示、自动TOFU登记与服务端证明后落盘、明文ready拒绝、加密序号重放拒绝、存储隔离失败关闭。测试使用模拟 WebSocket，不等于 Chrome 实机或真实跨平台发行验收。

0.5.1 删除配对码与人工确认 API，独立 enroll_* 协议自动首次固定凭据；首次身份未验证，不把密钥连续性测试称作本机身份验证。
