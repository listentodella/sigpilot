# PXView startup FPGA prewarm

## 目标

参考 PXView/libsigrok 的设备打开流程，将 PXLogic FPGA prepare 从第一次捕获前移动到启动页设备枚举之后，减少用户点击 Start 时的等待。

## 搬运内容

- 启动页 `refreshDevices()` 枚举到 `Usb` 且 `ready` 的 PXLogic 设备后，后台调用现有 `prepare_device`。
- Tauri `AppState` 新增进程级 prepared 集合与 prepare mutex。
- 同一设备的启动预热、Start 和 PWM 配置共享同一条 prepare 路径：
  - 已准备时跳过 FPGA bitstream 上传。
  - 预热尚未完成时，Start 等待同一把锁，不会并发重复下载。
  - 预热失败不会写入缓存，下一次操作可以重试。
- 捕获阶段遇到真实 USB 错误时清除对应缓存，允许下一次 Start 重新执行 PXView prepare。
- 启动页状态栏显示 `preparing FPGA in background`、`FPGA ready` 或失败信息。

## 与 PXView 的边界

本轮复用的是现有 `prepare_device_with_trace`，其中包含 PXView 对应的端点清理、reset/main FPGA bitstream 上传和 100ms settle；缓存只覆盖当前进程生命周期。

MCU app firmware 版本更新仍保持显式/未自动执行。启动预热不会因为版本不一致而静默刷写 `SCI_LOGIC.bin`，只沿用现有诊断并继续 FPGA prepare。

## 验证

- `cargo fmt --all --check`
- `cargo check --workspace --all-targets`
- `pnpm build`
- `git diff --check`

真机验证时应确认：启动页出现 PXLogic 后先产生一次 FPGA prepare diagnostics；首次 Start 不再重复上传，第二次 Start 只出现 process cache reuse；拔出设备后 USB 错误会使缓存失效。
