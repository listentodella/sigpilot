# Analyzer Protocol Bubbles

## 功能范围

- 将 analyzer overlay 从“直接拿当前 table frame 列表即时分组”改为“消费独立的 Saleae 风格 `protocolBubbles` 模型”。
- Fit Capture / 全局缩略视图下，bubble 聚合区间覆盖完整可视捕获范围，不再只集中在前 300 个 decoded frame 所在的开头区域。
- 放大视图继续按原版常量拆分：frame 宽度小于等于 15px 且相邻间距小于等于 30px 时合并为 multi bubble；否则显示单帧 bubble。
- Bubble 双击改为 zoom 到 bubble 自身的 sample interval，而不是只能 zoom 到 Data Table 里已有的单帧。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/GraphClient/GraphData.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/models/index.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzerManager.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/manager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/Bubbles.tsx`

## 本地落点文件

- `src/lib/api.ts`
- `src/lib/analyzers.ts`
- `src/components/AnalyzerBubblesOverlay.tsx`
- `src/App.tsx`

## 复用方式

- 结构复用：新增 `AnalyzerBubble`，对应原版 `SingleBubble/MultiBubble` 的 `frameIdInterval`、区间和 `displayText` 概念。
- 常量复用：继续使用原版 `maximumMarkerResults = 300`、`maxMultiBubbleStrings = 400`、`maxPixelWidthForMergeableFrame = 15`、`maxPixelsBetweenMergeableFrames = 30`。
- 渲染规则复用：overlay 改用原版 `Bubbles.tsx` 的像素裁剪公式，计算 `left`、`originalBubbleWidth`、`bubbleWidth`、overflow arrows。
- 适配实现：原版 Graph 后端会直接返回 `protocolBubbles`；PXLogic 当前在前端 API 层为 preview / full decoded frames 生成等价 bubble window。

## 用户可见行为

- Fit Capture 后，长 UART demo 的 analyzer bubble 显示为覆盖整段 graph 的 multi bubble，而不是只堆在最左侧。
- 放大后，bubble 会按屏幕像素密度从 multi bubble 逐步拆成对应的单帧 hex bubble。
- Data Table 的 300 行窗口限制不再影响波形上方 bubble 的空间分布。
- Bubble 文本仍保持纯 hex，不附带 ASCII 可读文本。

## 验证方式

- `pnpm build` 通过。
- 浏览器验证：
  - Demo 设备选择后不会自动采集。
  - 手动 Start 后短流式捕获约 `62.61 MS / 119.41 MiB`。
  - 添加 Async Serial 后，默认 100k sample 视窗显示 43 个单帧 bubble，分布在完整 graph 宽度内。
  - 点击 Fit Capture 后，显示 1 个 `99+` multi bubble，宽度约等于 graph 宽度 `1030px`，tooltip 显示 `[26412 results]`。
  - 连续放大后，bubble 保持原版区间裁剪行为；在 1 sample/px 左右单个 UART frame 可跨满屏，但文字不缩放。

## 已知差距 / 后续任务

- 原版 `protocolBubbles` 聚合由 Graph 后端生成，本轮是在前端 API 层按同一接口和常量补齐；真实超长硬件捕获仍应迁移到后端 window decode / bubble generation。
- Tauri 路径目前仍先全量 `decode_uart_frames` 再生成 bubbles，后续需要避免真实长采集时一次性解码全部 frame。

## 对应 Git 提交

- 本提交：`port: analyzer protocol bubbles`
