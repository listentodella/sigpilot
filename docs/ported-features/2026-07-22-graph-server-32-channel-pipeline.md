# Graph Server 32-channel pipeline

## 功能范围

- 保留当前 Logic 2 风格 React 交互层，将波形索引、视口像素化和 analyzer 气泡聚合下沉到 Rust graph kernel。
- 采集入口原生支持 1-32 个数字通道，并在持续采集时增量刷新波形与 UART/I2C/SPI 解码。
- 收紧长时间采集的原始数据、边沿索引、波形传输和 analyzer 缓存预算。

## 原版与 Electron 参考

- `/Users/leo/work/logic2-anti/ele-gpt/src/lib/app/services/stripChartRender/waveform/render.ts`
  - 复用 packed waveform 的固定四字段像素契约、一次 texture/buffer 上传和按视口绘制边界。
- `/Users/leo/work/logic2-anti/ele-gpt/src/lib/app/services/waveformChannel/parse.ts`
  - 复用 packed buffer 只解码一次并缓存 typed view 的规则。
- `/Users/leo/work/logic2-anti/ele-gpt/src/services/GraphClient/GraphData.ts`
  - 复用 analyzer render request/result、`protocolBubblesV2` 和 previous/next frame 的职责划分。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/services/renderingManager/RenderingManager.ts`
  - 复用 RAF 驱动、过期 frame 丢弃和有界 render queue 行为。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/services/analyzersCommon/manager.ts`
  - 复用 300 marker、400 multi-bubble strings、15px frame 和 30px gap 聚合常量。

没有直接嵌入 Electron 自带的 `libgraph_server_shared.dylib`。该二进制依赖 Node addon ABI、原版设备数据入口和 16 通道假设，不适合作为第三方 32 通道采集入口。

## 本地落点

- `crates/pxlogic-graph/src/lib.rs`
  - 32 通道增量 edge index、indexed waveform tile、UART/I2C/SPI edge decoder、增量 analyzer cache 和 bubble aggregation。
- `crates/pxlogic-core/src/fake.rs`
  - Demo stream 分块生成与约 30fps live summary。
- `crates/pxlogic-core/src/rusb_backend.rs`
  - USB 流式样本发布和 cross-lane 尾包式解交织。
- `src-tauri/src/main.rs`
  - 每个 UI session 独立 GraphSession、组合 `render_graph_frame` 命令和 session 释放。
- `src/App.tsx`
  - RAF single-flight Graph 帧队列、过期响应丢弃、仅请求可见通道和按需 Data Table decode。
- `src/components/WaveformCanvas.tsx`
  - 直接消费 packed digital bins，并为每个 ChannelTile 缓存 DataView。
- `src/components/AnalyzerBubblesOverlay.tsx`
  - 直接消费后端 analyzer track window，不再在 React render 中扫描全部 decoded frames。

## 复用方式

- 算法搬运：原版 packed waveform、render queue、analyzer viewport window 和 bubble merge 常量。
- 架构适配：原版 Graph Server 职责改为 Rust crate，通过 Tauri command 暴露，不搬入 Electron Node ABI 依赖。
- 行为复刻：viewport 只返回固定像素预算；Fit Capture 保持 bubbles 覆盖完整时间轴；缩放后按像素宽度自然拆分。

## 性能边界

- USB cross-lane 捕获只保留不足一个 stripe 的 raw tail；完整 stripe 立即解交织并写入最终 capture buffer，不再同时保留完整 raw 与 decoded 两份数据。
- 4 GiB capture 上限内的 edge sample 使用 `u32` 精确存储，索引宽度从 8 字节降到 4 字节。
- 每个数字像素固定 16 字节：`flags / edge count / first edge offset / last edge offset`，以 base64 跨 Tauri 传递；32 通道 x 1800 像素的 raw packed payload 为 921,600 字节，避免数万个 JSON 对象。
- 精确 segments 只在最多 8 samples/pixel 的深度放大区间返回；其余缩放使用 packed min/max 和最多 400 个 coarse marker。
- Graph frame 使用 single-flight + latest pending request，快速缩放不会把已经过期的后端请求无限排队。
- Analyzer cache 按新增 sample 增量续算；UART、I2C、SPI 的结果与一次性完整解码测试一致。

## 用户可见行为

- Demo 设备选择后仍等待 Start；Stream 持续到手动 Stop 或 buffer 满。
- 32 通道 capture 中 D0-D31 可见并持续刷新。
- 启用 analyzer 后，采集中可实时出现协议气泡；Fit Capture 气泡覆盖首尾，放大后拆成单帧气泡。
- I2C/SPI channel role 继续使用独立 track，clock marker 行为保持不变。
- Session 切换和关闭继续使用独立后端 graph state，关闭 tab 会释放对应内存。

## 验证

- `cargo test --workspace --all-features`
  - Core 17、Graph 8、File 3、Waveform 3 全部通过。
  - 覆盖 D31、增量/一次性索引一致、packed/scanner pixel 一致、UART/I2C/SPI decoder 一致、I2C/SPI role tracks、session 隔离、增量 analyzer cache、10,000 frame 聚合和固定 pixel budget。
- `pnpm build` 通过。
- Playwright/Chrome 浏览器回归：
  - 32 通道持续采集推进到 55.13M samples / 210.29 MiB，无 console error。
  - Analyzer 在 32 通道 live capture 中返回 44 个 viewport bubbles。
  - Fit Capture 覆盖约 34.5M samples 的首尾，深度放大后 multi bubble 拆成多个 frame bubbles。

## 已知差距 / 后续任务

- 当前 Rust kernel 只原生实现 UART、I2C、SPI；其余原版 LLA/HLA 需要按 analyzer plugin ABI 逐个接入。
- 数字 edge index 已减半，但极端高翻转率、4 GiB capture 仍可能占用较大内存；下一阶段可增加磁盘分块和多分辨率 edge page。
- 前端仍使用 Canvas 绘制数字通道；packed 数据契约已与 WebGL texture 管线对齐，可在需要时直接替换 renderer 而不修改后端。

## 对应 Git 提交

- `port: add native 32-channel graph pipeline`
