# Devices 右侧栏设置面板

## 功能范围

- 将 Devices 面板从简单设备列表升级为 Saleae 风格 Device Settings 面板。
- 增加设备标题、Device Information、Digital 通道选择、采样率、Active channels、Digital threshold。
- 增加 Capture Mode 区：Looping、Timer、Trigger，以及 Timer 时长、Trigger channel/type/pulse width。
- 增加 Trim after capture、Glitch filter、Buffer size、Connected Devices 和捕获中禁用遮罩。
- 采样率、通道数、时长、阈值会影响下一次 capture；其他设置先按 session 保存，为后续硬件后端接入预留状态。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/ConnectedDeviceSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/CaptureSettingsMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/channelSettings/BaseChannelSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/channelSettings/SampleRateSelector.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/CaptureModeSelector.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/digitalTriggerSettings/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/TrimAfterCapture.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/GlitchFilter.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/BufferSizeSetter.tsx`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 结构复刻：按原版 DeviceSettingsMenu 的设备标题、Digital、Capture Mode、Trigger、Trim/Glitch/Buffer 分区组织。
- 状态规则复刻：捕获中显示禁用遮罩；设置按 session 保存。
- 视觉复刻：复用当前 Saleae 主题变量、4px 控件半径、紧凑侧栏密度和通道颜色。
- 适配实现：第三方硬件先映射为普通 Logic 类设备；MSO 专属 smart cable/scope 设置后续单独搬。

## 用户可见行为

- 打开 Devices 右栏后可查看设备信息和当前连接/模拟设备。
- 可通过通道按钮或 Active channels 改变下一次 capture 的通道规模。
- 可调整 sample rate、duration、threshold，并在下一次 capture 生效。
- Trigger/Glitch/Trim/Buffer 会保持在当前 session 内，切换 session 不串状态。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- 点击 `Try a demo Logic device` 后打开 `Device Settings (N D)`。
- 验证 Devices 面板包含 Digital、Capture Mode、Trim after capture、Glitch filter、Buffer size。
- 将 Active channels 改为 `8 digital` 后重新 capture，波形通道标签数量变为 8。

## 已知差距 / 后续任务

- Trigger、Trim after capture、Glitch filter、Buffer size 目前是前端 session 状态，尚未写入真实硬件 capture 后端。
- 通道选择后端暂以最高启用通道映射为 `channel_count`，还不支持原版任意稀疏通道集合。
- Device Information 先以内联信息区展示；原版独立 dialog 后续可继续搬。
- MSO / Logic Pro 的 Recording Settings、scope channel、smart cable 设置不在本目标内。

## 对应 Git 提交

- `port: devices sidebar settings`
