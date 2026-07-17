# Analyzer Bubbles 视窗窗口与聚合

## 功能范围

- Async Serial analyzer 改为按当前 viewport 请求 frame window，而不是一次性展示全捕获结果。
- Bubble / Data Table 使用稳定 `frame_id`，支持 previous/next frame 导航。
- 浏览器 demo 的 UART frames 与 D0 波形使用同一周期生成器，保证气泡和波形一一对应。
- Analyzer label 改为纯十六进制 `0xNN`，不再附带 ASCII 文本。
- 长视窗按原版 `maximumMarkerResults = 300` 限制返回结果，避免 fit / 长捕获时生成海量 DOM。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/manager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzerManager.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/models/index.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/Bubbles.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/NavigationButton.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/styles.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/statelessRender/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/GraphClient/GraphData.ts`

## 本地落点文件

- `src/components/AnalyzerBubblesOverlay.tsx`
- `src/components/AnalyzerSettingsDialog.tsx`
- `src/lib/analyzers.ts`
- `src/lib/api.ts`
- `src/App.tsx`
- `src/styles.css`
- `crates/pxlogic-core/src/decode.rs`

## 复用方式

- 常量搬运：复用原版 `maximumMarkerResults=300`、`minimumMarkerGap=13`、`maxMultiBubbleStrings=400`、`maxPixelWidthForMergeableFrame=15`、`maxPixelsBetweenMergeableFrames=30`、bubble height `16px`、字符宽度 `6px`、overflow arrow `3px`、multi counter `99+`。
- 结构复刻：按原版 `previousFrame / nextFrame / protocolBubbles` 的 response shape，在 PXLogic 中实现 `UartFrameWindow`。
- 行为复刻：bubble 单击高亮、双击 zoom、Cmd/Ctrl+click 打开 table row、hover 时显示 previous/next data 按钮和快捷键。
- 性能适配：原版使用 `StatelessRender` 和 Graph Server 返回的 bubble window；PXLogic 当前保留 React overlay，但只渲染 viewport window，并用 300 marker 上限避免长捕获卡死。

## 用户可见行为

- 添加 Async Serial 后，D0 上方出现与可视 UART frame 对齐的 hex bubble。
- 在长捕获后段视窗中，bubble 从 graph 左侧铺到右侧，不再只集中在前半段。
- Data Table 只显示当前 viewport 的 frame window，并与 bubble 文本一致。
- Fit Capture 时大量 frame 会聚合为 multi bubble，表格最多显示 300 行，页面不崩溃。

## 验证方式

- `pnpm build`
- `cargo check --workspace`
- 浏览器 demo 完成 4096 MiB 长捕获后添加 Async Serial。
- 实测普通后段 viewport：43 个 bubble，Data Table 43 行，全部为 `0xNN`。
- 实测 Fit Capture：bubble 聚合为 1 个 multi bubble，Data Table 300 行，页面保持响应。

## 已知差距 / 后续任务

- Tauri 后端的 `getUartFrameWindow` 目前仍通过 `decode_uart_frames` 全量解码后过滤，真实超长捕获应新增后端 window decode 或 FrameDB。
- 当前本地 bubble overlay 尚未直接搬入原版 `StatelessRender` DOM renderer；如果后续 viewport 内 analyzer 数量更大，应继续迁移这层以减少 React reconciliation。
- 高级 analyzer、HLA template rendering、Data Table query/index warning 尚未搬运。

## 对应 Git 提交

- 待提交：`port: analyzer viewport bubbles`
