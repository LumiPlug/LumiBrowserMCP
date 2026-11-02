# 验证记录

当前为0.4 Lumi集成开发预览：本仓库只包含扩展。独立adapter源码与安装脚本已迁移到Lumi架构，旧commit保留用于回退，不继续发布旧产品包。

迁移前已在 Lumi PR #17 的平台CI确认真实HTTP MCP → Core → OS IPC → Native Host → 模拟Chrome帧往返，多客户端按一个共享控制域串行。macOS 460项测试通过；Windows平台特有既有测试有明确跳过，浏览器链路测试实际执行通过。

本仓库的测试覆盖官方公钥ID/品牌PNG尺寸、ready握手/退避重连、默认普通网页访问与精确禁链策略、Chrome权限撤销/用户hold、授权/跨源/epoch、失效ref与语义替换、遮挡/焦点、取消/unknown、中文输入及通用ZIP确定性。最终精确commit与CI结果见PR #1验证评论，不把旧版本成功run当本版通过。

首次范围确认与Chrome主机权限仍需用户实际操作。真实Chrome、Windows/macOS桌面输入、125%与多显示器由用户实机测试；未在用户电脑安装、注册或自动验收。Lumi原生包完整构建状态以PR #17为准。无Web Store发布或正式发行者签名声明。
