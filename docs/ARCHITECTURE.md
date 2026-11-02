# 架构与边界

## 产品与通信

用户最终确认：产品是 Chrome 扩展；允许本地 Agent 自动启动无 GUI 的 MCP 适配器。不是桌面应用，不含托盘，不要求手工启动常驻服务。

`本地 Agent → MCP stdio 适配器 → 本机 IPC broker ← Chrome 启动的 Native Messaging host ← MV3 扩展 → CDP`

Chrome 的 Native Messaging host 由 Chrome 启动，与 Agent 启动的 stdio 进程不是同一进程，所以存在最小本机 IPC 转发层。MCP stdout 使用其协议，Native Messaging stdout 使用 4 字节长度前缀 JSON，日志只写 stderr，二者不得混用。broker 按需启动，最后 MCP 客户端结束后回收，不能遗留常驻服务。

## 授权与身份

Native Messaging manifest 仅允许用户安装时指定的扩展 ID；本机 IPC 限制当前用户，不能监听公网。首次宿主注册是安装步骤，不在源码构建时执行。所有会话仍由用户在扩展 popup 授权，Agent 只能读取/操作授权会话，不能自行建立授权、恢复暂停或绕过接管。多客户端退出与取消必须清理其在途和排队请求。

## 组件

- popup：授权、状态、暂停、接管、断开，诊断测试命令。
- service worker：授权会话、串行操作队列、epoch、Native Messaging 通信；通过 chrome.debugger 执行 CDP Input。
- 页面辅助程序：隔离上下文快照、ref、身份/语义校验、滚动和遮挡检查、pointer-events:none 虚拟光标。
- 适配器：MCP 工具 schema、JSON RPC、进程/IPC 生命周期、请求响应路由和取消。断线及超时不重放未知副作用。
- CI：扩展 ZIP、Windows/macOS 无 GUI 适配器包、SHA256，以及测试报告。

## 会话、取消与结果未知

会话 ID 随授权随机生成，绑定 tab、HTTP(S) origin 和状态。动作串行、捕获 epoch，并在异步等待后和副作用前核验。暂停/接管/断开提升 epoch。跨来源或调试器断开撤销会话；service worker 重启不得从磁盘恢复授权。

CDP 输入不是跨进程原子事务。滚动和悬停也可能触发页面事件；副作用开始后遇到取消/断线返回 outcome_unknown 并暂停，不宣称没有点击、不自动重放。用户接管前已经送达 Chrome 的事件不能撤回。

## Ref 与坐标

ref 只代表最近快照中的原 DOM 对象和语义指纹。节点替换、离开文档或复用为另一订单即失效，不能通过相似 selector 静默重新匹配。操作前验证、滚动、检查禁用和遮挡，再以 viewport CSS 像素发 CDP。虚拟光标用相同坐标，不手动乘 DPR，不调用系统鼠标或窗口激活接口。

## 已知限制

普通顶层 DOM 是首版范围；跨源 iframe、封闭 Shadow DOM、canvas 不声明支持。真实 Windows/macOS Chrome、跨应用选区和多显示器需分别验收。Chrome Web Store、发布签名、商店审核不是当前交付的一部分。源码或模拟测试不能证明全部真实网站行为正确。
