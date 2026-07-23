# Analyzer demo protocol performance and edge fidelity

## 功能范围

- Demo capture 根据已配置的 Analyzer 通道生成对应 UART、I2C、SPI 数字波形。
- I2C 气泡文本、聚合分布和缩放拆分行为对齐 Logic 2.4.43。
- 优化 I2C + SPI 六通道场景的波形缩放、横向滚动和气泡重排性能。
- 修复深度放大后协议波形高低电平与竖直边沿断连的问题。

## 原版参考路径与实测

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/Bubbles.tsx`
  - 复用 computed horizontal transform、stateless position update、bubble 文本宽度选择和 multi bubble 计数规则。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/styles.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/Bubbles.module.css`
  - 复用 16px 气泡高度、12px Roboto 文本和箭头/计数器结构。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`
  - 复用 RAF 驱动、丢弃过期结果和有界请求队列规则。
- Logic 2 DevTools `127.0.0.1:9222` 实测 I2C 文案：
  - `Setup Write to [0x20] + ACK`
  - `0x90 + ACK`
  - `0x90 + NAK`

## 本地落点

- `crates/pxlogic-core/src/capture.rs`
  - Analyzer 通道声明到 Demo signal 的映射，以及 UART/I2C/SPI 协议波形生成。
- `crates/pxlogic-core/src/decode.rs`
  - I2C channel bubble 文案和 ACK/NAK 输出。
- `crates/pxlogic-core/src/fake.rs`
  - Native Demo stream 使用 Analyzer 设置持续生成协议波形。
- `crates/pxlogic-graph/src/lib.rs`
  - packed bins、深缩放 exact segments、Analyzer edge decode 与聚合窗口。
- `src-tauri/src/main.rs`
  - Demo capture 向 native capture 入口传入 Analyzer 配置。
- `src/App.tsx`
  - Graph tile overscan 复用、分辨率约束、请求限频和 Analyzer decode signature 失效规则。
- `src/lib/api.ts`
  - 浏览器 preview 的 Analyzer 驱动 Demo 波形、I2C/SPI frame 和深缩放 exact segments。
- `src/components/WaveformCanvas.tsx`
  - packed bin 可见窗口遍历、相邻 bin 边界补线、exact segment 二分裁剪和稳定 viewport 同步。
- `src/components/AnalyzerBubblesOverlay.tsx`
  - 气泡 DOM 复用，viewport 变化时直接更新位置，不重建 React 节点。
- `src/styles.css`
  - 原版气泡字体和尺寸细节。

## 复用方式

- 行为与算法搬运：原版 bubble transform、multi bubble 聚合、文本选择和请求淘汰规则。
- 协议适配：将原版设备 demo 行为接到 PXLogic 的 Analyzer 通道设置和 32 通道 capture 模型。
- 渲染契约：中低倍率使用固定像素预算 packed bins；最多 8 samples/pixel 的深倍率恢复 exact segments。
- 性能适配：Canvas 只遍历当前 viewport 覆盖的 bins/segments；Bubble 节点仅在 Analyzer 数据变化时重建。

## 本次回归修复

- 根因：长时间 Demo capture 下，I2C/SPI 协议波形超过 preview exact/bin segment 上限后会进入 sampling fallback；旧 fallback 只看每个 bin 的首尾电平，没有按协议半周期记录 bin 内 transition，导致某些缩放比例下只剩高低水平段，竖直边沿被吞掉。
- 原版对齐点：Logic 2.4.43 的 digital render data 使用 `ALWAYS_LOW`、`ALWAYS_HIGH`、`ONE_OR_MORE_TRANSITIONS` primitive 表达像素是否包含 transition；本地 preview fallback 现在也按 I2C/SPI half-period 扫描 bin 内边界，并在过密时退化为 transition primitive 风格的 dense block。
- 深缩放策略：`graphTileCanServeViewport` 在 `<= 8 S/px` 且缓存 tile 没有 `segments` 时不再复用旧 tile，强制重新请求 exact segments，避免粗粒度 packed bin 服务精细视图。
- Canvas 连续性：packed bin 和 exact segment 渲染都对可视区边缘做 line-width 容差补线，并保留左侧离屏 bin 的 `last` 状态，保证边界处的 rising/falling 竖线与水平脉宽闭合。

## 用户可见行为

- 选择 Demo device 后不会自动采集；点击 Start 后按当前 Analyzer 配置产生协议波形。
- I2C D1/D2 与 SPI D3-D6 可以同时工作，气泡分别落在 SDA、MOSI、MISO 通道。
- Fit Capture 下聚合气泡从捕获起点分布到终点，不再集中在前半段。
- 放大后聚合气泡自然拆成单帧，I2C 显示原版 ACK/NAK 文本。
- 深度放大时协议波形的水平脉宽与上下边沿保持闭合，不再出现断线。

## 验证

- `pnpm build` 通过。
- `cargo test -p pxlogic-core` 通过：Core 17 项。
- `cargo test -p pxlogic-graph` 通过：Graph 8 项。
- Chrome 1440x960 浏览器回归：
  - D1/D2 配置 I2C，D3-D6 配置 SPI，显示通道数为 6。
  - Stream 累积约 38.7M samples / 36.9 MiB 后手动停止，无 console error。
  - Fit Capture 共约 900 个有界聚合气泡，三个 bubble tracks 都覆盖到捕获末端。
  - 80 次连续缩放：无超过 32ms 的帧，无 long task。
  - 80 次深倍率横向滚动：无超过 32ms 的帧，无 long task。
  - 字节窗口截图确认 I2C SCL、SPI MOSI/MISO/Clock/Enable 的竖边均与水平段连接。
- 本次补充浏览器回归：
  - 选择 Demo device 后先添加 I2C Analyzer，再点击 Start，确认不会在选择设备后自动开始采集。
  - 长 capture 过程中从 `97 S/px` 放大到 `12 S/px`、`3 S/px`，I2C D0/D1 水平段与 rising/falling 竖线保持连续。

## 已知差距 / 后续任务

- 当前协议驱动 Demo 只覆盖 UART、I2C、SPI；其余 LLA/HLA 仍需接入对应生成器和插件 ABI。
- 浏览器 preview 与 native Graph 共用相同倍率边界，但底层数据来源不同，后续新增协议时仍需双路径测试。

## 对应 Git 提交

- 尚未提交。
