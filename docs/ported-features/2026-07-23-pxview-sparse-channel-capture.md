# PXView Sparse Physical Channel Capture

## 功能范围

- Device Settings 的每个数字通道开关现在参与真实硬件配置，不再只隐藏前端波形。
- D0+D4 这类稀疏选择写入 `ch_en=0x00000011`，硬件 channel count 写 2，USB cross stripe 也只包含两条 lane。
- 解交织后仍使用物理位 D0 与 D4，不会把第二条 raw lane 错当成 D1。
- enabled channel 列表贯穿实时 GraphSession、完成捕获、`.pxcap`、重新打开捕获和浏览器 preview。
- trigger channel 必须属于 enabled channel；关闭当前 trigger channel 时 UI 自动选择下一条可用通道。

## 上游参考路径

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `en_ch_num_mask()` 遍历物理 probe index 生成 32 位启用 mask。
  - `en_ch_num()` 单独统计启用数量。
  - `start_transfers()` 使用 enabled count 计算 block size、`limit_samples2Byte` 与 USB transfer 大小。
  - `start_transfers()` 将 enabled count 写入 `8192 + (19 << 2)`，将物理 mask 写入 `4 << 2`。
- `pxview-fork/PXView/pv/data/logicsnapshot.cpp`
  - `LogicSnapshot::first_payload()` 只为 enabled probes 建立 channel storage，同时以 `_ch_index` 保留物理 probe index。
  - `LogicSnapshot::append_cross_payload()` 按 `_channel_num * 8` 消费每个 64-sample stripe；raw lane 顺序与 enabled probes 的物理升序一致。

## 数据契约

- `channel_count`：捕获中最高物理通道所需的显示跨度，例如 D0+D4 为 5；它决定 sample word 的 `unitsize` 和 Graph 可寻址范围。
- `enabled_channels`：真实启用的物理通道列表，例如 `[0, 4]`。
- `enabled_channel_count`：`enabled_channels.len()`；它决定 PXLogic channel-count register、USB transfer size、raw byte budget 和 cross stripe 宽度。
- `enabled_channel_mask`：由物理编号生成的寄存器 mask，例如 `[0, 4] -> 0x11`。

这四个值不能互相替代。尤其不能把 enabled count 2 用作 Graph 的通道跨度，否则 D4 会被重编号为 D1。

## 本地落点

- `crates/pxlogic-core/src/models.rs`
  - `CaptureSettings` 与 `CaptureMetadata` 新增向后兼容的 `enabled_channels`。
- `crates/pxlogic-core/src/capture.rs`
  - 新增 enabled list 校验、排序与 mask 生成。
  - 新增 sparse register script 和 raw-lane-to-physical-bit cross decoder。
  - Demo generator 对 disabled channels 输出静态低电平。
- `crates/pxlogic-core/src/rusb_backend.rs`
  - transfer、DDR byte budget、progress、trigger depth 和 stripe tail 全部使用 enabled count。
  - decoded output 与 Graph callback 使用物理通道跨度和物理 bit。
- `crates/pxlogic-graph/src/lib.rs`
  - 校验 enabled list，并保证 stream 开始/结束 metadata 的 channel layout 一致。
- `crates/pxlogic-file/src/lib.rs`
  - `.pxcap` 保存 enabled list；旧文件缺少字段时恢复为连续 D0..Dn。
- `src/App.tsx`、`src/lib/api.ts`
  - Device Settings 生成 enabled list；live/open capture 按 metadata 恢复通道开关；全通道关闭时阻止 Start。
- `src-tauri/src/bin/usb_smoke.rs`
  - 新增 `--enabled-channels 0,4`，并校验 metadata、Graph channel list 与 sample word mask。

## 验证

自动验证：

```text
cargo test --workspace
cargo check --workspace --all-targets
pnpm build
cargo fmt --check
git diff --check
```

- Rust workspace：51 tests passed。
- 前端 TypeScript 与 Vite production build 通过。
- 单元测试覆盖重复/越界通道、disabled trigger、`mask=0x11`、两条 raw lane 到 D0/D4 的物理位映射，以及旧 `.pxcap` 兼容。

真实 U2 Buffer：

```text
cargo run -p pxlogic-desktop --bin usb_smoke -- \
  --rate 25000000 --ms 10 --channels 5 --enabled-channels 0,4 \
  --mode buffer --graph-smoke
```

- 设备：`PX-Logic U2 channel 32`，USB High Speed。
- profile：`Use 8 Channels (Max 1000MHz)`；物理跨度 5，enabled lanes 2。
- register：`0x0000204c = 2`，`0x00000010 = 0x00000011`。
- 250,048 samples；62,512 raw bytes；250,048 decoded bytes；`unitsize=1`。
- Graph frame 仅请求 D0/D4；exact edge 连续性和 disabled-bit mask 检查通过。
- artifact：`debug-captures/sparse-d0-d4-span5-buffer.pxcap`。

真实 U2 Stream + Stop：

```text
cargo run -p pxlogic-desktop --bin usb_smoke -- \
  --rate 2000000 --channels 16 --enabled-channels 0,4 --mode stream \
  --buffer-mb 16 --cancel-after-ms 1500 --graph-smoke
```

- transfer size 8,192 bytes，23 个 decoded chunks。
- Stop 后保留 753,664 samples；188,416 raw bytes转换为 1,507,328 physical sample-word bytes。
- Graph sample count、D0/D4 channel list、packed tile 和 exact edge 连续性全部通过。
- artifact：`debug-captures/sparse-d0-d4-stream.pxcap`。

## 兼容规则

- 旧调用未提供 `enabled_channels` 时，按连续 D0..D(`channel_count - 1`) 解释。
- 新 UI 不允许以空 enabled list 启动采集，保持 PXView 的“No channels enabled”约束。
- `.pxcap` 仍保存物理跨度内的完整 labels；UI 依据 enabled list 隐藏未采集通道。
- `--compare-mappings` 是全通道 raw-cross 诊断工具，稀疏捕获会明确拒绝该模式。

## 对应 Git 提交

- 尚未提交。
