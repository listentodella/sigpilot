# PXLogic 文件地图

本文档记录当前主仓库里应由 Git 管理的文件，以及本地外部参考目录。后续搬运 Saleae 功能时，新的文件应同步登记到这里，避免目录继续失控。

## 主仓库代码

- `src/App.tsx`
  - 当前 React 工作台主体。
  - 包含 session 状态、底栏、右侧栏、捕获入口、文件导入导出、UART analyzer 面板、缩放、hover 测量入口、通道右键菜单状态、Add Range Measurement 放置状态和 Measurements range overlay/tooltip。
- `src/styles.css`
  - 全局视觉样式。
  - 包含 Saleae 风格顶部工具栏、启动页、右侧栏、底栏、session tab、popover、波形区域样式。
- `src/main.tsx`
  - React 入口。
- `src/vite-env.d.ts`
  - Vite 类型声明。

## 前端组件

- `src/components/DeviceStartScreen.tsx`
  - 启动时的设备选择界面。
  - 使用 Saleae Logic / Logic Pro 风格设备图。
- `src/components/CaptureNotesPanel.tsx`
  - Notes 右栏标题、帮助说明和 session 级捕获说明编辑器。
- `src/components/LogicToolbar.tsx`
  - 顶部工具栏骨架。
  - 当前负责 Start、Add Analyzer、Range Measurements、Marker 操作入口。
- `src/components/ExtensionsPanel.tsx`
  - Saleae 风格 Extensions 右栏。
  - 包含搜索、管理菜单、扩展项动作、创建对话框和扩展详情覆盖页。
- `src/components/WaveformCanvas.tsx`
  - 数字波形 Canvas 渲染。
  - 包含平滑数字波形绘制、原版 8px 上下 gutter、边沿吸附、周期/占空比/脉宽 hover 测量显示、右键菜单控制的交互测量开关，以及波形区右键菜单定位。
  - 与 range overlay 共用 `src/lib/saleaeGraphLayout.ts` 计算 row 几何。
- `src/components/TimingDisplayCanvas.tsx`
  - 独立于通道滚动区的 30px Saleae 时间标尺。
  - 搬运原版 major/minor tick、离屏 major 箭头和标尺背景绘制规则。
- `src/components/StripChartScrollbar.tsx`
  - 从 Logic 2.4.43 `stripChartScrollbar` 搬运的单 thumb 水平时间滚动条。
  - thumb 宽度表示可视时间范围，位置表示当前 viewport 起点。
- `src/components/AnalyzerBubblesOverlay.tsx`
  - Saleae 风格 analyzer bubble overlay。
  - 消费独立 `protocolBubbles` 模型渲染 Async Serial bubbles、multi bubble 聚合、像素裁剪和 previous/next data 按钮。
- `src/components/AnalyzerSettingsDialog.tsx`
  - Async Serial analyzer 设置对话框。
  - 包含输入通道、bit rate、inverted、Data Table / Terminal 开关。

## 前端工具与 API

- `src/lib/api.ts`
  - Tauri 命令封装。
  - 覆盖设备列表、捕获、停止、tile 获取、文件打开保存、导出、sample 裁剪、UART decode、viewport UART frame window、Saleae 风格 protocol bubble window，以及浏览器变脉宽 Demo tile。
- `src/lib/analyzers.ts`
  - Analyzer UI 状态类型、Saleae analyzer 色板、protocol bubble 状态、bubble strip 尺寸常量和 Async Serial decode 支持判断。
- `src/lib/format.ts`
  - 时间与数量格式化工具。
- `src/lib/extensions.ts`
  - 扩展 manifest、来源与安装状态类型。
  - 包含默认扩展、排序规则、持久化和本地 package 转换。
- `src/lib/sidebar.ts`
  - 右侧栏面板类型、原版命令字符串、面板快捷键和命令到面板映射。
- `src/lib/saleaeChannelLayout.ts`
  - 从 Logic 2.4.43 RowsManager 搬运的数字通道默认/最小高度、自动布局、RowV2 间距和 resize handle 几何。
- `src/lib/saleaeGraphLayout.ts`
  - 供 Canvas、波形右键定位、range placing/overlay 共用的 Saleae row 几何计算。
  - 从 `WaveformCanvas` 抽出，避免后续图上交互使用不一致的 row top/height。
- `src/lib/saleaeTimingDisplay.ts`
  - 从 Logic 2.4.43 `timingDisplay.ts` 搬运的高精度 major/minor 时间刻度算法。
  - 包含原版 DarkTheme `border-10` / `border-20` GridLines 色值。

## 已搬入的小型 Saleae 视觉资源

- `src/assets/saleae/logicDarkTheme.png`
  - 启动页 Logic 设备图。
- `src/assets/saleae/logicMsoDarkTheme.png`
  - 启动页 Logic Pro / MSO 设备图。
- `src/assets/saleae/sidebar/devices.svg`
- `src/assets/saleae/sidebar/recordingSettings.svg`
- `src/assets/saleae/sidebar/analyzers.svg`
- `src/assets/saleae/sidebar/cursors.svg`
- `src/assets/saleae/sidebar/measurements.svg`
- `src/assets/saleae/sidebar/timingMarkers.svg`
- `src/assets/saleae/sidebar/extensions.svg`
- `src/assets/saleae/sidebar/notes.svg`

## Tauri 与后端

- `src-tauri/src/main.rs`
  - Tauri 命令层和事件转发。
  - 包含读取本地扩展 package、创建扩展模板目录和当前 capture sample 裁剪的命令。
- `src-tauri/src/bin/usb_smoke.rs`
  - USB smoke test 工具。
- `src-tauri/tauri.conf.json`
  - Tauri 应用配置。
- `src-tauri/capabilities/default.json`
  - Tauri 权限配置。
- `src-tauri/icons/icon.png`
  - 应用图标。
- `src-tauri/gen/schemas/*`
  - Tauri 生成的 schema 文件。

## Rust crates

- `crates/pxlogic-core`
  - 捕获核心、真实 USB backend、demo backend、协议常量、UART decode、数据模型。
- `crates/pxlogic-file`
  - `.pxcap`、`.sr`、VCD 读写。
- `crates/pxlogic-waveform`
  - 波形 tile 生成。

## 项目配置

- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `vite.config.ts`
- `tsconfig.json`
- `tsconfig.node.json`
- `Cargo.toml`
- `Cargo.lock`
- `.cargo/config.toml`
- `.gitignore`
- `README.md`

## 本地外部参考目录

这些目录保留在磁盘上供分析和搬运，但默认不进入主仓库 Git 历史：

- `.app-data/saleae-logic-2.4.43/recovered-ui-source`
  - 从 Logic 2.4.43 安装包提取/恢复出的 UI 源码参考。
  - 体积约 190 MB。
  - 后续每次搬运 Saleae 功能时，应在功能文档里记录具体参考文件路径。
- `pxview-fork`
  - 独立 Git checkout，用于 PXView / libsigrok / 硬件协议参考。
  - 当前自身 HEAD：`8be58de`。
  - 该目录已有本地改动，应单独管理，不混入本仓库。
- `debug-captures`
  - 本地调试采集文件。
  - 如需作为测试样本，应复制到明确命名的 fixture 目录，并在文档中说明来源。
