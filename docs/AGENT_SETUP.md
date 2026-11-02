# 授权本地 Agent 一次性配置 Lumi browser

本流程针对**能够在用户电脑执行命令、且已获得本次安装授权**的 Agent。聊天云端 Agent、只会调用远程工具的 Agent 不能替代本机安装。不要在未授权的电脑上执行。

## 用户仍需完成

1. 从私有仓库 `LumiPlug/LumiBrowserMCP` 的一个明确 commit 对应的成功 Actions run 下载产物；扩展只有一份通用 ZIP，适配器按 Windows x64 / macOS Intel x64 / macOS Apple Silicon arm64 选择。
2. 在 Chrome 扩展管理页加载解压后的扩展，复制实际 32 字符扩展 ID。开发者模式和调试器授权提示由用户确认，Agent 不绕过。
3. 告诉 Agent **要配置哪个 MCP 客户端**，并批准本次用户级安装与该客户端配置修改。首版自动配置支持 Codex；其他客户端生成 snippet，不能声称自动写入所有客户端。

## 可复制给本地 Agent 的任务

> 请在这台电脑安装 Lumi browser 的按需 MCP 适配器。目标仓库为 LumiPlug/LumiBrowserMCP，使用我指定的 commit / 成功 Actions run，不下载 latest、第三方镜像或未知脚本。扩展 ID 为【填入实际 ID】，目标 MCP 客户端为【Codex 或其他名称】。先核对系统及 CPU、验证下载 ZIP 与同一可信 run 的 SHA256，再解压并检查安装说明。先执行适配器 `--setup` 的只读预演，把将写入的用户级 Native Messaging 注册位置和所选客户端配置位置告诉我；只有得到安装授权后才加 `--apply` 执行。不要管理员权限、不要常驻服务，不改其他 MCP 条目，不上传配置或凭据，不关闭系统安全功能。配置后运行 `--doctor`，分别报告适配器、注册、扩展连接的真实结果。Chrome 扩展加载、权限确认由我完成；如果未连接，报告待我操作，不伪称成功。

## 来源与校验

只使用同一已验证 commit 的官方仓库 Actions 产物（私有仓库需要登录）。先在执行任何二进制/脚本之前校验 ZIP：

- macOS：`shasum -a 256 文件.zip`
- Windows PowerShell：`Get-FileHash -Algorithm SHA256 -LiteralPath 文件.zip`

对照同一 run 下载的 `.sha256`。校验值用于传输完整性，**不能代替可信来源、发行者签名或系统安全检查**；不要将不可信压缩包自带的哈希当作可信认证。下载到的外层 GitHub artifact ZIP 中还有产品 ZIP 和 `.sha256`，校验的是后者所指产品 ZIP。

解压后的 `setup-manifest.json` 记录平台、CPU 架构、最终二进制 SHA256；setup 再次校验。macOS 是 ad-hoc 签名、Windows 尚无发行者签名。系统阻止执行时应检查来源和提示，不自动降低安全设置。

## 一次入口

适配器内置运行时，无需用户安装 Node。使用**下载解压目录中的二进制**执行 setup；不要在安装目录中覆盖正在运行的适配器。先退出使用 Lumi 的 MCP 客户端，更新后重新连接和授权。

macOS 示例（在解压目录）：

```sh
./lumi-browser-adapter --setup --extension-id 实际扩展ID --client codex
# 上一步只预演；获得安装授权后：
./lumi-browser-adapter --setup --extension-id 实际扩展ID --client codex --apply
```

Windows PowerShell 示例：

```powershell
.\lumi-browser-adapter.exe --setup --extension-id 实际扩展ID --client codex
.\lumi-browser-adapter.exe --setup --extension-id 实际扩展ID --client codex --apply
```

若 Codex 不在 PATH，可显式加 `--codex-path /绝对路径/codex`；如使用自定义 Codex home，可显式加 `--codex-home /绝对路径`。Windows 应指定原生 `codex.exe`，本流程不通过 `.cmd` / `.bat` shell 包装器执行。预演不启动 Codex，真实执行前再检查同名配置冲突。

`--client snippet` 用于其他客户端：只输出该安装路径的 MCP 配置，不擅自搜寻或修改其他客户端配置。Codex 通过官方 `codex mcp add` / `get` 命令管理 `lumi-browser` 条目；先备份本地配置，若同名条目属于其他配置则拒绝覆盖。备份可能含私密配置，应留在本机，不上传。

## 分层诊断，不把“安装了”说成“连通了”

```sh
./lumi-browser-adapter --doctor --extension-id 实际扩展ID
```

- **适配器可启动**：运行时与当前平台可执行，不代表 Chrome 已连接。
- **Native Host 注册**：名称、路径、扩展 allowed origin 对应正确，不代表客户端已启动。
- **扩展真实连接**：只有已有 broker 的真实 Native Messaging 宿主/扩展消息证据才通过；doctor 不启动常驻 broker，不点击网页、不申请授权。

完成安装后重启 MCP 客户端和 Chrome，在普通网页打开扩展并点击“授权此页”，再由 Agent 调用 `list_sessions`。setup 会在安装后自动执行 doctor。若输出 `installed: true` 但 `readiness.ready: false`，安装已经完成，只是连接尚未就绪；退出码非零是提醒待操作，不表示应重复安装。

没有运行中的 Agent 或没有授权标签页时，诊断“未连接/无会话”是正常待操作状态，不应自动重试点击或宣称端到端通过。退出最后一个 MCP 客户端后连接会回收。

## 恢复与卸载

可从保留的可信解压包执行同一 setup 命令加 `--uninstall` 先预演，再加 `--apply` 卸载；Codex 仅删除仍匹配本安装路径的 `lumi-browser` 条目，其他客户端需手动移除该条目。

只移除本项目 `lumi-browser` 的 MCP 配置条目以及本项目 Native Host。不要恢复整个旧配置文件覆盖后来新增的其他 MCP 配置；备份用于有针对性的人工恢复。原生宿主卸载使用安装目录内的 `uninstall-macos.sh` / `uninstall-windows.ps1`，Chrome 扩展由用户在扩展管理页移除。运行中客户端先退出；卸载不递归删除用户目录。

Codex 当前官方说明：<https://learn.chatgpt.com/docs/extend/mcp>。命令格式已核验；第三方客户端配置路径和更新格式不作假设。
