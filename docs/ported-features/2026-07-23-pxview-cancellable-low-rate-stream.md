# PXView cancellable low-rate USB stream

## 功能范围

- 修复 Tauri Stop 另开 USB handle、重复 claim interface 导致 `Busy` 的问题。
- 活动 capture handle 使用 250ms bulk poll 检查共享取消标志，并由同一 handle 写停止寄存器。
- 移除固定 1 秒、连续 5 次 timeout 即失败的规则，按 PXView block size 和原始数据率计算 stall deadline。
- Trigger capture 不设置空闲 deadline，允许一直等待边沿直到用户手动停止。

## 上游参考路径

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `start_transfers()` 将 libusb transfer timeout 固定为 `0`。
  - `abort_acquisition()` 对当前 device handle 上已提交的 transfer 调用 `libusb_cancel_transfer()`。
  - 低采样率仍使用按通道 4 KiB 对齐的 block，2 kHz / 32ch block 为 128 KiB。
- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.h`
  - active transfer 数组和 submitted transfer 生命周期。

## 本地落点

- `crates/pxlogic-core/src/rusb_backend.rs`
  - 250ms cancellable read poll。
  - 自适应 `capture_stall_timeout()`。
  - 移除会抢占 interface 的 `RusbBackend::stop_capture()` override。
  - 新增低速 deadline 和 trigger indefinite wait 单元测试。
- `src-tauri/src/main.rs`
  - `cancel_capture` 只设置 active capture 共享原子标志并发送诊断事件，不再创建第二 USB handle。

## 复用方式

- 取消语义复用：与 PXView 一样只取消当前 capture handle 的活动传输。
- 等待语义复用：PXView 使用 timeout 0；同步 `rusb` 无公开 async cancel API，因此用短 poll 保留可取消性，并把“设备失联”deadline 与 poll timeout 分离。
- block 预算复用：stall 至少覆盖两倍 `transfer_size * 8 / (sample_rate * channels)`，再增加 5 秒余量，限制在 5 到 60 秒。

## 用户可见行为

- 点击 Stop 后不再出现 `Resource busy`，最迟约一个 250ms poll 周期进入停止收尾。
- 已收到数据时保存 partial capture，旧波形和 GraphSession 索引均可继续使用。
- 低采样率不会因为一个 PXView block 超过 5 秒才填满而误报 USB timeout。
- Trigger 模式可以长时间等待触发，Stop 仍可立即取消。

## 验证

- `cargo test -p pxlogic-core`：28 项通过。
- `cargo check -p pxlogic-desktop --bins` 通过。
- U2 32ch / 5 MHz / 64 MiB stream，启动后 2 秒取消：
  - 活动读取完成 23 个 transfer、6,029,312 raw bytes。
  - 返回 1,507,328 samples 的 partial capture。
  - GraphSession sample count 一致，exact edge 连通性通过。
- U2 32ch / 2 kHz stream，启动后 7 秒取消：
  - transfer size 为 131,072 bytes，自适应 stall deadline 为 37.8 秒。
  - 5.5 秒无数据时继续等待并输出 control status，没有误报 timeout。
  - 7 秒时由共享取消标志正常结束。

## 已知差距 / 后续任务

- `rusb` 0.9 没有公开异步 transfer cancellation API；250ms poll 是同步接口下的兼容实现，理论最坏 Stop 延迟约 250ms 加一次停止寄存器写入。
- 无数据时取消不会生成空 capture 文件，调用方会收到 `Cancelled`；已有 partial data 时正常返回 capture。

## 对应 Git 提交

- 尚未提交。
