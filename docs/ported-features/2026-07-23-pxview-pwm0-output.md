# PXView PWM0 Hardware Output

## 功能范围

- Device Settings 新增 PXLogic PWM0 硬件输出配置：Enable、Frequency、Duty 与 Apply。
- 搬运 PXView 125 MHz PWM clock、整数 period/high tick 量化和寄存器写入顺序。
- Tauri `configure_pwm` 在真实设备上自动执行现有 FPGA prepare，再配置 PWM0；捕获期间拒绝配置以避免 USB 接口争用。
- 浏览器 Preview 与真实后端返回同一套 effective frequency/duty，UI 显示量化后的实际值。
- `usb_smoke` 新增独立 PWM 配置模式，可不启动 capture 完成真机验证。

## 上游参考路径

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.h`
  - `PWM_CLK = 125000000`。
  - `hwoptions[]` 与 `sessions[]` 公开 `SR_CONF_PWM0_FREQ`、`SR_CONF_PWM0_DUTY`、`SR_CONF_PWM0_EN`。
  - PWM1 项在两个公开列表中均被注释，因此本轮不开放第二路。
- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - 默认 PWM0 为 disabled、1 kHz、50%。
  - frequency 使用 `PWM_CLK / requested_frequency` 截断为整数 period ticks。
  - duty 使用 `period_ticks * duty / 100` 截断为整数 high ticks。
  - 更新 frequency/duty 时先写 enable=0，再写 period-1、high-1，最后恢复 enable。
- `pxview-fork/PXView/pv/prop/binding/deviceoptions.cpp`
  - PWM frequency 控件上限 1,000,000 Hz、步进 1 Hz。
  - duty 范围 0..100%、步进 1%。

## 本地落点

- `crates/pxlogic-core/src/models.rs`
  - 新增 `PwmSettings` 和包含 requested/effective 值及 tick 数的 `PwmConfiguration`。
- `crates/pxlogic-core/src/protocol.rs`
  - 新增 PWM0 enable/period/high register、125 MHz clock 和 1 MHz UI 上限。
- `crates/pxlogic-core/src/capture.rs`
  - 新增 `build_pxview_pwm0_register_script()`，输出有效配置和四次寄存器写入。
  - 新增默认、enable、0% 与非法输入测试。
- `crates/pxlogic-core/src/rusb_backend.rs`
  - 新增 `configure_pwm0_with_trace()`，复用 register ACK、clear-halt 与一次重试路径。
- `src-tauri/src/main.rs`
  - 新增 `configure_pwm` 命令；捕获中拒绝，真实设备自动 prepare，Demo 只执行量化。
- `src/lib/api.ts`
  - 新增 PWM 类型、Tauri API 与浏览器 Preview 量化实现。
- `src/App.tsx`、`src/styles.css`
  - Device Settings 新增 PWM0 block、显式 Apply 和 effective value。
- `src-tauri/src/bin/usb_smoke.rs`
  - 新增 `--pwm-frequency`、`--pwm-duty`、`--pwm-enable` 与 `--pwm-only`。

## 复用方式

- 寄存器地址、clock、默认值、量化公式和 disable/program/restore 顺序直接搬运 PXView。
- PWM0 的配置使用已有 USB register transport，不另建硬件协议。
- PXView frequency 控件声明最小值 0，但其 C 路径会执行除零；本项目将最小值收紧为 1 Hz，其余公开范围保持一致。
- 0% duty 保留上游 unsigned `high_ticks - 1` 语义，写入 `0xffffffff`；100% 写入 `period_ticks - 1`。

## 用户可见行为

- PWM0 默认关闭，选择 Demo/真实设备不会自行输出波形。
- 用户修改值后必须点击 Apply；配置期间按钮显示 `Applying...`。
- 成功后显示 FPGA 实际可实现的 effective frequency 与 duty，session status 同步显示结果。
- 切换设备会清空旧设备的 effective value，不会把状态误认为已写入新设备。

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

- 1440x900 viewport、300px 最小侧栏。
- PWM grid 左右边界为 1110..1377px，两个 input 各 129.5px，均未越界或重叠。
- Apply 后显示 `Effective 1 kHz / 50%`。
- 无 console error 或 page error。
- screenshot：`debug-captures/pxview-pwm0-device-settings.png`。

真实 U2 disabled smoke：

```text
cargo run -p pxlogic-desktop --bin usb_smoke -- \
  --pwm-frequency 1000 --pwm-duty 50 --pwm-only
```

- 设备：`PX-Logic U2 channel 32`，USB High Speed，firmware `0x56900027`。
- FPGA prepare 首次 main upload timeout 后按既有重试路径成功。
- register ACK：`0x40=0`、`0x44=0x0001e847`、`0x48=0x0000f423`、`0x40=0`。
- effective：1,000 Hz、50%，period 125,000 ticks、high 62,500 ticks。
- 最终 enable 保持 0，命令未开始 capture，也未驱动 PWM 波形。

## 已知差距 / 后续任务

- PXView 底层保留 PWM1 register path，但官方 `hwoptions[]`/`sessions[]` 未公开；本项目同样不展示 PWM1。
- 本轮只通过 register ACK 验证 disabled 配置。真正 enable 后的输出频率和 duty 应在用户接好安全测试负载后，用示波器或另一逻辑通道单独验证。
- PWM 配置目前按 session 保存于运行时 UI，不写入 `.pxcap`；PXView 将其视为 device/session option，而非捕获数据。

## 对应 Git 提交

- 尚未提交。
