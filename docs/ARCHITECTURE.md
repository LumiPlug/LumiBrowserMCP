# 架构与边界

## 当前产品边界

LumiBrowserMCP 只有 Chrome MV3 扩展。Lumi 内置 Browser User 服务复用既有 Registry/MCP、stdio proxy、Core 生命周期；同一 Core 进程内监听固定 loopback WebSocket，不再运行 Native Host 或独立 broker。

`Agent → Lumi 现有 MCP → Core BrowserService → ws://127.0.0.1:43127/ws（认证加密）→ 扩展 → chrome.debugger/CDP`

本仓库保留 popup、service worker、隔离页面辅助程序及测试。Windows/macOS 共用同一扩展 ZIP；连接服务直接包含于 Lumi Core，不交付独立宿主。

## 授权与身份

Lumi Browser User 默认关闭，检查连接与首次配对须桌面主窗口用户确认，MCP 无此管理能力。WebSocket 服务严格核验扩展 Origin、Host 与路径；Origin 本身不能替代配对认证。用户首次确认普通 HTTP(S) 全部允许，并由扩展请求 Chrome 必要主机权限。旧逐页版本偏好不静默升级；Core 下发版本化禁止链接策略。不会恢复旧会话/ref/队列；重连只为允许且未暂停/接管的页创建新会话。

首版 Lumi MCP 使用共享凭据与无状态 HTTP，因此所有 Agent 是单一共享控制域，全局串行，**不提供逐 Agent 身份隔离**。不把请求 ID 当可信客户端身份；同用户恶意程序仍可阻断 loopback，但不能仅冒充 Origin 获得配对后的页面数据。

## 会话与精确输入

会话随机 ID 绑定标签页、来源、状态和 epoch。跨源导航、关闭页面、调试器/WebSocket断开、Core停用均撤销。每次读取和副作用前检查当前 URL、禁止策略版本与epoch、原节点及语义、遮挡与焦点；使用 viewport CSS 像素，不乘DPR，不激活窗口。

快照更新 ref 集合；节点被替换或虚拟列表同节点语义变化会失效，不按相似selector重试。虚拟 Lumi 光标 pointer-events:none，不拦用户点击。

CDP 输入不是原子事务；滚动、悬停也可能触发页面事件。派发后取消或结果不明返回 `outcome_unknown` 并暂停，不宣称没有点击，不自动重放。已发输入不可撤回。

## 传输契约

消息经 WebSocket AES-GCM 严格递增序列帧传递，应用层为ready、policy(epoch/blockedUrls)、request(id/tool/args/policyEpoch)、response(id/result或error)、sessions、cancel。Lumi负责loopback服务/工具schema/生命周期，本扩展只接受最新策略允许且有Chrome访问权限的sessionId。加密与明文消息均有界、重复请求不重放；服务worker重启fail closed。

只支持普通顶层DOM；跨源iframe、closed Shadow DOM和canvas不声明支持。页面内容仅作为数据，不绕过验证码、登录确认或系统权限。真实平台、商店发布/签名不是模拟测试可证明的事项。

禁止匹配规则：URL解析后移除query和fragment，精确origin+pathname；拒绝URL credentials与非http/https；不模糊子域或尾斜杠。不把页面内容当策略指令，策略只能由Lumi用户设置或可信扩展当前页操作维护。

## 0.5 当前页规则

可信扩展 popup 读取当前标签并申请 `page_context`（连接/epoch 绑定、一次性、30秒），再次核验当前URL后提交 `page_rule`，变更请求不携带任意URL。Core 持久保存并先广播 policy 再返回 ACK；扩展同时核验 ACK 与当前策略。关闭 Core 不可由扩展或 MCP 绕过启用。弹窗不显示内部诊断与会话控制，但保留持久 hold、取消队列与未知结果不重放边界。传输退避后每30分钟探测通信，弹窗打开立即探测，不恢复旧 refs 或动作。

## 配对与通信安全

首次连接双方先承诺公钥/nonce，再揭示并验证承诺，通过 P-256 ECDH 导出六位 SAS；短码只在本地计算。用户核对并在两端确认同一次 pairingId。扩展先验证服务器 HMAC 证明才持久保存共享密钥；重连先验证服务器，再给客户端证明。ready/policy/页面数据均通过具备严格序列号的方向独立 AES-GCM 通道，不接受明文 ready。凭据只存 Chrome TRUSTED_CONTEXTS storage.local，不通过网络传送原始秘密。

传输入口固定 127.0.0.1:43127/ws；不接受可配置外部地址。未认证消息上限4KiB、入站排队最多16帧/2MiB，发送队列有界且可合并未发送的会话快照。普通输出预算450KiB，snapshot预算400KiB，避免加密后超帧。关闭连接销毁通道、取消操作并失效会话；定时探测不能启用已关闭的Core。旧凭据认证失败不会自动降级或抹除凭据。
