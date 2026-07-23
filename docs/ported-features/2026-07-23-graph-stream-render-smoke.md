# USB stream to GraphSession render smoke

## 功能范围

- 为 `usb_smoke` 增加 `--graph-smoke`，覆盖真实 USB 数据到 UI 图形服务的完整增量链路。
- 每个 decoded chunk 依次进入 `GraphSession::begin_capture`、`append_samples` 和 `finish_capture`。
- 同时验证全捕获 packed waveform tile 与真实边沿附近的 exact segments。

## 上游参考路径

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - PXLogic stream read、`LA_CROSS_DATA` 数据发布与 enabled-channel sample 计数规则。
- `pxview-fork/libsigrok/hardware/pxlogic/usb_ctrl.c`
  - USB bulk transfer 和 PXLogic endpoint 控制路径。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`
  - capture revision、viewport render request 和过期 frame 淘汰边界。

## 本地落点

- `src-tauri/src/bin/usb_smoke.rs`
  - `--graph-smoke` 参数、增量 GraphSession sink、sample/tile/segment 连通性校验。
- `crates/pxlogic-graph/src/lib.rs`
  - 增加 analyzer 请求不得改变 waveform tile 的回归测试。

## 复用方式

- 数据契约复用：沿用 PXView packed raw byte 计数和 `LA_CROSS_DATA` 解交织结果。
- 图形契约复用：测试工具走与 Tauri `start_capture` 相同的 GraphSession callback 顺序。
- 边沿验证：exact segment 的前一段终点必须等于后一段起点，且电平必须翻转。

## 用户可见行为

- 真机采集进入 UI 前可以独立验证 USB、解交织、图索引和 waveform tile，不再只能通过截图猜测故障层级。
- 若边沿在 Rust 图形层已经断开，smoke 命令会直接失败并报告通道与 sample。

## 验证

```text
cargo run -p pxlogic-desktop --bin usb_smoke -- \
  --mode stream --rate 50000000 --channels 4 --buffer-mb 1 \
  --graph-smoke \
  --out debug-captures/usb-smoke-u2-4ch-stream-50m-graph-cross.pxcap
```

- U2 真机读取 524,288 raw bytes，解码为 1,048,576 sample bytes。
- GraphSession 收到 2 个 chunk，索引 1,048,576 samples，与 capture metadata 完全一致。
- D0 首个边沿位于 sample 64；exact tile 返回 3 个连续 segments，边沿闭合。
- 全捕获 tile 返回 4 个通道和 1,200 pixels 的非空 packed bins。

## 已知差距 / 后续任务

- 当前 smoke 重点验证数字波形；协议 bubble 的视觉布局仍由浏览器回归覆盖。
- 静态输入没有边沿时会跳过 segment transition 检查，但仍校验 sample count 与 packed tile。

## 对应 Git 提交

- 尚未提交。
