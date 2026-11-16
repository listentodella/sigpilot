# 外部 agent 与内置 AI 助手集成评估

评估日期：2026-11-13。

用户约束：外部不同 agent 接入是必需能力；内置 AI 助手先评估 Codex app-server 体积及终端方案。本轮核对官方文档、发布资产与 PXView 源码，没有实施新的接入功能、安装 agent 或运行第三方应用。

后续澄清：用户希望终端仅提供通用终端功能，不随 SigPilot 安装 Codex、Claude 或其他 agent。下述数百 MB 的引擎分发数据不属于这一通用终端方案的体积增量。

## 结论

建议分别交付外部 MCP 接入和内部对话界面，共用现有分析工作区与工具权限。

- 外部接入必须保留标准 Streamable HTTP 和 stdio 兼容路径，并提供相应客户端的注册入口，不绑定 Codex。
- 内置聊天可以调用用户已经安装的 `codex app-server`，无需在主安装包内捆绑 Codex；未安装时可提供可选引擎下载。
- 内置终端适合需要使用不同 CLI agent 的用户，可以作为补充入口。它节省的是界面集成工作，不能消除 CLI 引擎本身的体积。
- 按用户明确的通用终端范围，优先评估“打开系统/用户指定终端”及“内嵌终端”，两者均不捆绑 agent。原生聊天与可替换引擎适配层保留为后续独立选项。

## 1. 外部 agent 接入：必需能力

建议范围包括 Codex、Claude Code、Cursor、VS Code、Claude Desktop，以及其他支持标准 MCP transport 的客户端。

| 客户端类型 | 接入入口 | 验收要求 |
| --- | --- | --- |
| 支持 HTTP 的 CLI agent | 正确的 `mcp add` 命令和认证步骤 | 注册、发现工具、读取 demo、创建 marker、重启后恢复连接 |
| Cursor / VS Code 等图形客户端 | 安装链接或其服务器添加界面 | 无需用户自己查找配置文件；显示真实连接验证结果 |
| 只支持或更适合本地 stdio 的客户端 | 随应用交付的桥；支持时提供 MCPB 安装包 | 桥自动定位应用实例，用户无需输入连接文件路径 |
| 未预设的标准 MCP 客户端 | HTTP 地址和手动配置说明 | 清楚声明 transport、认证方式与当前支持限制 |

不能以“提供 Codex 登录”代替多客户端接入，也不能把内置终端作为外部图形客户端的唯一入口。客户端注册、授权与工具发现仍是独立步骤。各客户端支持状态应在真实客户端实测后声明，尤其包含 Windows 平台权限支持。

服务地址、凭据持久性、撤销、端口冲突和多实例路由按照 [接入体验调研](mcp-onboarding-benchmark.md)落实。

## 2. Codex app-server 的实际分发体积

本轮查询到最新正式版本为 [Codex rust-v0.168.0](https://github.com/openai/codex/releases/tag/rust-v0.168.0)，发布于 2026-11-13。

测量方法：在 Instabox 上流式读取该版本的官方 `.tar.gz` 资产，读取 archive member 大小并求和；不解压到磁盘、不执行其中程序。下载大小来自 GitHub 发布资产元数据。以下使用十进制 MB，即 1 MB = 1,000,000 字节。

| 平台 | app-server 程序文件 | 官方 app-server 配套包下载 | 配套包解压内容合计 |
| --- | ---: | ---: | ---: |
| macOS Apple Silicon | 214.0 MB | 136.2 MB | 351.3 MB |
| macOS Intel | 229.1 MB | 148.0 MB | 375.7 MB |
| Linux x64 | 254.7 MB | 159.2 MB | 424.1 MB |
| Windows x64 | 292.5 MB | 169.0 MB | 487.8 MB |

官方配套包除了 app-server，还包含 `codex-code-mode-host`、`codex-exec-server`、`rg`，以及平台资源。例如 Linux 包包含 `bwrap`，Windows 包包含 command runner 和 sandbox setup。构成可从 [该版本发布工作流](https://github.com/openai/codex/blob/rust-v0.168.0/.github/workflows/rust-release.yml)核对。

不能用单个 app-server 的文件大小作为完整分发成本，也不能在未验证运行路径之前删除配套程序。最终 SigPilot 安装包的增量还取决于压缩方式、签名与所需组件；本轮未构建联合安装包，表中不是该增量的实测值。表中也不是运行内存占用，内存和启动延迟需要后续运行评估。

### 三种引擎分发方式

| 方式 | 对主安装包的影响 | 代价 |
| --- | --- | --- |
| 捆绑官方配套包 | 增加约百余 MB 的下载内容、数百 MB 的安装内容 | 更新、签名、组件与版本管理都由 SigPilot 负责 |
| 复用已安装的 Codex CLI | 不新增一份 Codex 引擎；只增加 SigPilot 的适配代码 | 需检测程序路径、版本和协议兼容性，用户需要安装并登录 |
| 首次使用时下载可选引擎 | 主包不携带 Codex，启用该功能后增加上述引擎占用 | 需完整实现下载验证、安装、升级和卸载 |

使用现有 CLI 的 `codex app-server` 是官方支持的集成方式。可以由 Tauri 后端启动进程，通过 stdio 收发结构化消息，前端呈现聊天、工具执行与审批，不需要嵌入终端才能做到。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

## 3. 内置终端是否必要

### 仅提供通用终端时的体积

用户已明确不要求安装任何 agent。因此通用终端方案只计算 SigPilot 的终端代码和组件：

| 方式 | 增量构成 | 体积判断 |
| --- | --- | --- |
| 打开系统或用户指定终端 | 平台启动逻辑、终端选择和工作目录传递 | 不携带终端程序，预计对安装包几乎没有可感知的影响；未构建实测 |
| SigPilot 内嵌终端 | xterm.js、PTY/ConPTY 适配、进程与会话管理 | 前端核心约 0.35 MB；完整增量可按几 MB 的工程预算评估，未构建实测 |

SigPilot 已使用 Tauri 的系统 WebView，内嵌终端不需要为此再携带 Electron/Chromium。用户运行的 shell 和 CLI 使用已有安装，认证由相应工具负责；SigPilot 不需要因此新增模型 API key 设置。MCP 注册仍是独立能力，打开终端本身不会完成注册。

最终增量应通过同一平台、同一 release 配置下加入终端前后的构建对比测量；上述“几 MB”仅是实现预算，不是已经验证的上限。终端缓冲和子进程运行内存也不等于安装包体积。

终端方案是：SigPilot 的 WebView 显示终端组件，Rust 后端通过 PTY/Windows ConPTY 启动用户选择的 CLI agent，CLI 再通过 MCP 调用 SigPilot。

本轮读取 [xterm.js](https://github.com/xtermjs/xterm.js) 的 npm `@xterm/xterm` 6.0.0 包，核心 ESM 文件为 344,970 字节、CSS 为 7,112 字节；两者 gzip 后合计约 90.5 KB。整个 npm 包的解压大小为 5.9 MB，包含源码、类型和其他文件，不能全部算进应用运行资源。尚未实测 SigPilot 最终打包增量，PTY、插件、缓冲和进程管理也需要计入。

终端 UI 本身较轻，但 Codex CLI 仍是大型原生程序。同版本 Linux x64 的单个 CLI 官方压缩包为 125.4 MB，程序文件为 324.6 MB；若随应用捆绑它，并不会比 app-server 方案节省引擎体积。完整 CLI 配套包还更大。[Codex 发布资产](https://github.com/openai/codex/releases/tag/rust-v0.168.0)

| 比较项 | 原生聊天 + app-server | 内置终端 + CLI |
| --- | --- | --- |
| 使用已有安装 | 可以复用 | 可以复用 |
| 是否必须捆绑引擎 | 不需要 | 不需要 |
| 多种 CLI agent | 各自需要协议适配 | 适合运行不同交互式 CLI |
| 对话、工具结果与波形联动 | 可把采集引用、精确样本和证据呈现为专用组件 | MCP 仍可修改波形，终端输出主要由 CLI 控制 |
| 审批、历史与执行状态 | 需要实现结构化事件处理 | 主要沿用 CLI 界面，但需完整 PTY 行为 |
| 工程工作 | 引擎协议、登录、会话、取消、审批与视图 | 字体/ANSI、中文输入、尺寸调整、粘贴、滚动、退出及进程清理 |

不建议解析终端的 ANSI 文本来恢复结构化工具状态。终端可提供真实交互体验，但专业波形分析的原生聊天界面更容易展示证据、定位按钮和修改预览。

对于用户要求的通用终端，它可以直接提供自由的命令行入口，无需接入某个特定 agent 引擎。原生聊天是否实施应独立决定。

## 4. PXView 最新版本如何集成

本轮核对的是官方 [PXLogic/PXView](https://github.com/PXLogic/PXView) 仓库。查询时默认分支 `main` HEAD 与最新正式版 v1.6.7 对应提交为 `f98391f7bbef98baa2c056bc2ac9c877ba04e24e`，提交及版本发布于 2026-11-02。仓库推送时间不等于默认分支提交或正式版发布时间。[版本页](https://github.com/PXLogic/PXView/releases/tag/v1.6.7)

### 外部 agent

- MCP 服务在应用启动后运行，默认监听 `127.0.0.1:10110`，文档声明 Streamable HTTP。
- MCP 侧栏显示服务状态、地址与 Claude Code/Codex/OpenCode 的命令，提供复制和重启。
- 没有要求用户填写桥程序和实例文件路径。

这一点可借鉴固定地址和客户端入口。OpenCode 命令是 PXView 文档和源码中的写法，本轮没有独立验证其是否兼容当前 OpenCode，不应直接照抄成 SigPilot 的支持承诺。

证据：[MCP 使用指南](https://github.com/PXLogic/PXView/blob/f98391f7bbef98baa2c056bc2ac9c877ba04e24e/doc/MCP%E4%B8%8EWeb%E5%AE%A2%E6%88%B7%E7%AB%AF%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md)、[侧栏代码](https://github.com/PXLogic/PXView/blob/f98391f7bbef98baa2c056bc2ac9c877ba04e24e/PXView/pv/dock/mcpcontroldock.cpp#L102)。

### 自带聊天

PXView 使用 React Web 客户端。桌面侧栏按钮通过 `QDesktopServices::openUrl` 打开浏览器中的本机网页。仓库还包含该客户端的 Tauri 包装工程，其启动 PXView headless 子进程；本轮未验证正式安装包是否都交付这一路径。

用户设置 API Base URL、API Key 和 Model。客户端调用兼容 OpenAI 的 `/chat/completions`，取得工具调用后通过 MCP 调用 PXView，再把结果送回模型继续对话。因此它采用“自有聊天 UI + 模型 API + MCP”，并未在这一对话路径嵌入 Codex app-server 或终端。

API key 在该调用代码中是可选的：仅存在时发送 Authorization header。文档指导用户填写 key，但代码也能面向无需 key 的兼容服务；服务是否可用还取决于模型及接口兼容性。

证据：[LLM client](https://github.com/PXLogic/PXView/blob/f98391f7bbef98baa2c056bc2ac9c877ba04e24e/web/src/lib/llm-client.ts#L55)、[对话与工具调用循环](https://github.com/PXLogic/PXView/blob/f98391f7bbef98baa2c056bc2ac9c877ba04e24e/web/src/hooks/useAppStore.ts#L406)、[打开网页动作](https://github.com/PXLogic/PXView/blob/f98391f7bbef98baa2c056bc2ac9c877ba04e24e/PXView/pv/dock/mcpcontroldock.cpp#L244)。

### 可以借鉴、需要自行完善的部分

可以借鉴双入口、固定本机 MCP 地址、独立聊天和工具执行展示。SigPilot 应把原生聊天放进自己的侧栏，并利用现有采集和证据模型关联波形。

源码中模型设置连同 API key 保存到 localStorage；HTTP transport 包含通配 CORS 响应。SigPilot 应继续使用后端管理凭据和现有 MCP 认证/Origin 校验，不能因为参考了界面就移除这些机制。[设置保存代码](https://github.com/PXLogic/PXView/blob/f98391f7bbef98baa2c056bc2ac9c877ba04e24e/web/src/hooks/useAppStore.ts#L163)、[transport 代码](https://github.com/PXLogic/PXView/blob/f98391f7bbef98baa2c056bc2ac9c877ba04e24e/PXView/pv/api/mcp_transport.cpp#L880)

## 5. 推荐交付顺序

1. 完成多客户端外部 MCP 接入，包括稳定地址、认证、注册入口和真实客户端验收；这一项不依赖内置助手。
2. 通用命令行入口优先考虑打开系统/用户指定终端；若需要保持操作在 SigPilot 窗口中，提供内嵌终端，不捆绑 agent。
3. 原生 AI 聊天作为后续独立能力，定义可替换引擎接口：连接/登录、会话、发送与停止、事件、工具结果和审批。
4. 原生聊天可以复用已安装 Codex 的 app-server，并提供兼容模型 API 和本地模型适配器；不要求所有用户提供 API key。

后续验证需运行真实 app-server，覆盖登录、MCP 发现、demo 精确 marker、取消、权限和重连；测量启动延迟与内存峰值，并构建各平台安装包后报告实际增量。本轮体积是官方发布资产的静态测量，源码结论没有冒充运行测试。
