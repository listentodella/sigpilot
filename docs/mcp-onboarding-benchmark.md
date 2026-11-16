# MCP 接入体验调研与建议

调研日期：2026-11-13。2026-11-16 已开发固定 HTTP 默认入口（10531）、OAuth 授权与撤销、跨平台相同命令；本段以下保留当时的调研与分期建议。2026-11-14 已落实 Codex/Claude Code 注册命令、Cursor 安装链接与手动配置折叠；桥自动定位相邻连接文件。服务仍使用现有 stdio 桥与内部认证 HTTP，以下稳定 HTTP 地址及安装包方案仍为后续规划。本轮没有修改用户外部客户端配置。

用户已明确要求外部不同 agent 接入必须实现。Codex app-server 体积、内置终端取舍及 PXView 最新源码对照见 [内置 AI 助手集成评估](ai-assistant-integration-assessment.md)；内置助手不替代外部 MCP 接入。

## 结论

`command` / `args` 配置是常见的本地 MCP 接入方式，stdio 与 Streamable HTTP 都是标准 transport。此前 SigPilot 把安装路径、实例文件和配置合并工作直接交给用户。本轮已提供自动填写路径的 Codex/Claude Code 注册命令和 Cursor 安装按钮；JSON/TOML 作为手动兼容入口。

Saleae 已提供官方内置、实验性的 Logic 2 MCP Server。应以其新版官方文档为准，不能把旧版 gRPC Automation API 或社区 MCP 包装当作 Saleae 当前唯一的接入方式。

建议 SigPilot 提供稳定的本机 HTTP 地址作为主要接入通道，并按客户端提供安装链接、注册命令或安装包。已有 stdio 桥保留兼容性，原始 JSON/TOML 移至高级配置。

## Saleae 官方如何接入

[Saleae 官方 MCP 入门文档](https://docs.saleae.com/mcp/guides/getting-started)给出的流程是：

1. 在 Logic 2 的 **Settings > Automation** 中启用 **MCP Server**，也可以从底栏 **Automation** 进入。
2. 服务默认监听 `http://127.0.0.1:10530`。
3. 在 AI 客户端注册这个 URL，使用 Streamable HTTP。

官方给出的命令为：

```sh
claude mcp add --transport http logic2 http://127.0.0.1:10530
codex mcp add --url http://127.0.0.1:10530 logic2
```

文档标明当前为实验性，支持 Logic 8、Logic Pro 8、Logic Pro 16，Logic MSO 支持尚待推出。该入门页没有说明认证、端口冲突和多实例策略，因此不能据此推断其内部实现。

相比 SigPilot 的 stdio 方案，这种接法使用固定 URL，省去了桥程序路径，但客户端仍要注册服务。SigPilot 现在自动生成完整注册命令，用户同样只需复制执行，无需手动填写路径。它不是把 URL 或 JSON 发给聊天中的模型就自动接入。

Saleae 的旧版 [Logic 2 Automation API](https://saleae.github.io/logic2-automation/) 使用 gRPC。社区项目仍可在其上封装 MCP，例如 [hsoffar/saleae-logic2-mcp](https://github.com/hsoffar/saleae-logic2-mcp) 提供 stdio 与 JSON/TOML 配置，[ril3y/SaleaeMCP](https://github.com/ril3y/SaleaeMCP) 提供 Claude Code 注册命令。这些项目是第三方实现。

## 开源项目采用的接入方式

| 项目 | 实际提供的入口 | 对 SigPilot 的启示 |
| --- | --- | --- |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | 包管理器启动命令、手动 JSON、各客户端注册命令、VS Code/Cursor 安装按钮 | 同一个标准 MCP 服务可以提供多种便捷入口，JSON 可以作为兼容选项 |
| [MCP for Blender](https://github.com/ahujasid/mcp-for-blender) | `uvx mcp-for-blender setup` 检测客户端，让用户选择；安装插件、合并配置并备份；保留手动配置 | 最接近“桌面软件 + 本地服务 + agent”的安装体验，接入向导可以负责完整流程 |
| [GitHub MCP Server](https://github.com/github/github-mcp-server) | 远程 HTTP URL、VS Code 安装按钮、OAuth 或 PAT；另有本地版本 | 展示“添加 URL → 认证 → 使用”的流程；GitHub 是云服务，其部署位置不宜直接照搬到本地采集软件 |
| [Anthropic MCPB](https://github.com/anthropics/mcpb) | `.mcpb` 包包含本地 server 和 manifest，Claude macOS/Windows 可打开安装 | 可以打包现有原生桥，让支持的客户端负责安装和配置；这不是所有客户端通用的安装格式 |

这些是项目文档声明的接入流程，本轮没有实际安装或验证这些第三方客户端。

[Cursor 官方安装链接文档](https://cursor.com/docs/context/mcp/install-links)明确提供 MCP deeplink，点击后由 Cursor 提示安装。[Codex 官方文档](https://developers.openai.com/codex/mcp)提供 `mcp add` 注册与 `/mcp` 查看状态。[MCPB manifest](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md)支持原生 `binary` server 和安装目录变量，可避免用户输入自身用户名下的长路径。

## SigPilot 当前实现与缺口

当前桌面服务已经使用 Streamable HTTP，并连接共享的分析工作区。stdio 桥负责从私有实例文件取得随机端口和 bearer token，再转发请求。因此不需要重新实现分析工具才能提供直接 HTTP 接入。

当前的主要缺口是：

- 随机端口和每次启用轮换的凭据适合由桥读取，不能直接变成跨重启稳定的客户端 URL 配置。
- Codex/Claude Code 已提供注册命令，Cursor 已提供安装链接；Claude Desktop 和其他客户端仍使用手动配置，安装包与自动检测尚未实现。
- 桥握手自检能确认 SigPilot 服务可用，不能证明用户的真实 agent 已注册并连接。
- 当前本地路径方案适用于同机客户端。云端模型配合本机 Cursor/Codex 可以使用它；在云端运行的 MCP 客户端无法直接访问用户电脑的 `127.0.0.1`。

## 建议的产品流程

主界面应呈现：**启用 MCP → 选择 AI 客户端 → 连接/安装 → 客户端确认 → 验证工具可用**。

推荐入口：

| 客户端 | 主入口建议 | 兼容入口 |
| --- | --- | --- |
| Cursor / VS Code | 安装链接，由客户端处理注册 | 手动配置 |
| Codex / Claude Code | 一条官方 `mcp add` 命令；检测到 CLI 时可提供明确的“添加到客户端”操作 | 手动 TOML/JSON |
| Claude Desktop | `.mcpb` 安装包，交付本地桥 | 手动 JSON |
| 其他支持 HTTP 的客户端 | 复制稳定本机 MCP URL，附清楚的认证方式 | stdio 桥 |

用户在聊天中粘贴的内容应是连接后的验证任务，例如读取采集上下文、在指定样本添加 marker。服务器注册配置应交给客户端设置或安装入口。

## 实现顺序与验收

### 第一阶段：稳定 HTTP 接入与客户端注册入口

- 为桌面服务提供持久保存的本机端口与明确的 MCP endpoint，重启后保持地址；端口占用时明确报错，不静默换成使客户端配置失效的新端口。
- HTTP 接入需要配套认证设计。现有每次启用轮换的内部 token 不能直接复用于长期客户端配置。优先让支持的客户端通过兼容的授权流程取得凭据；其他客户端保留桥，或使用清楚说明的凭据配置。授权和撤销必须落实到服务端，不能只用客户端显示名识别用户。
- 客户端安装链接、CLI 命令和折叠的手动配置已在本轮实现；稳定 HTTP 地址与认证方案仍待后续开发。
- 区分“服务已启用”“自检通过”“观察到客户端连接/调用”。只有服务端观察到实际请求后才能展示对应连接状态；客户端显示名只能作为信息标签。
- 本轮尚未确定 SigPilot 的固定端口，示例和文档应使用最终真实地址，不复用 Saleae 的端口。

验收至少包含：真实 MCP 客户端注册、发现工具、读取 demo 采集，在样本 5 创建并读回 marker，应用重启后无需重新编辑路径/URL；停用或撤销后旧访问失效；端口冲突提示正确。授权能力不足的客户端应走明确的兼容流程。

### 第二阶段：本地安装包与维护

- 为已支持平台制作 `.mcpb` 桥包，桥在内部定位 SigPilot，用户无需填写连接文件路径。
- 安装向导检测可用客户端，用户选择目标后注册；优先使用官方 CLI 或 deeplink。必须直接合并配置时，只修改本服务条目、保留其他内容并备份。
- 补齐卸载、更新、重新授权和平台兼容提示；只展示经过实测的客户端支持状态。

### 第三阶段：发现与远程扩展

- 在安装与版本管理稳定后，考虑发布到 [MCP Registry](https://github.com/modelcontextprotocol/registry)或客户端市场。目录帮助发现公开的服务分发信息，不能替代本机服务注册和授权。
- 远程 agent 接入需要单独设计部署位置和中继，不能把本机 loopback URL 当作云端可访问地址。
- 多实例需要明确选择或路由策略，连接不得在用户不知情时切换到另一份采集。

实现本机 HTTP 时继续遵循 [MCP transport 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：绑定 loopback、验证 Origin，并实施认证。安装 deeplink 中不放入 bearer token；稳定地址不应意味着无条件访问本机采集。
