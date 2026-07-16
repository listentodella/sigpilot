# Recording Settings 右侧栏

## 功能范围

- 按原版规则保留 Recording Settings 为 MSO / Logic Pro 路径；普通 Logic session 不再显示该入口。
- 将原先错误放在 Recording Settings 里的普通 Logic sample rate / channel count 表单移回 Devices 面板职责。
- 复刻 Recording Type 结构：Looping / Timer / Trigger。
- 复刻 Timer Settings、Trigger Settings、Single Shot、Trigger Sampling 的面板骨架和 session 状态。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/ConnectedRecordingSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/RecordingSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/RecordingTypeSelector.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/ConnectedFreeRunSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/ConnectedTimerSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/ConnectedTriggerSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/SingleShotSettings/ConnectedSingleShotSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/RecordingSettings/ConnectedTriggerSamplingSettings.tsx`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 状态规则复刻：沿用原版 `recordingSettings` 仅 MSO / 无 active session 可见的规则。
- 结构复刻：按原版 `RecordingTypeSelector`、Timer、Trigger、Single Shot、Trigger Sampling 的分区组织。
- 适配实现：本地先以 `UiDeviceSettings` 保存 MSO 录制设置；真实 MSO scope/sampling 后端待后续接入。

## 用户可见行为

- 普通 Logic demo session 的右侧栏不再显示 Recording Settings / Cursors。
- MSO-like session 会得到 Recording Settings 面板骨架，包含 Looping、Timer、Trigger、Single Shot、Trigger Sampling。
- Timer 的 sample rate / stop after ms 会继续映射到现有 capture settings。

## 验证方式

- `pnpm build`
- 浏览器 demo session 验证右侧栏可见按钮为 Device Settings、Analyzers、Measurements、Timing Markers、Extensions、Notes。

## 已知差距 / 后续任务

- 当前没有真实 MSO 后端，因此 Single Shot 和 Trigger Sampling 只保存 session 状态。
- Trigger line、analog scope trigger、manual buffer validation 还未搬入。
- 无 active session 时的原版 Recording Settings 启动页路径尚未展开，因为当前右侧栏只在 active session 后渲染。

## 对应 Git 提交

- `port: recording settings sidebar`
