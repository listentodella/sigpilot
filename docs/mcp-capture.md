# MCP 设备采集

桌面运行时，外部助手可以通过同一个本机 HTTP MCP 服务枚举设备、读取硬件能力、启动采集、查询状态、停止和释放采集。采集使用桌面的设备驱动与共享工作台；Demo 同样经过真实 Rust 采样路径。

## 接入与权限

在 **AI / MCP** 面板开启服务，并启用 **允许助手控制设备采集**。该权限与编辑标记权限独立，默认关闭。注册方式不变：

```sh
codex mcp add sigpilot --url http://127.0.0.1:10531/mcp
```

按提示在 SigPilot 授权客户端。也可以在内置悬浮终端执行注册命令，然后运行已有的 Codex CLI；SigPilot 不需要捆绑或安装 agent 引擎。

## 工具与流程

| 工具 | 用途 |
| --- | --- |
| `sigpilot_list_devices` | 枚举 USB 设备与 Demo，返回当前设备 ID |
| `sigpilot_get_device_capabilities` | 查询设备实际通道模式、采样率、阈值及采集预算 |
| `sigpilot_start_capture` | 创建独立会话并提交采集，立即返回 `job_id` |
| `sigpilot_get_capture_status` | 查询进行中或最终状态、样点数与最终采集引用 |
| `sigpilot_stop_capture` | 请求停止同一授权客户端启动的采集；随后轮询直至停止完成 |
| `sigpilot_release_capture` | 释放所属的已完成采集和内存，并关闭其桌面标签 |

先枚举设备和能力，再使用准确返回的设备 ID。下面展示有限采集的输入形式，采样率与通道必须符合目标设备能力：

```json
{
  "request_id": "capture-example-1",
  "device_id": "fake:sigpilot-demo",
  "sample_rate_hz": "1000000",
  "enabled_channels": [0, 1, 2, 3],
  "mode": "buffer",
  "duration_ms": 10,
  "buffer_size_mb": 8,
  "threshold_volts": 1.8,
  "timeout_ms": 10000
}
```

`start_capture` 接受请求不等于完成采集。使用返回的 `job_id` 轮询；完成后使用 `context` 中的 `session_id`、`capture_id` 和 `data_revision` 调用既有边沿查询、测量、协议分析和标记工具。创建标记仍需要编辑权限及最新标记版本。

采集自动出现在桌面的独立标签中，显示实时波形和最终结果。桌面用户仍可停止采集；完成的 MCP 数据不会被下一次本地采集覆盖，可复制其设置后再次采集。

## 执行边界

- 单次预算为 1–64 MiB、最长 60 秒；最多保留 8 个采集。Buffer 按 `duration_ms` 采样；Stream 持续到主动停止、内存用尽、协议命中或 `timeout_ms`。
- 同一时间仅执行一个 MCP 采集；桌面与远程采集也使用同一个设备占用检查。设备被其他采集占用时明确失败，不会抢占。
- 每次创建新会话。相同客户端使用相同 `request_id` 和参数重试，会返回同一任务；改变参数会报告冲突。去重记录有数量和 15 分钟保留预算。
- 断开 HTTP 或取消提交请求不会撤销已接受的采集。停止工具按授权身份和会话匹配，不会停止其他客户端或桌面用户的任务。关闭 MCP 或撤销客户端授权会请求停止相关未完成任务。
- 停止请求与停止完成分开报告，后台等待驱动退出后才释放设备；部分数据可保留。超时、失败、取消和正常完成分别报告。
- 可选 `protocol_trigger` 复用桌面 UART / I²C / SPI 软件触发。需使用 Stream，且任务超时覆盖等待时间、后段和数据交付宽限，详见[协议内容触发](protocol-trigger.md)。
- PXLogic 可使用 `hardware_trigger` 配置边沿/电平、附加电平掩码和触发位置；Demo 与 Kingst 不声明这项能力。硬件触发与软件协议触发互斥，并始终受任务超时约束。
- 采样准备沿用桌面固件/FPGA 加载流程；MCP 没有通用终端、任意驱动命令、PWM 输出或固件升级工具。

独立离线 MCP 入口没有设备控制器，因此不发布这组设备工具。

## 本机验证

[桌面 → 内置终端 → Codex CLI 验证工具](../tools/mcp-capture-verify/README.md) 运行实际 Tauri 窗口、实际 PTY 和标准 MCP 客户端。其注入脚本需要显式环境变量，且仅存在于 debug 构建；发布版本不提供该入口。

真实设备的采集控制成功不等于已验证输入信号正确性。未接已知信号源时，不能据此宣称协议解码、电气特性或高吞吐无丢样验收完成。

### 2026-11-20 本机验收

macOS 实际 Tauri 窗口通过内置悬浮终端运行 Codex CLI 0.163.0，使用 HTTP/OAuth 注册独立的 `sigpilot-capture-test` 连接。最终执行 18 次 MCP 调用，16 项结果断言全部通过，没有工具错误：

- Demo 与已连接的 PXLogic USB 均完成 1 MHz、D0–D3、10 ms、1.8 V 的有限采集，各返回 10,048 个样点（底层采样块对齐）。
- 使用各自采集引用查询 D0；在 USB 采集的精确样点 `5` 写入时间标记，即采集起点后 `5 µs`，并成功请求桌面定位到样点 `[0,40)`。
- 同一请求重放返回原任务；Demo 释放后再次重放保持 `released=true`，不会重新启动采集。USB 结果及标记保留在当前测试窗口。
- 19 项 MCP 单元/集成测试通过；GUI 关闭后重放状态修复再通过其中 7 项采集测试。7 项相关前端测试、TypeScript、Vite 生产构建和 macOS 桌面 debug 构建通过。

本地证据位于 `.verification/mcp-capture-final/codex-report.json`、`codex-events.jsonl` 与 `verification-summary.json`。首轮因 CLI 的非交互审批策略拒绝标记/释放，失败报告保留在 `.verification/mcp-capture/`。最终轮仅对测试服务器所需工具使用单次进程审批配置，未改变用户全局审批策略。

视觉验收尚未完成：当前 macOS 会话中的 WKWebView 未推进绘制帧，最终截图阶段仍等待恢复；工具返回与工作台数据验证不能替代屏幕验收。验证工具后续已增加绘制等待超时与截图可能陈旧的显式标记，避免把旧画面算作成功。未为截图重复采集硬件。此次 USB D0 查询没有观察到跳变，不据此判断输入信号或硬件质量；硬件触发、最高吞吐及其他操作系统仍需针对性实测。

后续用户本机实测确认功能有效。上述自动化视觉验收限制仍保留，不将人工确认记作自动截图通过。
