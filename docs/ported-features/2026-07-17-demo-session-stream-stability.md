# Demo Session 与 Stream 稳定化

## 功能范围

- 启动页点击 `Try a demo Logic device` 只创建 demo session，不立即开始采集。
- Demo session 默认使用 Stream / Free Run，并采用 4096 MiB buffer，让浏览器预览可持续约 85 秒。
- 浏览器预览捕获改为约 30fps 推进 live summary，减少 100ms 跳帧感。
- Rust demo backend 支持 Stream buffer 预算，并在停止时返回 partial capture。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/SessionPlaceholder/ConnectedSessionPlaceholder.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/rapidDataStore/SessionStore.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/stripChartRender/waveform/canvas.tsx`

## 本地落点文件

- `src/components/DeviceStartScreen.tsx`
- `src/App.tsx`
- `src/lib/api.ts`
- `crates/pxlogic-core/src/models.rs`
- `crates/pxlogic-core/src/capture.rs`
- `crates/pxlogic-core/src/fake.rs`
- `crates/pxlogic-core/src/rusb_backend.rs`
- `src-tauri/src/bin/usb_smoke.rs`

## 复用方式

- 状态规则复刻：按原版 startup placeholder 的设备选择语义，设备选择只建立 session，真正采集仍由顶部 Start 触发。
- Capture mode 复刻：默认 `CaptureMode::Stream`，前端 Free Run 映射到后端 Stream。
- Live 渲染节奏参考：原版 `RenderingManager` 通过 animation frame 合批更新 frame data；PXLogic 浏览器预览将 summary 推进从 100ms 改到 33ms，使 live 视窗跟随更接近连续动画。
- 安全适配：浏览器 preview 不分配真实 4GiB sample buffer；Tauri fake backend 仍保留 64 MiB allocation cap，避免桌面 demo 因完整 `CaptureData.samples` 内存模型崩溃。

## 用户可见行为

- 启动页选择 demo 后进入空 session，底部显示 `Ready / No samples`，顶部 Start 保持可点击。
- 点击 Start 后才开始采集，底部持续显示 `Capturing`、样本数和 MiB。
- Demo session 默认 buffer 下拉框选中 `4096 MiB`。
- 浏览器 demo 在 25MHz / 16ch 下跑满 4096 MiB 约 85 秒，完成后保留长捕获。

## 验证方式

- `pnpm build`
- `cargo check --workspace`
- 浏览器访问 `http://127.0.0.1:1420/`。
- 点击 `Try a demo Logic device` 后确认未出现 `Capturing`，底部为 `Ready / No samples`。
- 打开 Device Settings，确认 Buffer size 选中 `4096 MiB`。
- 点击 Start 后观察采集持续增长；本轮实测完成于 `2147.48 MS / 4096 MiB`，页面未崩溃。

## 已知差距 / 后续任务

- 桌面 Tauri fake backend 仍需要完整 sample Vec 才能复用现有 waveform/decode 路径，因此 Stream demo 暂时 capped at 64 MiB。后续若要和原版一样长时间 demo，应把 fake capture 改成虚拟/分块数据源。
- 真实 USB backend 仍会把采集结果一次性驻留在 `current_capture`，后续需要流式文件/环形缓存，才能安全承载更大的第三方 32 通道长采集。

## 对应 Git 提交

- 待提交：`port: demo stream session stability`
