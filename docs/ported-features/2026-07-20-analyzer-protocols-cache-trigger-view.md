# Analyzer 协议解码、缓存与 Trigger View

## 功能范围

- 在 UART 之外增加 I2C 和 SPI 的真实数字电平解码。
- 解码结果按 session 缓存，缩放和拖动 viewport 时只做本地 frame window/bubble 投影。
- 长捕获限制解码结果和气泡数量，保留完整时间范围的均匀 MultiBubble 聚合。
- Analyzers 侧栏增加原版结构的 Trigger View 占位，包括折叠区、Analyzer 选择、Query、Holdoff 和不可用开关状态。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzerManager.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzersSidebar.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzersSelector/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/triggers/compositions/Settings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/triggers/Manager.ts`

## 实现落点

- `crates/pxlogic-core/src/decode.rs`
  - 根据捕获的数字采样电平和边沿解码 UART、I2C、SPI。
  - `FrameCollector` 对超长捕获做有界抽样，扫描仍覆盖到捕获末尾。
- `crates/pxlogic-core/src/capture.rs`
  - Demo D1/D2 提供合法 I2C START/STOP 和 ACK 时序。
  - Demo D3-D6 提供 SPI MOSI/MISO/Clock/Enable 时序。
- `src/lib/api.ts`
  - Tauri 使用通用 `decode_analyzer_frames` 命令。
  - Preview I2C/SPI tile 按协议半周期边界生成；密集长视图直接回退到像素桶统计，避免逐样本主线程扫描。
  - `buildAnalyzerFrameWindow` 使用二分查找和最多 300 个均匀 MultiBubble。
- `src/App.tsx` / `src/components/AnalyzerBubblesOverlay.tsx`
  - 解码只在配置、捕获完成或手动 Restart 后执行。
  - viewport 变化不重新请求后端解码，bubble 位置按当前 viewport 本地投影。
- `src/styles.css`
  - Trigger View 复用原版边框、背景、折叠过渡和 `3fr 2fr` Query/Holdoff 布局。

## 验证

- Rust `pxlogic-core` 单测覆盖手工 UART/I2C/SPI 和生成 Demo I2C/SPI。
- `cargo test --workspace --no-default-features`。
- `pnpm build`。
- 浏览器从干净页面完成约 `10.42M` samples 的 Demo 捕获后，I2C 解码 `4169` 帧、SPI 解码 `40087` 帧；Data 缓存总数 `44256` 在连续缩放后保持不变，仅 viewport bubble 数量随缩放变化。
- I2C/SPI 气泡宽度分别对应约 `80 us` / `7.32 us` 的真实 Demo 边沿，Trigger View 可展开，canvas 维度有效，浏览器 console error 为 0。
- `100000` 帧投影基准中，50 次全捕获聚合和 50 次局部窗口查询合计约 `3.2 ms`；全视图固定为 300 个聚合气泡，局部窗口只返回可见气泡。

## 设计边界

- Saleae 原版的 native analyzer/HLA 运行时和完整协议数据库不直接搬入；当前桌面路径解码的是 PXLogic 捕获的原始数字采样，Preview 路径使用同一 Demo 时序的确定性模拟。
- Trigger View 本轮为原版结构占位，开关仍不可用，尚未连接真实 analyzer-trigger capture backend。
