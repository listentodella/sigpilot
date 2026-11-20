# SigPilot MCP 接入与实现状态

桌面现已增加独立授权的设备枚举、能力查询、采集启动/状态/停止/释放工具，复用桌面真实 USB 与 Demo 驱动。配置、任务状态及资源限制见 [MCP 设备采集](mcp-capture.md)。下文离线工具及历史验收记录保留原来的范围。

当前实现覆盖 [规划](mcp-analysis-plan.md) 的共享基础、离线分析闭环、有限触发回放、离线设备能力编译、跨帧查询、协议事件与脉冲关联、独立证据报告、共享解码配置、多通道时序、完整结果保存和派生采集。桌面和 MCP 共用同一个 `WorkbenchService`、`GraphSession` 和语义文档。查询直接读取原始数字边沿，支持密集和稀疏采集。独立离线入口在启用文件打开和编辑权限时发布 29 个工具、3 个 Prompts、3 个分析提供者及 6 种 Resource 模板。

## 已实现工具

| 工具 | 当前行为 |
| --- | --- |
| `sigpilot_list_capabilities` | 返回真实注册的提供者、版本、参数/输出 schema、解码器状态、12 个离线触发设备配置和报告预算；发现时不启动解码或设备进程 |
| `sigpilot_get_context` | 无 session_id 时列会话；详情含采集身份、采样参数、标记/报告/配置/结果的独立版本及派生来源 |
| `sigpilot_query_edges` | 按通道、半开区间、方向查询精确边沿，可分页续查 |
| `sigpilot_measure` | 精确点脉宽/周期与区间占空比、边沿数、完整脉冲统计；时长与比例为有理数 |
| `sigpilot_get_analyzers` | 按独立配置版本和 GUI 顺序读取共享实例；返回稳定 ID、类型化配置和各后端的编辑/运行支持 |
| `sigpilot_configure_analyzer` | 创建、更新、删除共享 UART/I²C/SPI 解码器；配置 CAS、preview、重试和来源保留，需编辑权限，保存 `.pxl` 时持久化 |
| `sigpilot_run_decode` | 使用临时配置，或共享实例 ID 与预期配置版本，提交独立受监督的 Saleae 作业；冻结配置，后续编辑不改变已提交作业 |
| `sigpilot_query_frames` | 按结果集声明的真实字段类型、事件行、区间与文本查询；返回半开范围、帧引用与证据 |
| `sigpilot_query_frame_sequence` | 1–8 阶跨帧有限序列，按帧起点约束延迟；支持 I²C 同地址段范围，返回最早可完成链与证据 |
| `sigpilot_query_transactions` | I²C 同地址段的多个条件查询，返回父事务边界、重复 START 段、完整性和字段见证 |
| `sigpilot_correlate_pulses` | 类型化事件查询与原始完整脉冲关联，返回有符号采样时间差、独立帧/脉冲证据及扫描覆盖 |
| `sigpilot_get_evidence` | 校验并展开最多 8 个证据引用，支持有界原始边沿上下文 |
| `sigpilot_get_job` | 查询领域作业状态与结果摘要、字段 schema、结果集 ID、采集是否仍有效 |
| `sigpilot_cancel_job` | 取消当前凭据身份的指定作业；只终止该作业自己的进程组 |
| `sigpilot_validate_trigger` | 校验有限边沿/脉宽/电平序列、电平 phase、通道与窗口，报告已证明冲突及未决跨阶段约束 |
| `sigpilot_compile_trigger` | 将同一规则按显式离线设备配置编译，返回支持、拒绝或待验证候选；不探测、应用或启动硬件 |
| `sigpilot_simulate_trigger` | 提交离线规则回放作业，返回阶段候选、守卫/窗口拒绝、精确锚点和确认时间 |
| `sigpilot_run_analysis` | 统一调用 `sigpilot.pulse_width` / `sigpilot.range_measure` / `sigpilot.multichannel_timing` 可信注册提供者，参数使用 `parameters`；报告覆盖与证据 |
| `sigpilot_list_annotations` | 标注版本绑定的分页读取 |
| `sigpilot_get_reports` | 按报告版本列目录，或分页读取一个不可变证据报告；区分当前采集证据、保存后未重算证据和原采集归档 |
| `sigpilot_apply_reports` | 从 1–64 个有效证据创建不可变报告，或删除报告；独立版本、preview 和重试去重，需编辑权限；GUI 保存 `.pxl` 时持久化 |
| `sigpilot_export_report` | 以有界 UTF-8 JSON/Markdown 分块导出指定报告，保留精确整数与来源；客户端保存文件 |
| `sigpilot_get_results` | 列完整结果目录、读取摘要或分块读取完整 typed output；重开结果可用于帧/序列/事务查询 |
| `sigpilot_apply_results` | 显式保存完整所属作业结果或删除快照；独立版本、preview、重试，GUI 保存 .pxl 时写入 |
| `sigpilot_create_derived_capture` | 有界、单次、无级联窄脉冲替换，生成独立采集与来源记录；原采集和时间轴保留 |
| `sigpilot_apply_annotations` | 时间点、时间对、通道注释和区间注释原子创建/更新/删除，支持 preview、去重与版本检查；返回撤销 batch ID，需编辑权限 |
| `sigpilot_undo_annotations` | 撤销当前身份的批次，恢复原始来源、标签和证据；支持 preview、重试和顺序回退 |
| `sigpilot_focus_view` | 让已关联桌面的会话定位到请求区间，返回实际归一化视口 |
| `sigpilot_open_capture` | 独立离线服务器从授权根目录有界导入 `.pxcap` / `.pxl`，创建新会话；桌面桥不发布此工具 |

`sample`、采样率、样本数、版本等精确整数统一为十进制字符串。范围为 `[start_sample, end_sample)`。每页最多检查 4096 条边沿、返回 1000 项；响应和输入还受字节预算限制。完整脉冲由开沿与闭沿定义，采集首尾的未知边界不会伪装成完整脉冲。

## 桌面 HTTP 连接

桌面 **AI / MCP** 面板默认使用 Streamable HTTP，地址为 `http://127.0.0.1:10531/mcp`。macOS、Linux、Windows 使用相同的注册命令，无须指定可执行文件路径或 API key。

1. 启用 MCP；需要添加标记、配置解码器或保存分析资料时勾选允许编辑；需要启动设备或 Demo 时另勾选允许助手控制设备采集。
2. 选择 Agent，复制命令执行，或点击 Cursor 安装入口。首次认证时打开的浏览器页面提示回到 SigPilot；在 **AI / MCP** 面板核对客户端并允许连接。
3. 在 Agent 中查看 MCP 状态，发送面板提供的测试任务，确认真实工具调用。

```sh
codex mcp add sigpilot --url http://127.0.0.1:10531/mcp
claude mcp add --transport http --scope user sigpilot http://127.0.0.1:10531/mcp
```

Codex 可使用 `codex mcp login sigpilot` 重新认证，Claude Code 在 `/mcp` 中认证。CLI 工具由用户自行安装。Cursor 按钮打开官方 MCP 安装链接，由客户端确认；链接仅包含 URL。其他客户端可复制 URL 或展开手动配置，客户端须支持 Streamable HTTP 与 OAuth。Claude Desktop 的云端 connector 无法直接访问本机 loopback URL，因此不再展示未经验证的本地 HTTP JSON 配置。

```toml
[mcp_servers.sigpilot]
url = "http://127.0.0.1:10531/mcp"
```

```json
{"mcpServers":{"sigpilot":{"url":"http://127.0.0.1:10531/mcp"}}}
```

HTTP 使用本机 OAuth 授权码流程，包含 protected resource metadata、authorization server metadata、公开客户端动态注册、S256 PKCE、resource 绑定与短期授权码。浏览器页面只有等待动作，许可由桌面 Tauri 命令决定。客户端名称由客户端提供，不构成身份验证；用户应核对自己刚发起的连接。

访问 token 有效 1 小时，refresh token 有效 30 天，刷新轮换两种 token。服务只保存 token 的 SHA-256 摘要；每次授权产生独立身份，作业、撤销批次和查询 cursor 不会与其他客户端混用。授权记录在服务重启后保留；高级连接详情提供逐项撤销。禁用 MCP 停止监听，保留授权供再次启用；撤销后访问和刷新失效。权限修改会重启服务，Agent 需重新加载 MCP，已有授权可以复用。

默认端口持久保存为 10531，端口占用时报错，不静默换端口。用户可以在高级详情修改端口，随后更新 Agent URL 并重新授权。服务仅监听 `127.0.0.1`，验证 Host 与 Origin，不提供公网或云端直接访问。

Unix 偏好与授权文件要求当前用户所有、目录 0700 / 文件 0600。Windows 使用当前用户 DPAPI 加密持久化记录、拒绝 reparse 路径，并以独占共享模式锁定 MCP 实例。HTTP 接入不依赖 Unix 权限文件或 sidecar。各平台实现已纳入源码；实际验证的平台见下文，不能把统一配置视为三平台实机验收。

原有 Unix stdio 桥继续兼容：它读取相邻私有 `connection.json`，转发到同一 HTTP 服务；旧 `--instance-file` 配置仍可用。桥不再是默认入口，也不再是 HTTP 服务自检的前提。服务自检直接用 SDK 访问 HTTP，不能代替真实 Agent 注册验收。

命令及授权依据 [Codex MCP 文档](https://developers.openai.com/codex/mcp)、[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp) 和 [MCP authorization 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)；安装链接依据 [Cursor 文档](https://cursor.com/docs/context/mcp/install-links)。

## 独立离线连接

离线 `sigpilot-mcp` 进程拥有独立业务会话，适合无桌面环境分析文件。它与已运行的桌面状态无关联，`focus_view` 返回 `GUI_UNAVAILABLE`。

```json
{
  "mcpServers": {
    "sigpilot-offline": {
      "command": "/absolute/path/sigpilot-mcp",
      "args": ["--root", "/absolute/path/captures", "--allow-annotations"]
    }
  }
}
```

省略 `--allow-annotations` 时不发布标记、报告、配置、完整结果和派生采集写工具。省略 `--root` 时不发布文件打开工具；工具发现不准备 USB 设备。输入文件限制声明解压大小、压缩文件大小、ZIP 条目数、索引估算和总导入预算。单项导入文件预算 16 MiB，单捕获及索引估算 64 MiB，总导入估算 256 MiB，最多 32 个业务会话。

离线进程也可使用 `--http-port PORT`，token 通过 `SIGPILOT_MCP_TOKEN` 环境变量提供。HTTP 实测覆盖 2026-07-28 的 `server/discover` 和工具发现，stdio 实测覆盖 2025-11-25 初始化；业务会话独立于 transport 连接。

## 精确标注流程

1. `get_context` 取得明确的 `session_id`、`capture_id`、`data_revision`、`annotation_revision`。
2. `query_edges` 或 `run_analysis` 查询范围内的原始边沿。未完整扫描时，保持采集引用与原始范围，使用 `next_start_sample` 继续。
3. 使用结果中的精确采样点创建 `channel_annotation`。参数含通道、样本字符串、标题、颜色，可带图形、备注、标签与返回的 `evidence_ref`。服务验证证据属于同一采集，且标注锚点和通道在证据中。
4. `apply_annotations` 使用显式采集引用和预期标注版本。`preview: true` 验证但不写入；提交时 `request_id` 在当前客户端/会话的有界保留窗口内避免重复创建。
5. `focus_view` 定位指定桌面会话。超过 JavaScript 精确整数范围的 GUI 坐标返回 `UI_PRECISION_LIMIT`；后端只读查询仍支持完整 `u64`。

四类标记的坐标规则：

- `timing_point`：一个记录内的采样点，无 `channel/end_sample`。
- `timing_pair`：两个记录内的采样点，无 `channel`；`sample <= end_sample < sample_count`，允许零时间差。它是两个点，不将第二个点当作半开范围终点。
- `channel_annotation`：一个点，必须指定有效的 `channel`，无 `end_sample`。
- `range_annotation`：必须指定有效的 `channel`，范围为 `[sample,end_sample)`，可在 `sample_count` 处结束。

时间点与时间对投影到原有时间标记界面，保留选择、展开、弹窗等临时状态；这些状态不写入共享文档。自定义颜色与来源随标记保留。区间注释显示为对应通道的色带及标题，可删除；范围的精确编辑通过 MCP 完成。时间标记备注在“保存备注”或 Enter 时提交，Escape/关闭弹窗放弃未提交的备注。拖动期间仅显示预览，松开时按拖动开始的采集/标记版本提交；并发变化会拒绝旧拖动。采集触发标记由采集元数据生成，普通编辑不能移动或删除它。

`apply_annotations` 提交返回 `batch_id`；`undo_annotations` 需要该 ID 和当前标记版本。撤销只能作用于仍代表当前文档状态的批次，不能跨越其他尚未撤销的修改。撤销后，只重定位到已恢复的前一个历史状态，允许顺序回退；不会选择性合并旧历史。身份检查来自连接，GUI 用户和助手分别撤销自己的批次。GUI 的“撤销标记”及 Ctrl/Cmd+Z 使用同一服务。历史最多保留 15 分钟、128 个批次、2 MiB，单批次原状态最多 200 KiB；裁剪、替换采集和重开文件不恢复撤销历史。

桌面手动编辑同样使用版本校验。打开编辑器时保留其文档版本；若助手随后修改文档，旧编辑会失败并同步最新状态，不自动覆写。前端按版本处理事件，缺口重新读取快照。保存 `.pxl` 以共享服务为准，同时写兼容 `user_annotations` 与保存精确值、来源及标签的 `workbench_annotations`。裁剪后仅保留范围内的标注并迁移坐标，旧采集引用失效。

证据注册表最多 4096 项、8 MiB，未附到标注的证据最多保留 15 分钟，空间不足时提前淘汰。标注同时保存不可由工具输入改写的证据快照，因此注册表淘汰后仍可展开已附证据。`.pxl` 重开时重新分配引用并标为 `imported_saved_not_recomputed`，不会宣称对文件重新执行过分析。裁剪或手动移动标注后，原始证据放入 `archived_evidence`，解除活动引用，保留原采集坐标和事实。

时间对可引用两个端点各自的证据；有证据时两端都必须位于相应证据的半开范围内。通道点和区间注释仍校验相应锚点、通道和完整范围，不把无关查询结果附作证明。

## 提供者扩展与 Resources

提供者通过 `AnalysisProvider` / `ProviderRegistry` 在可信 Rust 宿主中注册。提供者接收主通道原始边沿页，可以通过 `related_channels` 声明其他输入及有限 lookahead；宿主按同一采集版本读取 `related_windows`，最多 8 个不同通道，每通道 4096 边沿。目录最多 64 项，重复 ID 拒绝；新算法复用参数校验、覆盖检查、结果预算与证据服务。`run_analysis` 的 `parameters` 必须符合目录中参数约定，不能与旧版平铺的脉宽参数混用。当前内置算法每页最多 4096 条边沿、1000 个结果，提供者结果值最多 128 KiB；不是全量无限扫描。

这是可信进程内扩展接口，不是任意代码的隔离运行环境。宿主实现必须遵守有界执行和取消契约；当前没有可强制中断任意 Rust 提供者代码的独立进程监督。MCP 不提供脚本、插件路径或安装提供者的接口。需要第三方不可信插件时应另设受监督进程接口。

服务和桌面 stdio 桥均支持 `resources/list`、`resources/templates/list` 和 `resources/read`。当前资源目录列出注册提供者 schema，另提供六种模板：

```text
sigpilot://schemas/analysis/{provider_id}/{version}
sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/summary
sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/evidence/{evidence_ref}
sigpilot://jobs/{job_id}
sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/reports/{report_id}/pages/{start_index}
sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/results/{result_set_id}
```

工具结果附带相应 ResourceLink；Tools-only 客户端仍可只使用 `structuredContent`。资源每次读取重新校验身份及采集引用，不将旧 URI 解释成当前采集。作业 URI 只允许所属身份读取；旧作业摘要仍报告 `capture_current`。资源内容为 `application/json`，编码后的响应上限 256 KiB。新版响应使用 `ttlMs: 0`、`cacheScope: private`；未提供资源订阅通知；Prompts 见下文。URI 不解析成文件路径，拒绝遍历、编码路径和任意文件 scheme。报告证据页和完整结果摘要均已提供；完整结果内容通过工具分块读取。

## 解码查询与作业

`get_context` 提供独立的 `config_revision` 和 `analyzer_count`。`get_analyzers` 输入显式采集、该版本，按 GUI 顺序有界分页（最多 64 项，约 112 KiB），续页使用 `next_after_id`；配置变化返回 `VERSION_CONFLICT`。支持 UART/I²C/SPI 的实例返回 `config`，其它 Native/HLA 及未配置实例明确声明不支持 MCP 编辑/运行，原有元数据继续保留。

`configure_analyzer` 的 `operation` 为 `create/update/delete`。创建与更新使用 `name`、类型化 `config`；更新/删除还需 `id`。请求含 `expected_config_revision`、`request_id` 和可选 `preview`。新实例采用 Saleae backend；更新保留稳定 ID、协议、backend 和原始来源，不静默切换 GUI 的 Sigrok/HLA 实例。已有 Sigrok UART/I²C/SPI 实例可编辑类型化参数；受监督 MCP 运行仍只支持 Saleae，HLA/任意 native 参数不可通过 MCP 修改。当前 MCP 配置要求输入通道已被采集，UART baud 不超过采样率。最多 64 实例、192 KiB 配置文档、16 KiB 编辑；caller/request 重试最多保留 15 分钟、128 项、256 KiB。

GUI 编辑、删除、排序及显示选项通过共享服务提交，助手编辑通过事件刷新到 GUI。编辑窗口保留打开时的配置版本；过期编辑被拒绝并刷新。`.pxl` 保存从共享文档取配置，避免旧前端列表覆盖助手编辑；稳定 ID 和来源保存在 `workbench_analyzers`，同时输出兼容的 `analyzers`。采集替换会重置配置文档，GUI 将现有预设迁入新采集；裁剪保留配置与 ID。

按共享实例运行时，`run_decode` 使用 `analyzer_id` 和 `expected_config_revision`，省略临时 `config`。两种输入方式不能混用。作业快照冻结当时的配置；结果 `configuration` 为 `{"config":...,"analyzer":{"analyzer_id":...,"config_revision":...}}`。配置变更或实例删除后，原 `request_id` 在保留期内仍返回原作业；新提交使用旧版本则失败。修改配置只修改共享文档，不隐式启动解码或硬件。

解码使用管理员配置的 `SIGPILOT_SALEAE_SIDECAR` 与 `SIGPILOT_SALEAE_RUNTIME_ROOT`，或已有 bundled/workspace 发现路径。外部助手不能传入可执行文件、插件路径或 HLA 脚本。当前受监督的 native 作业限 Linux/macOS；未配置后端时返回 `DECODER_UNAVAILABLE`，不降级为会填充默认字段的解码。

```json
{
  "capture": {"session_id": "session-a", "capture_id": "FROM_CONTEXT", "data_revision": "1"},
  "range": {"start_sample": "0", "end_sample": "600"},
  "config": {"protocol": "I2C", "settings": {"sda_channel": 1, "scl_channel": 0}},
  "request_id": "decode-i2c-1"
}
```

`run_decode` 返回 `job_id`。用 `get_job` 轮询到 `completed` 后，根据 `result.field_schema` 构造查询；例如后端实际提供布尔 `ack` 字段时，使用 `{"name":"ack","op":"eq","value":{"type":"boolean","value":false}}`。未知字段和类型不匹配会失败；没有该字段的行保持 unknown，不会匹配 `eq` 或 `ne`。`query_frames` 的所有条件限定同一帧；地址与 ACK 跨行关联使用事务或序列工具。

为了恢复协议状态，作业实际解码 `[0, range.end_sample)`，字段查询只返回与请求范围重叠的帧。结果同时报告实际处理范围与请求范围。端点按已核对的 bundled analyzer 源码归一化：UART/I²C 数据帧使用包含终点的范围，I²C start/stop 与 SPI FrameV2 使用不包含终点的范围；未核实的协议/事件不会自动套用同一规则。保留原生起止坐标与端点约定供复核。

全局最多 1 个运行作业、2 个排队作业，每个会话最多 1 个重作业。作业参数最多 16 KiB。解码输入最多 65536 条相关边沿、2 MiB；输出最多 4096 帧、2 MiB；子进程地址空间上限 512 MiB，CPU 与墙钟最长 30 秒。超限失败，不发布部分解码为完整结果。取消请求与已取消状态分开，进程管道读写线程均被回收；客户端断线不会自动取消领域作业。结果最多保留 15 分钟、16 个作业和 16 MiB，可能提前淘汰。结果与分页 cursor 绑定采集、配置、凭据身份和查询；旧采集的帧查询返回版本冲突。

### 跨帧序列与 I²C 事务

`query_frame_sequence` 要求 `query.schema_version: "1"` 及 1–8 个 `steps`，每一步的 `query` 使用同一类型化 FrameQuery。首步没有 `within`，后续可附 `{"min_samples":"0","max_samples":"100"}`，表示前后两帧起点之间包含两端的采样延迟。按归一化后的 `(start_sample, frame_id)` 顺序严格递增，同一帧不可重复使用；返回每个初始候选的最早可完成链，较早中间候选不能完成时会继续寻找。范围过滤按帧区间重叠执行。

`scope: "stream"` 可跨不同地址段；`scope: "i2c_segment"` 仅支持 I²C，整条链必须在同一个 START/重复 START 到下一边界的段内。后向可达性搜索最多进行 100 万次后继比较；达到预算返回 `search_complete: false`、`total_matches: null`，没有续页 cursor，需缩小查询。它不表示零匹配。正常查询返回候选计数、实际比较次数和总匹配数；`complete` 另表示当前分页是否已消费完结果。

“地址 0x50 所在段出现 NACK”的 `sigpilot_query_transactions` 输入示例，字段须先由真实解码 schema 确认：

```json
{
  "result_set_id": "FROM_COMPLETED_JOB",
  "query": {
    "conditions": [
      {"fields": [{"name": "address", "op": "eq", "value": {"type": "unsigned", "value": "80"}}]},
      {"fields": [{"name": "ack", "op": "eq", "value": {"type": "boolean", "value": false}}]}
    ],
    "require_complete": true
  },
  "limit": 20
}
```

事务以已观察到的 START→STOP 为父边界；重复 START 新开地址段，仍属于同一父事务。所有 `conditions` 必须在同一段内分别找到见证，不能拼接两个目标地址的数据。返回匹配段与父事务元数据、段数、每个条件的首个投影帧和证据，不复制整个事务。`require_complete` 要求父 START、STOP 均已观察到；否则返回 `start_known`、`stop_known`、`termination` 等不完整状态。边界完整不代表协议无错误。

分组使用完整已处理前缀，以恢复查询范围之前的地址上下文。匹配段须与解码请求及查询范围重叠，但条件见证可能早于请求起点；响应明确报告 `context_scope: "processed_prefix"`。可用条件自己的 `range` 进一步限制见证。帧、段、父事务引用均绑定结果集；分页 cursor 还绑定身份、查询种类与参数，最多保留 128 个、15 分钟。序列/事务每页最多 100 项、查询最多 16 KiB、帧载荷最多 128 KiB，大帧须用字段投影。

### 协议事件与窄脉冲关联

`sigpilot_correlate_pulses` 使用同一个结果集所属采集，在指定通道读取原始边沿。`query.events` 按真实 schema 选帧，例如仅在后端已声明 `error` 字段时用 `exists`；也可以选择 NACK、地址或任意明确事件。事件帧必须与解码请求范围重叠。服务不会把普通命中重新标为解码器错误。

```json
{
  "result_set_id": "FROM_COMPLETED_JOB",
  "channel": 1,
  "start_sample": "0",
  "query": {
    "events": {"fields": [{"name": "error", "op": "exists"}]},
    "original_range": {"start_sample": "0", "end_sample": "600"},
    "before_samples": "20",
    "after_samples": "600",
    "high": true,
    "min_width_samples": "1",
    "max_width_exclusive": "3"
  },
  "limit": 20
}
```

脉宽使用 `[min_width_samples, max_width_exclusive)`，下限至少 1；关联窗口为帧起点前后指定的采样距离，包含两端。返回窗口内全部帧/脉冲对，按脉冲起点与原始帧顺序分页。`delta_samples` 是 `pulse_start - frame_start` 的精确有符号十进制字符串，另有采样率便于换算。每对有各自可解析、可用于标记的帧和脉冲证据。仅开沿和闭沿均已记录的脉冲参与关联，边界不完整状态单独报告。

每次最多读取 4096 边沿、提取 1000 个匹配脉冲，响应最多 100 对、128 KiB 载荷。`pulse_scan_complete` 表示当前边沿扫描是否到达范围终点，`page_complete` 表示当前扫描的帧/脉冲对是否已消费完。存在 `next_cursor` 时必须使用完全相同的输入先取完结果；之后才使用 `next_start_sample`，保留原 `original_range` 继续扫描。cursor 绑定通道、扫描起点及所有参数，避免续页混用造成遗漏。完整范围结论须汇总全部覆盖页。

输出的 `interpretation: "temporal_cooccurrence"` 表示时间共现，不是硬件根因结论。没有命中时还须检查选中事件数量、扫描覆盖和阈值。同步分页工具仍受有限工作量约束。MCP 请求取消已传入分析提供者、帧过滤、序列、事务、脉冲关联及离线编译的协作取消标志；worker 真正结束后才释放并发名额。可信宿主提供者仍必须主动检查标志，任意 Rust 代码不能被强制中断。请求开始前的取消阻止执行；写入和作业提交一旦开始，以实际提交结果为准，已提交领域作业只由 `cancel_job` 或会话释放取消。SDK 可以抑制被取消请求的响应；写入重试应使用原 request ID 并重新获取上下文。

## 离线触发校验与回放

当前支持 schema 1 的 1–8 阶有限序列：每阶段一个 `edge`、完整 `pulse_width` 或 `level` 事件，加最多 16 个电平守卫。守卫必须明确 `before/after`，脉宽事件必须明确 `pulse_start/pulse_end` 锚点。宽度为 `[min_width_samples, max_width_exclusive)`；首阶段无 `within`，后续阶段必须带 `[min_samples,max_samples]`，表示距上一事件锚点的包含两端延迟窗口。校验、回放和离线编译均不配置或启动设备。

同一通道同一 phase 的高低冲突、事件与守卫冲突、空宽度/延迟区间会报告 `proven_unsatisfiable`。单阶段可满足条件为 `satisfiable_in_model`，一般跨阶段静态约束为 `inconclusive_cross_stage_constraints`，不冒充完整求解器。回放中的 `no_observed_match` 仅说明指定采集中没有观察到匹配。

电平事件表示符合主电平和守卫的半开采样区间，无须虚构边沿；恒定电平可以从查询起点匹配。后向时间区间可达性再前向选择最早可完成链，能选择电平区间内部较晚的锚点。每个初始事件或合格电平区间返回一条链。`eligible_range` 保留可选锚点区间；脉冲的 `pulse_range` 保留真实半开脉宽范围，而证据 `range` 包含记录内的闭沿点，因此可标记 `pulse_end`。

确认时间取各阶段所需确认时间的最大值，例如以脉冲起点作锚时，仍到闭沿才能确认宽度。`holdoff_samples>0` 从前一次确认时间起排除新的初始锚点；为零时允许重叠。范围内最多读取 65536 条边沿，每阶段最多 4096 候选，总可达时间区间最多 65536，预算比较最多 100 万次；候选/区间/比较预算触及时结果为 `incomplete`。阶段 `suffix_rejected` 计数无法完成剩余序列的候选，`window_rejected` 针对所选前驱统计窗口外的可达区间，不是全部可能组合的超时次数；响应中 `matching_policy/diagnostic_policy` 说明统计语义。返回数量上限与扫描完整性分开。

### 离线设备编译

先从 `list_capabilities.hardware_triggers.profiles` 选 `profile_id`，显式提交 `target` 的模式、通道数、使能通道和精确采样率，以及同一份规则。内置 10 个 PXLogic profile 的通道模式与采样率来自驱动表，另有 Kingst 和 Demo 当前无触发路径，共 12 个。发现和编译不枚举 USB。

PXLogic 单边沿/电平可生成四个触发掩码寄存器及精确时钟参数；同通道已被事件蕴含的守卫会明确归一化。多阶段时序、脉宽比较器、holdoff、不在精确时钟表的采样率及会被驱动 clamp 的请求明确拒绝，不放宽规则。额外通道的高低掩码映射已知，但 FPGA 的 before/after 取值 phase 未验证，因此返回 `unverified` 和 `candidate_encoding`，`artifact` 为 null。只有声明匹配 phase 的可信未来 profile 才能生成就绪编码。

`supported` 仅证明已核对的驱动编码可表达规则；所有输出仍为 `hardware_verified:false`、`applied:false`。`invalid_model`、`proven_unsatisfiable`、`unsupported` 分别表示输入模型错误、已证明逻辑冲突和设备编码不能表达。扩展通过可信 Rust `HardwareTriggerCompiler` 注册，MCP 不能提供伪造能力描述。

## 独立证据报告

报告是用户选定观察的不可变集合，与波形标记独立。`apply_reports` 在共享内存文档创建/删除，标题和备注属于作者解读，观察、参数和范围只能来自有效服务证据。`expected_report_revision` 不影响 `annotation_revision`；preview 不写入、没有稳定 report ID，提交按身份/会话/request ID 在 15 分钟、128 项、256 KiB 内去重。需要同一编辑权限；文件写入仍由 GUI 保存完成。

```json
{
  "capture": {"session_id":"session-a","capture_id":"FROM_CONTEXT","data_revision":"1"},
  "expected_report_revision":"0",
  "request_id":"report-1",
  "operation":{"op":"create","title":"窄脉冲观察","note":"原因待复核","evidence_refs":["FROM_ANALYSIS"]}
}
```

每报告 1–64 条独立证据、最多 512 KiB，每条证据最多 96 KiB；每采集最多 32 报告、4 MiB。`get_reports` 列目录需要当前 `report_revision`；读取不可变报告用 `report_id/start_index`，按 `next_index` 续页，每页约 112 KiB。分页的 `complete` 表示选定证据页消费完，不代表原始分析全量覆盖。Tools-only 客户端与报告 ResourceLink 均可读。

GUI 保存 `.pxl` 同时写 `workbench_reports`，无需先创建标记。重开时绑定新采集并分配新证据引用，标为 `imported_saved_not_recomputed`；保留 `origin_capture`，旧引用不转用。报告中的活动证据在运行期注册表淘汰后仍可展开。裁剪后报告标为 `archived_original_capture`，保留完整原坐标且不能作为新采集的标记证据。未识别 schema 有界保留为 opaque；裁剪后包为原采集归档，不激活其未知语义。

## 多通道数字时序

通过 `sigpilot_run_analysis` 选择 `sigpilot.multichannel_timing`，主 `channel` 为锚点通道；`parameters` 二选一：

```json
{"mode":"setup_hold","data_channel":1,"anchor_direction":"rising","min_setup_samples":"3","min_hold_samples":"2","limit":100,"report":"all"}
```

```json
{"mode":"edge_delay","response_channel":1,"anchor_direction":"rising","response_direction":"falling","min_delay_samples":"0","max_delay_samples":"20","limit":100,"report":"violations_and_unknown"}
```

setup/hold 在每个锚点检查数据通道的前后跳变，同样点跳变保守地将两项均记为 0。没有边沿的一侧只报告已观察到的 `lower_bound_samples`；下界不足阈值时返回 unknown，不虚构精确时长。delay 选择锚点当时或之后的首个合格响应边沿，允许多个锚点共用响应；先找到响应再检查 inclusive min/max，不会跳过过早响应。完整观察窗口内未响应为 violation，采集边界或边沿预算不足为 unknown。

`complete/coverage` 表示锚点遍历，`assessments_complete` 表示是否所有检查已决；需同时读取。按 `next_start_sample` 从尚未消费的锚点续页。关联通道包含有限 lookahead，双通道证据可能超出请求的锚点范围。全部时长使用原始样点整数，不承诺模拟电压、电气规格或亚采样精度。

## 完整结果目录

作业结果默认属于提交身份且只有运行期保留。`sigpilot_apply_results` 的 `operation:{"op":"retain","job_id":"..."}` 显式将已完成的完整 typed output 保存到共享文档；请求同时带 `capture`、`expected_result_revision`、稳定 `request_id`，支持 preview。这一步会向其他已授权项目客户端共享结果。删除用 `operation:{"op":"delete","result_set_id":"..."}`，不会删除原始波形。

`sigpilot_get_results` 列目录需当前 `result_revision`；摘要需 `result_set_id`；完整 JSON 需再带 `offset:"0"` 与 `max_bytes`（128–32768），依次拼接 `content`，按 `next_offset` 续页。每项目最多 16 项、每项 4 MiB、文档 8 MiB。仅完整解码或声明完整的分析作业可保存；同步分析页可通过证据报告保存所选观察。

GUI 保存 `.pxl` 写入 `workbench_results`。重开不恢复作业，只重绑定结果 ID，并标为 `imported_saved_not_recomputed`；同一文件同时打开的两个会话拥有不同 ID。新 ID 可使用已有帧、序列、事务与关联查询，生成的新证据携带保存后未重算状态。裁剪后快照归档在原始坐标，仍可读取，不能查询或标注新采集。未知 schema 有界保留，裁剪时包为原采集归档，避免误用未知坐标。

分块 `content_scope:immutable_original_job_payload` 保留作业原始内容。其内嵌 capture/evidence 引用属于原运行期，没有重新绑定，不能直接当作当前引用；使用外层摘要的当前身份和上述查询工具生成当前证据。

## 派生采集与重解码对比

`sigpilot_create_derived_capture` 接收源 `capture`、不同的 `target_session_id`、1–8 个被采集通道、`max_width_exclusive`（精确样点字符串且 >1）、可选 `high`、稳定 `request_id` 和 `preview`。只替换完整原始脉冲且宽度严格小于阈值；开边界脉冲保留。相邻候选若共用边沿，先发生者优先；决策只使用本次输入，删除边沿对，不级联放宽阈值。

原采集不变，新采集保留样点数、采样率、初始电平和全部被采集通道；全部通道原始边沿合计上限 65536。原子发布新会话及最多 16 KiB 的来源记录。相同身份/请求/参数可在目标未变化时重试；目标已存在、被裁剪或被替换时拒绝冲突，重开 provenance 不恢复写请求重试。再次过滤形成显式来源链，每次仍是单次算法。

对比流程：冻结源引用 → preview/创建 → 分别使用相同临时配置调用两次 `run_decode` → 查询两份结果中的字段、错误行和范围 → 保留两份结果或创建各自报告。证据始终绑定各自采集。派生 MCP 会话目前不会自动加入桌面标签页；设备采集会话会自动加入。派生采集可在共享服务保存为 `.pxl`，MCP 不发布文件写入工具。

`workbench_derivation` 保存源采集、阈值/极性、每通道替换数和 identity 时间轴映射。裁剪后 `mapping_offset_sample` 累加裁剪起点，当前样点 s 对应直接源样点 s+offset。过滤后的解码改善只构成数字假设对比，不证明原始电气脉冲应该消失，也不保证协议错误被修复。

## 报告导出与 Prompts

`sigpilot_export_report` 接收 `capture`、当前 `report_revision`、`report_id`、`format:json|markdown`、`offset` 与 `max_bytes`（128–32768）。拼接 `content`，按 `next_offset` 续页，完成后由客户端保存；总渲染上限 2 MiB。偏移必须是 UTF-8 边界。Markdown 将作者评论转义，并使用动态代码围栏显示观察内容；精确样点、提供者参数与保存/归档状态均保留。服务不接收输出路径。

服务及 stdio 桥支持 `prompts/list`、`prompts/get`，提供三种用户选择的模板：

- `sigpilot_scan_and_mark_pulses`：扫描覆盖、复核证据和精确标记。
- `sigpilot_protocol_event_to_waveform`：真实字段查询、协议事件与原始波形匹配。
- `sigpilot_diagnose_trigger`：有限规则校验、离线能力编译与回放解释。

模板参数以发现目录为准，最多 4 KiB；session_id 从无 session_id 的 `sigpilot_get_context` 获取。模板本身不执行工具、不授予权限。2026-07-28 HTTP 调用命名方法需 `Mcp-Name`，例如 tools/call 填工具名、prompts/get 填模板名。

## 后续扩展边界

当前事务分组仅支持 I²C；离线触发包含上述有限规则及可信设备编码，采集过程另支持 [UART/I²C/SPI 软件协议触发与 PXLogic 硬件触发](mcp-capture.md)。标准 MCP Tasks 未协商：核心流程使用独立领域作业轮询/取消，未来可通过适配层映射。增量分析、更多统计提供者、不可信插件进程隔离、派生会话自动加入 GUI、Windows DPAPI 与签名发布包的实机验收属于后续工作。

当前扫描是有界同步分页。历史分析验收不包含完整 Tauri 窗口、目标助手及真实硬件触发；后续设备控制实现与验收单独记录在 [MCP 设备采集](mcp-capture.md)。Windows/macOS 的完整发布包兼容性仍需按发布流程验收。

## 验证与资源限制

所有构建、格式化、测试和运行在 Instabox 独立工作区进行，本机只读写源码及传输文件。`tools/instabox/limited-run.py` 限制 1 核、2 GiB 内存、零 swap、128 个任务、单任务 flock、最长 540 秒；磁盘保留 1536 MiB，启动前额外需要 256 MiB。防护停止按失败记录，不计入成功验收。缓存清理只作用于本任务目录。

最终领域/界面/线协议记录 `.verification/4465aaa1098a.json` 成功，峰值约 1.5 GiB、零 swap；包含新增导入坐标/schema 校验、未知扩展归档和原始/派生重解码对比。

| 验证 | 最新状态 |
| --- | --- |
| `sigpilot-analysis` | 48 项通过，含精确坐标、多通道 setup/hold/延迟、未知边界、规则/序列/关联与取消 |
| `sigpilot-workbench` | 50 项通过，含共享配置、完整结果保存重开、派生来源/裁剪、证据/报告导出与 CAS/重试 |
| `sigpilot-file` | 20 项通过；1 项已有 native fixture 测试按原规则忽略 |
| `sigpilot-graph` | 105 项库测试与 2 项 CLI 参数测试通过；10 项已有测试按原规则忽略，精确只读接口 3 项均通过 |
| MCP 领域/桌面桥/取消 | 2 项资源/Prompts、1 项真实 stdio→HTTP 共享服务、2 项两代协议取消通过 |
| TypeScript / 前端状态 | 类型检查、11 项状态测试通过 |
| Chromium 真实组件 | 解码器对话框 8 项、标记组件 8 项通过；含真实共享服务、非法输入、并发 CAS 和保存 |
| stdio / HTTP smoke | 29 工具、3 Prompts、6 Resource 模板、3 provider schema；2025-11-25/2026-07-28 两代报文通过 |
| Native fixture | UART/I²C/SPI 类型字段、结果保存/分块/资源、I²C 重复 START、脉冲关联和原始/派生独立重解码通过；脉冲所致错误消失，独立 NACK 保留 |
| Linux 桌面 Rust | 最新 `cargo check -p sigpilot-desktop --bin sigpilot-desktop --locked --offline` 通过，`.verification/86103c6c801d.json`，包含 Cursor 安装入口命令；峰值约 1.7 GiB，零 swap |

`.verification/d6c7c005a861.json` 整体失败：TypeScript、11 项前端状态、8 项真实解码器对话框和 8 项标记组件通过；线协议在原始/派生结果 schema 的错误测试预期处失败，已修正并增加独立 NACK 对比。`.verification/dbc3685f66ba.json` 的 3 项精确图读取通过，但后续构建被磁盘保留线停止，整体失败。此前桌面检查 `.verification/30d796426381.json` 同样被磁盘保护停止，不属于源码编译错误或成功验收。最终验证使用清理后的本任务缓存，不降低保护阈值。基线 Linux 桌面检查 `.verification/132e83c7e0f0.json` 已通过；基线格式化后同步了 247 个源文件。

浏览器检查挂载真实组件及真实共享服务适配器；这证明该组件与服务交互，不能替代完整 Tauri 窗口、目标助手客户端、macOS/Windows 实机兼容或发布打包验收。native 只使用确定性数字采集 fixture，没有连接真实设备。

复现时在该 Instabox 工作区运行 `limited-run.py --label mcp-all --cwd <workspace> -- /usr/bin/python3 tools/instabox/verify.py all`；桌面检查使用 `verify.py desktop`。验证 JSON 和日志位于远端 `.verification/`，本次下载副本位于本机 `/tmp/sigpilot-mcp-verification/`。访问凭据不进入源码或验证文件。

## HTTP 接入验收（2026-11-16）

- `.verification/2ccd3d417d9f.json`：最终直接 HTTP 授权、PKCE、一次性授权码、拒绝、重启复用、刷新轮换、撤销、Host/Origin 校验与固定端口冲突、不同客户端身份和端口授权隔离检查通过；通过 SDK 在样本 5 写入真实共享标记。
- `.verification/cb43fb2c1ba9.json`：TypeScript、Vite 生产构建和 Chromium 35 项真实面板检查通过，包含 OAuth 请求显示、允许/拒绝、HTTP 注册命令复制、Cursor 打开入口、自检、Demo 采集和 .pxl 保存重开；峰值约 797 MiB，零 swap。
- `.verification/a69407c0912c.json`：在不准备或安装 stdio 桥的 fixture 下，35 项界面与 Demo 检查再次通过，确认 HTTP 不依赖 sidecar。
- `.verification/0514eb2dccdf.json`：9 项既有 MCP 库、stdio 桥、发现、持久化与两代协议取消回归检查通过。
- `.verification/6b8c6e263ca0.json`：Linux 桌面完整 `cargo check --locked --offline` 通过，峰值约 1.8 GiB，零 swap。
- `.verification/f0b8b25621ba.json`：MCP 库在 `x86_64-pc-windows-gnu` 交叉编译通过，包含 HTTP 服务、OAuth、Windows DPAPI 保存和实例锁。没有运行 Windows 程序，也不代表完整 Windows Tauri 安装包验证。

仍未运行真实 Codex/Claude/Cursor 用户配置中的注册，也未完成 macOS/Windows 桌面实机验收。CLI 语法由已安装客户端的只读 help 及官方文档核对。浏览器剪贴板和 Cursor 打开调用由测试适配器记录，实际服务与 Demo 是真实 Rust 共享状态。

首次检查 `cb09583aed80` 发现 Axum query feature 缺失；改用现有 URL 解码后修复。`c4b61eced6dd` 因离线缓存缺少额外依赖退出，移除不必要 feature 后通过；这些失败不计为成功验证。

复现：先运行 `limited-run.py ... -- python3 tools/instabox/verify.py http-rust`，再运行 `http-ui`；Windows 交叉检查使用 `http-windows`（需对应 Rust target）。

## 历史接入面板与 Demo 验收

2026-11-14 的命令式接入与简化界面在 Instabox 上完成以下验证：

- `.verification/c4b39a00dde7.json`：2 项接入单元测试、桥程序和 Demo 界面 fixture 构建通过；覆盖相邻实例发现、旧参数兼容、特殊路径转义与 Cursor 安装配置解码。
- `.verification/fc21759d3820.json`：TypeScript 和 Vite 生产构建通过；浏览器检查发现折叠可见性断言误用布局矩形，整体记录为失败。改用实际渲染可见性检查后，最终 `.verification/1a86ba5a0d2a.json` 的 34 项检查全部通过，含五种客户端入口、命令剪贴板、Cursor 打开请求、权限保存、重启复用、真实 Demo 标记与 `.pxl` 重开；峰值约 367 MiB，零 swap。
- `.verification/480ecc589238.json`：已安装 Codex/Claude Code 的 `mcp add --help` 只读核对通过。未执行真实客户端注册，没有改写其用户配置。
- `.verification/86103c6c801d.json`：Linux 桌面 `cargo check --locked --offline` 通过，包含新的 Cursor 安装入口 Tauri 命令；峰值约 1.7 GiB，零 swap。

Cursor 安装 URI 的内容与前端发起打开请求已验证，尚未在真实 Cursor 中确认安装。完整桌面窗口和真实 Agent 的端到端验收仍需单独进行。

2026-11-13 的基础接入流程记录：

- `.verification/62bca47162d1.json`：MCP 8 项测试通过，覆盖配置转义、稳定连接文件、重启轮换、窗口冲突、私有权限、保存权限选择、实际桥握手、资源与取消；峰值约 1.1 GiB，零 swap。
- `.verification/799036b51d32.json`：TypeScript 和 Chromium 22 项检查通过，覆盖四种配置、复制调用、侧栏滚动、连接自检、停用时的权限保存、停用/重启和原配置复用；峰值约 383 MiB，零 swap。
- `.verification/924ab961cd13.json`：最终 Linux 桌面检查通过，包含新 Tauri 命令、启动恢复与 sidecar 配置；峰值约 1.7 GiB，零 swap。

Demo 验证调用与桌面采集相同的 `FakeBackend::capture_streaming_with_analyzers`，通过 `begin_capture`、样本追加和 `finish_capture` 写入真实 GraphSession。1 MHz、4 通道、10 ms 请求按生成器规则对齐为实际 10,048 个样本。使用面板生成的 command/args 启动实际 stdio 桥，通过 MCP 创建样本 `5` 的 **MCP test** 标记；共享快照和真实标记组件确认位置为 `5 µs`，在 20 样本视口中位于 25%。保存 `.pxl` 后重开，Demo 来源与标记均保留，并再次显示。

浏览器中的 Tauri 调用通过测试适配器接到真实共享服务；剪贴板系统调用在浏览器测试中由适配器记录。这里验证了 Demo 数据、实际桥、共享状态、真实标记组件和持久化的闭环，没有启动完整 Tauri 窗口，也未启动真实 Codex/Cursor/Claude 客户端。签名安装包与 macOS/Windows 实机验收仍未覆盖。

本轮失败记录保留：`20967797e3e0` 为测试入口引用未启用的 Axum JSON 功能；改用现有 Bytes 解析后修复。`d9a259cb3596` 被磁盘保留线停止。`f4de3cfb3921` 发现新增侧栏遗漏快捷键映射，已修复。`e932a219ea58` 的 Demo 数量预期忽略了生成器对齐，已修正为实际样本数。上述整体失败不计为成功验收。

资源较紧时分阶段复现：先通过 `limited-run.py` 运行 `verify.py onboarding-rust`，结束后执行 `prune-check-cache.py --for-desktop-check`；再运行 `verify.py onboarding-ui`；再次清理本任务依赖缓存后运行 `verify.py desktop`。清理保留已链接的 fixture、桥程序和 native 资源，不降低资源保护线。测试报告、截图和完整日志位于远端 `.verification/`，下载副本位于 `/tmp/sigpilot-mcp-verification/`。
