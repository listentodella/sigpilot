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
