# 置顶时间标尺、数字波形振幅与原版 Demo

## 功能范围

- 将 30px 时间标尺从通道滚动 Canvas 中拆出，固定在 GraphRows 顶部。
- 时间标尺和波形网格分别绘制，但共享同一组原版 major/minor tick 算法。
- 数字波形改用原版固定 8px 上下 gutter，行高增加时波形振幅同步增加。
- 桌面后端和浏览器预览的 Demo 数据改为 Logic Pro 16 风格的独立变脉宽通道。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/TopArea.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/TopArea.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/ConnectedTimingDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/TimingDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/drawTick.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/constants.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GridLines.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/DigitalCanvas.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/constants.ts`
- Logic 2.4.43 原安装包中的 `libgraph_server_shared.dylib` Demo 输出。

## 本地落点文件

- `src/components/TimingDisplayCanvas.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/lib/saleaeChannelLayout.ts`
- `src/lib/api.ts`
- `src/App.tsx`
- `src/styles.css`
- `crates/pxlogic-core/src/capture.rs`

## 复用方式

- 结构搬运：复用原版 `TopArea -> ConnectedTimingDisplay -> GraphRows scroller` 的层级，将时间标尺放在纵向滚动容器外。
- 算法搬运：继续使用原版 `getHorizontalGraphTicks`；显示层使用 `minorThresholdPx=45`、`addClosestOffscreenMajorTicks=true`、`negativeMinorTicks=true`。
- 缩放状态搬运：时间标尺直接复用波形 Canvas 的实际 graph width 计算 `timeSecPerPixel`，不会把纵向滚动条宽度误计入波形时间范围。
- RowV2 对齐：时间标尺使用原版 `4px` container padding 与 `4px` row spacing 组成的固定左 inset，使 tick 与波形 GridLines 共用同一 x 原点。
- 几何搬运：复用 `TIMING_DISPLAY_HEIGHT=30`、major tick 位于半高、minor tick 位于底部 3px、离屏 major tick 左箭头，以及不钳制普通 tick 文本位置的规则。
- 波形搬运：复用 `DIGITAL_GRAPH_FULL_SIZE_GUTTER_PX=8`；`highY=gutter+0.5px`，transition height 为行高减去两侧 gutter，lowY 随行高扩展。
- Demo 行为搬运：用官方 Automation 接口实际捕获 Logic Pro 16 模拟设备。100MHz 捕获中各通道 run length 为 1..32768 samples；25MHz 再次捕获后时间宽度同比扩大 4 倍，确认原版按 sample count 生成，而非固定时间周期。
- 浏览器与桌面使用同一确定性 32 位 LCG 生成 1..32768 samples 的独立 run length，保证测试和截图可复现。

## 用户可见行为

- 无论通道列表滚动到 D0 还是 D31，时间刻度始终固定在波形区顶部。
- 时间标尺为 30px，major/minor 标签、离屏 major 箭头和竖直网格与原版参数一致。
- 28px 最小通道行中，波形上下约留 8px；行高增大后高低电平接近占满可用高度，不再固定居中于 28%/72%。
- Demo 各通道具有不同的首边沿、脉宽和局部占空比，不再是等周期、50% 占空比的整齐方波。

## 验证方式

- `pnpm build`
- `cargo test --workspace`
- 浏览器加载 Demo，Device Settings 点击 `All` 后重新捕获 32 通道。
- 运行态记录：graph `clientHeight=550`、`scrollHeight=1030`；从 `scrollTop=0` 滚动到 `480` 后，时间标尺始终保持 `top=66`、`bottom=96`、`height=30`。
- 32 行均为 28px，Canvas 内容高 1020px；滚动后 D15-D31 可见，时间标尺仍在顶部。
- 浏览器控制台无错误。
- 原版 Demo 实测：100MHz/约 200ms 时每通道约 1200 个边沿，run length 最大约 327.68us；25MHz 时最大约 1.31ms，对应同一 32768 samples 上限。

## 已知差距 / 后续任务

- 原版 Logic Pro 16 空白 Demo 的 D0-D15 都由 Graph Server 生成变脉宽数据。PXLogic 桌面后端暂时保留 D0 的 `PXLogic demo` UART 数据，以维持现有 UART analyzer 的真实 decode 流程；D1-D31 使用原版 run-length 结构。浏览器 analyzer 使用 mock decode，因此 D0-D31 均显示原版结构。
- 当前时间零点仍固定为捕获起点；原版的 wall-clock time、trigger-relative time zero 和右键 Time Zero 菜单尚未搬运。
- Demo 的 run-length 分布和样本上限来自真实输出，PRNG 内部实现为本地确定性实现，不依赖原版二进制运行时。

## 对应 Git 提交

- `port: sticky timing display and demo waveforms`
