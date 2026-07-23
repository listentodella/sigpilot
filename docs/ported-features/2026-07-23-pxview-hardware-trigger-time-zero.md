# PXView Hardware Trigger And Time Zero

## 功能范围

- 将 PXLogic 控制状态中的真实硬件触发位置带入 capture metadata、GraphSession、`.pxcap` 和前端 session。
- Trigger capture 的预触发位置由 UI 的 Pre/Post Trigger 比例控制，不再固定写入 64 samples。
- 时间标尺以真实触发 sample 为 `0 s`，并在标尺与波形区显示 Logic 2 风格黄色 `T` 标记和虚线。
- 裁剪捕获时同步平移触发 sample；触发点被裁掉时清除 trigger metadata。

## 上游参考路径

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `start_transfers()` 使用通道模式的硬件深度计算 trigger position。
  - Stream 模式将预触发上限限制为每通道深度的 10%，Buffer 模式限制为 90%。
  - `receive_trigger_pos()` 检查 `trig_out_validset`，并将 `real_pos` 发布为 `SR_DF_TRIGGER`。
- `pxview-fork/PXView/pv/sigsession.cpp`
  - 逻辑模式直接将 `real_pos` 作为 sample index，不乘 unitsize 或通道数。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/triggers/compositions/TriggerMarkers.tsx`
  - `TriggerMarkerRender` 的 `T` 标签、三角箭头和 graph marker 结构。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/triggers/compositions/styles.module.css`
  - Trigger marker 尺寸、层级和 `yellow2 = hsl(55, 100%, 73%)`。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/ConnectedTimingDisplay.tsx`
  - 时间标尺与 graph viewport 的横向映射关系。

## 本地落点

- `crates/pxlogic-core/src/models.rs`
  - 新增 `CaptureTriggerMetadata`、`CaptureMetadata.trigger` 和 `CaptureSettings.trigger_position_percent`。
- `crates/pxlogic-core/src/capture.rs`
  - 按 PXView 10%/90% 规则和硬件深度计算 trigger position，并从控制状态生成真实触发 metadata。
- `crates/pxlogic-core/src/rusb_backend.rs`
  - 轮询 `trig_out_validset`，首次有效时发布 trigger callback。
  - Stream 有数据时以 50 ms 节流继续读取控制状态；手动 Stop 在清除硬件状态前执行最终读取。
- `crates/pxlogic-core/src/pxview_profile.rs`
  - 暴露 channel mode 的每通道硬件深度，用于 trigger position 限幅。
- `crates/pxlogic-graph/src/lib.rs`
  - 实时接收 trigger metadata，并在增量捕获完成后保留最终值。
- `crates/pxlogic-file/src/lib.rs`
  - `.pxcap` trigger metadata round trip；旧文件缺少字段时兼容为 `None`。
- `src-tauri/src/main.rs`
  - 将真实触发发布为 `capture_triggered` Tauri event。
- `src/components/CaptureTriggerMarker.tsx`
  - 波形区黄色虚线。
- `src/components/TimingDisplayCanvas.tsx`
  - 时间原点偏移、标尺 `T` 标签和三角箭头。
- `src/App.tsx`
  - session trigger 状态、实时事件、完成捕获和 trim 语义。
- `src-tauri/src/bin/usb_smoke.rs`
  - `--graph-smoke` 校验 GraphSession 最终 trigger metadata 与 capture 完全一致。

## 行为约束

- `real_pos` 是解码后的逻辑 sample index；不能按 active channel count、unitsize 或 cross-data stripe 再换算。
- 硬件触发事件每次捕获只发布一次。
- Stream trigger 不能只依赖 bulk endpoint idle timeout；快速触发后数据可能连续到达，仍需独立轮询控制状态。
- 手动 Stop 必须先读取 `trig_out_validset`/`real_pos`，再写 `STREAM_STOP_FLAGS`，否则硬件会清除尚未发布的触发位置。
- 标尺和波形 overlay 使用同一个 viewport 映射；标尺额外补偿 Row V2 左侧 8px gutter。
- 没有真实触发、FreeRun 捕获和旧 `.pxcap` 不显示 `T` 标记，时间轴继续以 capture start 为原点。

## 验证

```text
cargo test --workspace
cargo check -p pxlogic-desktop --bins
pnpm build
cargo fmt --check
git diff --check
```

浏览器 Demo Trigger 回归：

- 100 MHz、32 channels、256 MiB、Trigger 模式完成捕获。
- `.captureTriggerTimingMarker` 与 `.captureTriggerGraphLine` 均存在。
- 两个 marker 的左边界均为 `x=872.5 px`，时间标尺 `0 s` 与虚线重合。
- 32 通道波形完整渲染，无 console/page error。

真实 U2 回归：

```text
cargo run -p pxlogic-desktop --bin usb_smoke -- \
  --trigger-channel 0 --trigger rising --cancel-after-ms 5000 --graph-smoke
```

- 设备：`PX-Logic U2 channel 32`，25 MHz，16 channels，Buffer mode。
- 请求 trigger position 50%，寄存器写入 125,024 pre-trigger samples。
- 控制状态返回 `trig_out_validset=0x00000001`、`real_pos=191644`。
- Trigger callback 和 GraphSession 最终 metadata 均记录 `D0 Rising at sample 191644`。
- 最终捕获 250,048 samples，GraphSession sample count 和 packed waveform smoke 全部通过。

真实 U2 Stream + Stop 回归：

```text
cargo run -p pxlogic-desktop --bin usb_smoke -- \
  --mode stream --rate 10000000 --channels 8 --buffer-mb 64 \
  --trigger-channel 0 --trigger rising --cancel-after-ms 1500 --graph-smoke
```

- D0 上升沿触发于 sample 26,942，1.5 秒主动取消后得到 524,288 samples。
- `graph trigger: D0 Rising at sample 26942`，证明 partial capture 完成后 trigger metadata 未丢失。
- D2 High 快速触发回归在启动状态读到 `real_pos=63`，主动取消后 GraphSession 仍保留 sample 63。

## 已知差距 / 后续任务

- 当前仅搬运 PXView simple trigger 的 Rising/Falling/High/Low；pulse-width comparator 仍未从上游寄存器路径中定位。
- 浏览器 preview 在开始 capture 时即可确定模拟触发点；真实硬件只在 `trig_out_validset` 生效后显示触发事件。
- 本轮未新增多级 trigger 或 protocol trigger，这些需要独立确认硬件能力和 PXView 数据契约。

## 对应 Git 提交

- 尚未提交。
