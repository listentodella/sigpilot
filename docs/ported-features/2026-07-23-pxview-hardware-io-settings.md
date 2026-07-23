# PXView External Trigger And Hardware I/O Settings

## 功能范围

- Device Settings 新增 PXView 公开的 `Ext Trigger Mode`、`Using Clock Negedge` 和 `En Trigger Out`。
- External Trigger 支持 `close / Rising / One / Falling / Zero / Edge` 六种原版模式。
- 修复 Start 前将 `clock_edge` 与 `trigger_out_enabled` 强制覆写为 `false` 的问题；三项设置现在真实进入 capture register script。
- `usb_smoke` 新增对应参数，可独立验证真实硬件寄存器路径。

## 上游参考路径

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `enum pxlogic_extern_edge_modes` 定义 0..5 的 external trigger register 值。
  - `extern_trigger_matches[]` 定义 `close`、`Rising`、`One`、`Falling`、`Zero`、`Edge` 的显示顺序。
  - `config_set()` 将三项分别保存到 `ext_trig_mode`、`clock_edge`、`trig_out_en`。
  - `start_transfers()` 将 external mode 写入 `15 << 2`、Trigger Out 写入 `22 << 2`，并将 clock edge 左移 3 位合入 GPIO mode。
- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.h`
  - `hwoptions[]` 与 `sessions[]` 同时公开 `SR_CONF_EX_TRIGGER_MATCH`、`SR_CONF_CLOCK_EDGE`、`SR_CONF_TRIGGER_OUT`。
- `pxview-fork/libsigrok/hwdriver.c`
  - 原版控件名称：`Ext Trigger Mode`、`Using Clock Negedge`、`En Trigger Out`。
- `pxview-fork/PXView/pv/prop/binding/deviceoptions.cpp`
  - External Trigger 使用 list control；clock edge 与 trigger out 使用 bool control。

## 本地落点

- `crates/pxlogic-core/src/models.rs`
  - 新增 serde-compatible `ExternalTriggerMode`，显式保持 PXView 0..5 枚举值。
  - `CaptureSettings.external_trigger_mode` 使用 `Close` 作为旧请求兼容默认值。
- `crates/pxlogic-core/src/capture.rs`
  - `capture_profile_from_settings()` 将 external trigger、clock edge、trigger out 一并映射到 register profile。
  - 扩展测试，验证 `REG_EXT_TRIGGER_MODE=5`、`REG_TRIGGER_OUT_ENABLE=1` 与 GPIO negedge bit。
- `src/lib/api.ts`
  - 新增 TypeScript `ExternalTriggerMode` union 和 capture request 字段。
- `src/App.tsx`
  - `UiDeviceSettings` 保存三项独立状态。
  - `settingsFromDeviceSettings()` 不再强制关闭 hardware I/O。
  - Device Settings 新增原版名称的 select/toggle controls。
- `src-tauri/src/bin/usb_smoke.rs`
  - 新增 `--external-trigger`、`--clock-negedge`、`--trigger-out`。

## 复用方式

- 枚举顺序、显示文本、控件类型、寄存器地址与 bit packing 均直接按 PXView 上游实现搬运。
- 三项保持 PXView 的延迟应用语义：UI 修改只更新 session settings，下一次 Start 时由 capture script 写入设备。
- 不增加后台自动输出或设备选择时写寄存器，避免未捕获时意外改变外部引脚状态。

## 用户可见行为

- `Ext Trigger Mode` 默认 `close`。
- `Using Clock Negedge` 默认关闭；启用后下一次采集使用 GPIO mode 的 negedge bit。
- `En Trigger Out` 默认关闭；启用后下一次采集写入 Trigger Out enable register。
- 每个 session 独立保存这三项，创建新 session 时沿用当前 session 配置，与其他 Device Settings 行为一致。

## 验证

自动验证：

```text
cargo test --workspace
cargo check --workspace --all-targets
pnpm build
cargo fmt --all --check
git diff --check
```

浏览器 Preview：

- 1024x768 viewport、300px sidebar。
- External Trigger 下拉包含 6 项，并能保持 `Edge`。
- Clock Negedge 与 Trigger Out toggle 可独立保持选中。
- select 与 section 宽度均为 267px，无截断、溢出、console error 或 page error。
- screenshot：`debug-captures/pxview-hardware-io-settings.png`。

真实 U2 negedge smoke：

```text
cargo run -p pxlogic-desktop --bin usb_smoke -- \
  --rate 25000000 --ms 2 --channels 8 --mode buffer --clock-negedge \
  --out debug-captures/u2-8ch-25m-clock-negedge.pxcap
```

- `REG_EXT_TRIGGER_MODE (0x3c) = 0`，保持 external trigger closed。
- `REG_TRIGGER_OUT_ENABLE (0x58) = 0`，保持 Trigger Out disabled。
- 25 MHz 基础 GPIO mode `0x7` 与 negedge bit `0x8` 合并为 `REG_GPIO_MODE (0x14) = 0x0f`。
- 50,048 raw/decoded samples 完成，`unitsize=1`，artifact 已保存。

## 已知差距 / 后续任务

- 真机只安全验证了 clock negedge；External Trigger 与 Trigger Out 的 enable 状态会影响外部引脚，本轮未在未知接线下启用。
- `Ext Trigger Mode` 是设备外部触发输入配置，不替代波形通道上的 Rising/Falling/High/Low capture trigger。
- PXView 未在该路径提供 pulse-width comparator；现有 `triggerPulseWidthUs` 缺口不属于这三个 Hardware I/O 配置。

## 对应 Git 提交

- 尚未提交。
