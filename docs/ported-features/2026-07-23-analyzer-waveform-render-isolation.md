# Analyzer and waveform render isolation

## 功能范围

- 将高优先级 waveform tile 与 I2C/SPI analyzer bubble 聚合拆成独立请求队列。
- 波形缩放不再等待 analyzer decode/merge，避免旧分辨率 tile 被深倍率 viewport 临时拉伸。
- Analyzer 请求单独限频、合并 pending viewport，并继续淘汰过期 frame。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`
  - 复用 RAF 驱动、最新 viewport 优先和 stale result discard 规则。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/defaults.ts`
  - 复用图形更新与辅助渲染任务分层的结构边界。

## 本地落点

- `src/App.tsx`
  - waveform-only GraphFrame 队列保持 24/33ms 节流。
  - analyzer GraphFrame 队列使用独立 sequence/in-flight/pending 状态，空通道 tile 仅承载 analyzer window 请求。
- `crates/pxlogic-graph/src/lib.rs`
  - 回归测试确保同一 viewport 加入 I2C/SPI analyzer 后 waveform tile 字节级不变。

## 复用方式

- 状态规则搬运：波形主渲染与分析器辅助渲染分别排队，任何旧结果都不能覆盖最新 viewport。
- 现有 GraphSession、analyzer cache、packed bins 和 exact segments 均继续复用，没有另建波形数据模型。

## 用户可见行为

- 配置 I2C + SPI 后快速缩放时，水平脉宽与 rising/falling 竖边沿同步更新。
- Analyzer 气泡可以稍后独立完成聚合，但不会阻塞或替换数字波形 tile。
- Fit Capture 的气泡仍覆盖完整捕获，深倍率下仍拆分为单帧气泡。

## 验证

- `pnpm build` 通过。
- Chrome 1440x960，16 个可见通道并配置 I2C + SPI：
  - 22 次连续深倍率缩放到 `21 S/px`，最慢 frame 约 26.3ms。
  - 没有超过 32ms 的 frame、没有 long task、没有 console error。
  - `1 S/px` 跳转到真实边沿后，竖边与上下水平段闭合。
  - Fit Capture 返回 296 个有界 I2C bubbles，从 sample 500 覆盖到 sample 35,407,001。
- `cargo test -p pxlogic-graph` 覆盖 analyzer/waveform tile 隔离契约。

## 已知差距 / 后续任务

- Analyzer 辅助队列在捕获中以 100ms 为最短间隔，协议气泡可能比波形晚一帧出现，这是为保证采集与缩放优先级保留的行为。
- 后续可以增加 analyzer-only Tauri command，移除当前空通道 waveform envelope；现有 envelope 不扫描任何通道，成本固定且很小。

## 对应 Git 提交

- 尚未提交。
