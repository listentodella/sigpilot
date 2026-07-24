# 功能搬运记录

从现在开始，每搬完一个 Saleae / Logic 2 功能，都新增一份文档到 `docs/ported-features/`，并在这里追加索引。目标是让我们之后能快速回答四个问题：

- 这个功能参考了原版哪些文件？
- 本地改了哪些文件？
- 行为是否已经可运行？
- 和原版还有哪些已知差距？

## 记录规范

每个功能完成后创建：

```text
docs/ported-features/YYYY-MM-DD-功能名.md
```

文档必须包含：

- 功能范围
- 原版参考路径
- 本地落点文件
- 复用方式：资源复用、结构复刻、状态规则复刻、算法搬运或完全重写
- 用户可见行为
- 验证方式
- 已知差距 / 后续任务
- 对应 Git 提交

提交信息建议使用：

```text
port: 功能名
```

如果只是整理文档或版本管理，使用：

```text
docs: 说明内容
chore: 说明内容
```

## 已记录功能

- `docs/ported-features/2026-07-16-ui-shell-baseline.md`
  - 当前 Saleae 风格 UI 骨架基线。
- `docs/ported-features/2026-07-16-digital-edge-navigation.md`
  - 数字通道 hover 时的 Previous Edge / Next Edge 按钮与快捷键跳转。
- `docs/ported-features/2026-07-16-digital-edge-navigation-polish.md`
  - 边沿跳转 tooltip、图标方向、300ms 平移动画细节优化。
- `docs/ported-features/2026-07-16-sidebar-command-infrastructure.md`
  - 右侧栏面板入口规则、统一命令层和原版快捷键基础设施。
- `docs/ported-features/2026-07-16-devices-sidebar-settings.md`
  - Devices 右侧栏设置面板、数字通道/采样率/捕获模式/触发/Glitch/Buffer 骨架。
- `docs/ported-features/2026-07-16-recording-settings-sidebar.md`
  - Recording Settings 的 MSO 可见性规则、Recording Type、Timer/Trigger/Single Shot/Trigger Sampling 骨架。
- `docs/ported-features/2026-07-16-analyzers-sidebar.md`
  - Analyzers selector、Suggested/active analyzer、Async Serial UART decode、Data Table/Terminal。
- `docs/ported-features/2026-07-16-cursors-sidebar.md`
  - Cursors On、x/y cursor 表格、Copy、`C` 快捷键和 x1/x2 波形 overlay。
- `docs/ported-features/2026-07-16-measurements-sidebar.md`
  - Range Measurements 对象模型、右栏列表/动作、波形 range overlay 和基础数字指标。
- `docs/ported-features/2026-07-16-timing-markers-sidebar.md`
  - Timing Marker 对象模型、Add Pair/Single、右栏列表/动作和波形 marker overlay。
- `docs/ported-features/2026-07-16-extensions-sidebar.md`
  - Extensions 应用级管理器、搜索/菜单/列表、安装启停、创建/加载、详情页与 HLA selector 联动。
- `docs/ported-features/2026-07-16-notes-sidebar.md`
  - Notes 原版标题/帮助/编辑器排版、`N N` 快捷键和 session 独立内容。
- `docs/ported-features/2026-07-16-interaction-time-axis-polish.md`
  - 右侧栏 tooltip、Devices 通道色、左侧通道重命名/右键菜单、智能时间轴和竖直虚线。
- `docs/ported-features/2026-07-16-saleae-time-axis.md`
  - 直接搬运原版高精度双层时间刻度、major/minor 分组和两级竖直虚线算法。
- `docs/ported-features/2026-07-16-saleae-channel-colors.md`
  - 直接搬运原版 legacy 8 色通道色板，并统一 Devices、通道标签和波形颜色。
- `docs/ported-features/2026-07-16-device-settings-channel-layout.md`
  - Device Settings 捕获后通道显示/隐藏、32 通道自动布局、逐行高度拖动和纵向滚动。
- `docs/ported-features/2026-07-16-sticky-timing-waveform-demo.md`
  - 30px 置顶时间标尺、固定 8px 数字波形 gutter，以及基于原版 Graph Server 实测的变脉宽 Demo 数据。
- `docs/ported-features/2026-07-16-channel-arming-gridline-polish.md`
  - 捕获后新启用通道的空行占位、仅左侧标签栏可调整高度，以及原版 DarkTheme 网格线色值。
- `docs/ported-features/2026-07-16-strip-chart-scrollbar.md`
  - 原版 10px 单 thumb 水平时间滚动条、viewport 比例换算、拖拽平移和轨道点击动画。
- `docs/ported-features/2026-07-17-demo-session-stream-stability.md`
  - Demo 设备选择不自动采集、Stream/4096 MiB 默认 buffer、live summary 约 30fps 和停止 partial capture。
- `docs/ported-features/2026-07-17-analyzer-bubbles-viewport-window.md`
  - Analyzer viewport frame window、纯 hex bubbles、previous/next frame、300 marker 上限和长捕获 Fit 聚合保护。
- `docs/ported-features/2026-07-17-analyzer-protocol-bubbles.md`
  - Analyzer overlay 改为独立 `protocolBubbles` 模型，Fit Capture 下 multi bubble 覆盖完整 graph，并按原版像素阈值拆合。
- `docs/ported-features/2026-07-17-channel-context-menu.md`
  - 通道标签右键菜单、Show/Hide Channels 子菜单、隐藏行状态、Auto Layout 和交互测量开关。
- `docs/ported-features/2026-07-17-channel-context-menu-completion.md`
  - 补齐图表区右键、Delete Data 子菜单、真实 sample 裁剪 API，以及 Screenshot 菜单占位。
- `docs/ported-features/2026-07-17-add-range-measurement-placing.md`
  - Add Range Measurement 原版 placing 模式、通道绑定 range overlay、图上 tooltip 和 Measurements 右侧栏 RangeItem 深化。
- `docs/ported-features/2026-07-17-range-measurement-runner.md`
  - Range measurement 真实后端统计、Measurements2 风格 Add/Remove Measurements、逐项启用/删除与 copy 输出。
- `docs/ported-features/2026-07-17-range-measurement-interaction-parity.md`
  - Range placing 竖条预览、主图 tooltip 可拖动/隐藏恢复，以及 Measurements 右栏轻量 RangeItem 对齐。
- `docs/ported-features/2026-07-18-range-measurement-tooltip-polish.md`
  - Range tooltip 原版两段式视觉、完整默认统计项、HTML/math 标签、固定 fuchsia 默认色、原版小图标和右栏 RangeItem 视觉补齐。
- `docs/ported-features/2026-07-18-range-measurement-comment-bubble.md`
  - Range tooltip comment 在右侧 Measurements item 中同步显示为原版 Note 风格气泡。
- `docs/ported-features/2026-07-18-range-measurement-sidebar-layout.md`
  - Measurements 右侧栏 RangeItem subgrid、comment 气泡省略、展开 measurement 行、hover-only actions 和原版空态图。
- `docs/ported-features/2026-07-18-range-measurement-sidebar-polish.md`
  - Range measurement 默认折叠、count 文案回到原版可读文本、goto/menu 尺寸与颜色收紧。
- `docs/ported-features/2026-07-18-range-measurement-sidebar-parity-fix.md`
  - Range item 背景状态改回原版暗色常量、右侧操作按钮常显、edge count 明细恢复 `N` 加文字下标。
- `docs/ported-features/2026-07-18-range-measurement-sidebar-hover-animation.md`
  - Measurements 侧栏 item 不再渲染持久 selected 高亮，右侧 goto/zoom 复用 animated viewport 路径。
- `docs/ported-features/2026-07-18-sidebar-resize-handle.md`
  - 右侧 Sidebar active panel 复用原版 300px 最小宽度、47px rail 和 5px `ew-resize` 热区，支持横向拖拽调整。
  - Sidebar 子树改为直接继承 Logic 2.4.43 `builtin.ts` DarkTheme 色值，避免同名本地 token 造成视觉偏差。
- `docs/ported-features/2026-07-20-timing-markers-interaction-parity.md`
  - Timing Markers temp placement、Pair/Single、图上/右侧菜单、编辑弹窗、原版时间格式和选择/删除快捷键的完整交互搬运。
- `docs/ported-features/2026-07-20-analyzer-protocols-cache-trigger-view.md`
  - UART 之外的 I2C/SPI 电平解码、长捕获有界 frame/bubble 缓存、viewport 本地投影，以及 Analyzers 侧栏 Trigger View 结构占位。
- `docs/ported-features/2026-07-20-analyzer-channel-roles-markers.md`
  - Analyzer 通道角色副标题、I2C/SPI 分通道短气泡、SCL/Clock 有效边沿 marker，以及原版风格通道下拉控件。
- `docs/ported-features/2026-07-21-analyzer-bubbles-lazy-computation.md`
  - Analyzer 气泡从 useMemo 预计算改为渲染时懒加载 + 缓存，解决滚轮缩放卡顿问题。
- `docs/ported-features/2026-07-22-graph-server-32-channel-pipeline.md`
  - 参考 Electron packed waveform 与原版 Graph Server 边界，落地 Rust 32 通道增量 graph、固定预算波形传输、实时 analyzer cache 和有界气泡聚合。
- `docs/ported-features/2026-07-22-analyzer-demo-protocol-performance.md`
  - Analyzer 驱动 UART/I2C/SPI Demo 波形、原版 I2C 气泡文本、六通道缩放滚动优化，以及深缩放边沿连续性修复。
- `docs/ported-features/2026-07-22-pxview-hardware-profile-buffer-mode.md`
  - 搬运 PXView PXLogic profile/channel-mode 矩阵，真实 USB 捕获按硬件 mode 限幅，并修正 Buffer Mode DDR read request 与 `0x83` 数据端点。
- `docs/ported-features/2026-07-22-pxview-prepare-firmware-retry.md`
  - 搬运 PXView prepare 阶段 MCU firmware version 诊断、PXLogic 端点清理和 FPGA bitstream 上传失败重试。
- `docs/ported-features/2026-07-22-pxview-device-enumeration-identity.md`
  - 搬运 PXView 设备枚举身份探测：USB string、`PX*` manufacturer 检查、`REG_LOGIC_MODE` 读取、profile 标签和 probe diagnostics。
- `docs/ported-features/2026-07-22-usb-smoke-real-hardware-verification.md`
  - 增强 `usb_smoke` 的 list/prepare-only 真机验证入口，完成 U2 32ch stream、buffer 和 raw cross mapping smoke capture。
- `docs/ported-features/2026-07-22-tauri-effective-capture-settings-sync.md`
  - Tauri UI live/completed capture 路径同步后端 effective samplerate/channel count，真实硬件被 PXView profile 限幅后控件显示不再滞留请求值。
- `docs/ported-features/2026-07-22-pxview-capabilities-ui.md`
  - 将 PXView `channel_modes[]` 和 `supported_PX[]` 暴露为 Tauri `device_capabilities`，Devices/Recording Settings 按真实 profile 过滤通道数与采样率，并在捕获前同步限幅。
- `docs/ported-features/2026-07-22-pxview-trigger-filter-settings.md`
  - 搬运 PXView simple trigger mask 与 `SR_FILTER_1T` 路径，Tauri 捕获开始时将 Trigger channel/type、Trigger Sampling rate 和 Glitch filter 写入真实硬件寄存器脚本。
- `docs/ported-features/2026-07-23-pxview-cross-data-all-channel-modes.md`
  - 按 PXView `LA_CROSS_DATA` stripe 定义补齐 1/2/4/8/16/32 通道增量解交织，避免高速少通道真机采集被误当成普通 sample words。
- `docs/ported-features/2026-07-23-graph-stream-render-smoke.md`
  - 新增真实 USB decoded chunks 到 GraphSession/render frame 的完整 smoke，校验 sample count、packed tile 和 exact segment 边沿连通性。
- `docs/ported-features/2026-07-23-analyzer-waveform-render-isolation.md`
  - 将 waveform tile 与 I2C/SPI analyzer 聚合拆分为独立请求队列，避免分析器延迟导致深倍率竖边沿晚于水平段更新。
- `docs/ported-features/2026-07-23-pxview-cancellable-low-rate-stream.md`
  - Stop 改为取消 active handle 的同步 USB poll，并按 PXView block 填充时间放宽低速 stall deadline，消除 Busy 与 5 秒误超时。
- `docs/ported-features/2026-07-23-pxview-hardware-trigger-time-zero.md`
  - 搬运 PXView `trig_out_validset`/`real_pos` 触发语义、Stream 状态轮询和 10%/90% 预触发限幅；真实触发贯穿 GraphSession、`.pxcap` 与 Tauri event，并以 Logic 2 风格 `T` 标记作为时间零点。
- `docs/ported-features/2026-07-23-pxview-sparse-channel-capture.md`
  - 搬运 PXView `en_ch_num()`/`en_ch_num_mask()` 与 enabled-channel cross stripe 语义；D0+D4 等稀疏选择现在写入真实 mask、按两 lane 采集，并以物理 D0/D4 位进入 GraphSession、`.pxcap` 和 UI。
- `docs/ported-features/2026-07-23-pxview-sparse-channel-export.md`
  - 搬运 PXView `srzip.c` 的 enabled physical probe 规则；稀疏 `.sr`/VCD 只声明真实采集通道，同时保留物理 probe 编号和 sample bit。
- `docs/ported-features/2026-07-23-pxview-pwm0-output.md`
  - 搬运 PXView PWM0 的 125MHz clock、整数 tick 量化和 disable/program/restore register path，并接入 Device Settings、Tauri 与真机 disabled smoke。
- `docs/ported-features/2026-07-23-pxview-hardware-io-settings.md`
  - 搬运 PXView External Trigger 六种模式、Clock Negedge 和 Trigger Out；修复 UI Start 前强制关闭硬件 I/O，并以真实 U2 负沿采样验证 GPIO bit。
- `docs/ported-features/2026-07-23-pxview-startup-fpga-prewarm.md`
  - 搬运 PXView 启动阶段设备 prepare 语义：真实 USB 设备枚举后后台预热 FPGA，Tauri 进程内缓存和并发去重，后续 Start/PWM 配置复用已上传状态，USB 错误时清除缓存；MCU firmware 仍不自动刷写。
- `docs/ported-features/2026-07-23-channel-reorder-and-last-row-resize.md`
  - 搬运 GraphRows/Reorder 的可见通道排序，以及 PXView 最后一条 trace 的底边高度调整。
- `docs/ported-features/2026-07-23-startup-default-channels-edge-navigation.md`
  - 启动页移除 MSO、默认启用 D0-D7，并按原版 Graph Server transition 元数据修复边沿按钮和快捷键偶发失效。
- `docs/ported-features/2026-07-23-decoder-backend-migration-baseline.md`
  - 停止扩张自有 Rust decoder，建立 Saleae Native / Sigrok Native 后端契约和 SPI 跨生态一致性夹具。
- `docs/ported-features/2026-07-23-saleae-native-spi-sidecar-poc.md`
  - 固定 Logic 2.4.43 / Analyzer SDK ABI，在隔离 sidecar 中直接加载原版 SPI analyzer；Mode 0-3、LSB 和 CS 边界 fixtures 全部通过，并接入统一 `DecoderOutput` Rust adapter。
- `docs/ported-features/2026-07-23-saleae-sal-import-export.md`
  - 直接调用 Logic 2.4.43 GraphServer 的 DigitalStore/ExportNode 将 `.sal` 转为公开 digital binary，并以 `u64` transition index 导入，不展开长捕获。
- `docs/ported-features/2026-07-23-sigrok-native-spi-sidecar.md`
  - 独立 GPL sidecar 直接构建 PXView `libsigrokdecode` 与 `spi_c`，统一输出 `DecoderOutput`，SPI 跨生态 fixtures 全部通过。
- `docs/ported-features/2026-07-23-sparse-native-decoder-bridge.md`
  - 将 `.sal` 的 transition index 直接接入 Saleae Native / Sigrok Native SPI，Sigrok 复用 PXView `spi_c` C decoder 的状态机而不展开长捕获，补齐 490 亿 sample 大索引回归。
- `docs/ported-features/2026-07-23-sigrok-native-uart-i2c-catalog.md`
  - 直接接入 PXView `uart_c`/`i2c_c`，与 `spi_c` 共用 transition runtime；顶部和右侧 Analyzer 选择器改为来源到协议的两级菜单，三协议均补齐 packed/sparse 与 490 亿 sample 回归。
- `docs/ported-features/2026-07-24-saleae-sal-native-export.md`
  - packed/sparse capture 通过 Logic 2.4.43 原版 DigitalStore 校验并序列化为 `.sal`；补齐 32 通道、恒定电平与 490 亿 sample 的无展开 round-trip。
- `docs/ported-features/2026-07-24-saleae-sal-analyzer-restore.md`
  - 复用 Logic 2 persisted analyzer migration/startAnalysis 流程；`.sal` 导入自动恢复 SPI/I2C/Async Serial 配置并重新解码，导出可无损保留原始 analyzer metadata。
- `docs/ported-features/2026-07-24-saleae-sparse-analyzer-progressive-restore.md`
  - 修复长 `.sal` native analyzer 整段批处理阻塞；按 viewport/边沿窗口渐进解码，并同步恢复波形 bubbles 与右侧 Data Table 结果。
- `docs/ported-features/2026-07-24-saleae-sal-frame-table-session-isolation.md`
  - 过滤 Saleae Native SPI 控制 frame 的伪数据气泡，恢复 Type/MOSI/MISO 动态表格列，并隔离普通新 session 与显式 setup duplicate 的通道名称继承语义。
- `docs/ported-features/2026-07-24-analyzer-table-navigation-keyboard-viewport.md`
  - 搬运 Data Table 可视右边界 `GoToButton`、原版 goto SVG，以及 Up/Down/Left/Right 与 W/S/A/D 的 0.5x/2x 缩放和三分之一屏平移动画。
- `docs/ported-features/2026-07-24-saleae-native-uart-i2c-sidecar.md`
  - 直接加载 Logic 2.4.43 原版 Async Serial/I2C/SPI 插件，共用 packed/sparse transition bridge；`.sal` 三协议恢复改回 Saleae Native，Rust 仅保留 sidecar 适配职责。
