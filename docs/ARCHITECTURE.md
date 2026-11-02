# 架构与边界

## 当前产品边界

LumiBrowserMCP 只有 Chrome MV3 扩展。Lumi 内置 Browser User 服务复用既有 Registry/MCP、stdio proxy、Core 生命周期；随 Lumi 打包的 Native Host 只连接已运行 Core，不自启后台 broker。

`Agent → Lumi 现有 MCP → Core BrowserService → 同用户 IPC → 随包 Native Host → 扩展 → chrome.debugger/CDP`

本仓库保留 popup、service worker、隔离页面辅助程序及测试。Windows/macOS 共用同一扩展 ZIP；本地宿主由 Lumi 仓库构建，不在此仓库再次发布。

## 授权与身份

Lumi Browser User 默认关闭，启用及注册须桌面主窗口用户确认，MCP 无此管理能力。Native Messaging manifest 精确指定扩展 ID。每个标签页仍需用户在扩展授权；不会从磁盘恢复旧授权。

首版 Lumi MCP 使用共享凭据与无状态 HTTP，因此所有 Agent 是单一共享控制域，全局串行，**不提供逐 Agent 身份隔离**。不把请求 ID 当可信客户端身份；同用户恶意程序不在 IPC 强隔离承诺内。

## 会话与精确输入

会话随机 ID 绑定标签页、来源、状态和 epoch。跨源导航、关闭页面、调试器/native断开、Core停用均撤销。每次副作用前检查epoch、原节点及语义、遮挡与焦点；使用 viewport CSS 像素，不乘DPR，不激活窗口。

快照更新 ref 集合；节点被替换或虚拟列表同节点语义变化会失效，不按相似selector重试。虚拟 Lumi 光标 pointer-events:none，不拦用户点击。

CDP 输入不是原子事务；滚动、悬停也可能触发页面事件。派发后取消或结果不明返回 `outcome_unknown` 并暂停，不宣称没有点击，不自动重放。已发输入不可撤回。

## 传输契约

Native Messaging 使用4字节小端长度加JSON；消息为request(id/tool/args)、response(id/result或error)、sessions、cancel。Lumi负责本机IPC/工具schema/生命周期，本扩展只接受用户授权的sessionId。原生消息有界、重复请求不重放；服务worker重启fail closed。

只支持普通顶层DOM；跨源iframe、closed Shadow DOM和canvas不声明支持。页面内容仅作为数据，不绕过验证码、登录确认或系统权限。真实平台、商店发布/签名不是模拟测试可证明的事项。
