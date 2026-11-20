# 本机桌面 → 悬浮终端 → Codex CLI → MCP 采集验证

这是显式启用的开发测试入口，运行实际 Tauri 窗口、实际悬浮终端 PTY、已安装的 Codex CLI 和 MCP HTTP 服务。它不替换设备驱动、不模拟 Codex 工具调用，也不增加公网调试服务。

## 准备

需要已经构建的当前桌面程序、已登录的 `codex` 和 `python3`。桌面 debug 构建需在 main 窗口加载完成后读取并执行 `SIGPILOT_VERIFY_SCRIPT` 指定的本地 JavaScript；release 构建不能包含该入口。脚本仅由本地开发者显式选择。使用 `tauri/custom-protocol` 构建可内嵌 `dist`，无需额外运行 Vite 服务。

```sh
python3 tools/mcp-capture-verify/prepare.py --allow-hardware
```

该命令只写入 `.verification/mcp-capture/desktop-verify.js`，不启动应用或采集。省略 `--allow-hardware` 时只测试 Demo。

然后按项目开发流程启动桌面程序，并将 `SIGPILOT_VERIFY_SCRIPT` 指向上述脚本的绝对路径。不要在已有用户终端会话的窗口注入；测试会拒绝复用已创建的终端。

## 执行路径

1. 在真实桌面启用 MCP、标记编辑及设备采集权限。
2. 展开真实悬浮终端，取得该组件新建的 PTY ID，并通过同一个终端运行 `run_codex.py`。
3. 使用标准 `codex mcp add sigpilot-capture-test --url http://127.0.0.1:10531/mcp` 注册。若同名配置指向其他地址，停止而不覆盖。
4. 使用 Codex 生成的 PKCE URL 建立授权；只批准本次精确 request ID、回调地址及 Codex 客户端名称匹配的新请求。凭据和授权码不写入验证产物。
5. `codex exec` 通过 MCP 测试有限 Demo 采集；显式允许硬件时再测试连接的 PXLogic。默认要求 1 MHz、D0–D3、10 ms、8 MiB、1.8 V 阈值和 10 秒超时，不配置输出。
6. 保存 CLI 结果及实际桌面终端截图，再通过现有缩小按钮隐藏终端并截图波形；检查 D0–D3 行和时间标记实际可见。连接保持已安装、终端缩小为按钮，便于检查结果。

CLI 仅在本次进程对测试服务器的 start/stop/release capture、apply annotations 与 focus view 五个工具设置 `approval_mode="approve"`，并限制该服务器可用工具列表；shell 仍采用 read-only，用户全局审批设置不变。标记完成后聚焦 USB 采集样点 0–40，便于核对界面位置。该配置字段见 [OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 证据与限制

结果位于 `.verification/mcp-capture/`（或显式 `--output`）：`desktop-report.txt`、`desktop-terminal.png`、`desktop-waveform.png`、`codex-report.json`、`codex-result.txt` 和脱敏后的 `codex-events.jsonl`。

CLI 结束立即持久化 `driver` 和 `cliPassed`，随后核对界面。每次等待双动画帧最多 1.5 秒；若后台或锁屏导致 WKWebView 不推进帧时钟，记录 `guiStatus=unavailable_background_frame_clock`、`guiPassed=null`，截图标注可能陈旧，整体不记为 GUI 通过。此时 Codex 工具证据仍可独立通过；不要为补截图而重复硬件采集，也不通过替换动画帧实现制造可见性证据。

`passed` 从实际工具 `structuredContent` / `structured_content` 或 JSON 内容块计算，不采用模型自报成功：要求设备枚举中 Fake 与 Usb 身份明确、采集状态 completed、实际采样率与通道一致、样点数在 10000–10064 的对齐范围、精确样点 5 标记写入、对应采集的边沿读取、重复请求返回同一 job、Demo 释放后重放不重启，以及真实硬件结果保留。工具错误使检查失败；只读设备/能力查询的 BUSY 仅在随后同工具、同参数成功重试时可豁免，次数记录为 `transient_busy_retries`。模型工具选择不保证每次相同；完整 JSONL 保留执行证据。实际 USB 输入如果未接已知信号源，仅能验证采集控制路径，不能证明协议、电气或丢样性能。

测试会新增独立名称的 Codex MCP 配置并开启桌面权限，保持现有其他配置。需要移除时明确运行 `codex mcp remove sigpilot-capture-test`，并在 SigPilot 撤销对应授权。不会自动关闭已有服务或删除无关客户端。
