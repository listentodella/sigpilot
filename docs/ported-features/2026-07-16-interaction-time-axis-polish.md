# 交互与时间轴细节补齐

## 功能范围

本次集中补齐用户指出的五个和原版直觉差距较大的细节：

- 右侧栏按钮 hover 时显示原版风格功能 tooltip。
- Devices 面板数字通道启用态恢复 Saleae 通道色高亮。
- 左侧通道标签支持双击重命名、右键通道菜单。
- 波形顶部时间轴按缩放级别显示 s/ms/us/ns 主刻度和相对 offset。
- 每个时间刻度向下绘制竖直虚线，辅助观察波形边沿位置。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/PanelSwitchers.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/ChannelRow.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/DigitalChannelRow.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`

## 本地落点文件

- `src/App.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/styles.css`

## 复用方式

- 侧栏 tooltip 复用原版 `data-help-tooltip` / `data-help-tooltip-at="left"` 结构，当前用本地 CSS 自绘。
- 通道命名复用原版 `ChannelRow.name` 的状态语义，落到每个 `UiSession.channelLabels`，并同步 capture summary / tile。
- 通道颜色复用现有 Saleae MSO 色板变量 `--channel-mso-*`。
- 时间轴按原版 rendering/view-state 思路从当前 viewport 推导 tick step，使用 1/2/5 nice-step 规则、主刻度、offset 子刻度和竖直虚线。

## 用户可见行为

- 鼠标移到右侧栏按钮上会立即看到功能名和快捷键提示。
- Devices 面板里选中的数字通道有蓝/黄/绿/粉通道色，不再与背景混在一起。
- 双击左侧 D0/D1 标签可编辑名称；右键通道可 Rename、Enable/Disable、Set as Trigger、Add Analyzer。
- 放大/缩小时，波形顶部时间轴自动从秒级切到毫秒、微秒、纳秒级；主刻度之间在空间允许时显示 `+5 us` 这类 offset。
- 时间刻度会向下投射虚线，方便对齐波形边沿。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- Demo capture 后验证 16 个通道行显示正常。
- hover 右侧栏按钮，验证 `.singleSwitcher[data-help-tooltip]::before` opacity 为 `1`。
- 右键 D0，验证菜单显示 `Rename / Disable Channel / Set as Trigger / Add Analyzer`。
- 滚轮放大波形，验证顶部时间轴显示主刻度、offset 标签和竖直虚线，且标签不明显重叠。

## 已知差距 / 后续任务

- 左侧通道菜单只搬入本轮最常用动作；原版完整菜单中的高度、颜色、隐藏/分组等动作后续可继续拆。
- 时间轴当前由 canvas 前端绘制；原版更深层的 wall-clock/trigger-relative/time-zero 模式还未全部搬入。
- 右侧 tooltip 复刻了原版数据属性和视觉行为，但尚未接入完整全局 help tooltip 管线。

## 对应 Git 提交

- `polish: sidebar channels and time axis`
