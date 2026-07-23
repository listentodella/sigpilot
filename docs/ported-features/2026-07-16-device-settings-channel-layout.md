# Device Settings 通道显示与布局

## 功能范围

- 为第三方 32 通道逻辑分析仪保留 Saleae legacy 8 色循环规则。
- Device Settings 的数字通道按钮在捕获完成后可真实显示或隐藏对应标签与波形。
- 为每个 session 保存独立的逐通道高度、手动布局状态和波形纵向滚动位置。
- 搬运 RowV2 行间拖动手柄：鼠标位于两个通道交界处时显示高亮线，可拖动修改上一通道高度。
- 通道总高度超过窗口时，波形区显示独立的纵向滚动条。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/themes/builtin.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/themes/colorHelpers.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/ChannelPicker.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/captureSettingsMenu/channelSettings/BaseChannelSettings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowV2.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowV2.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/useRow.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/useResize.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/Row.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/RowsManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/defaults.ts`

## 本地落点文件

- `src/App.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/lib/saleaeChannelLayout.ts`
- `src/styles.css`

## 复用方式

- 直接复用原版 legacy 通道规则：`deviceChannel % 8`，32 通道按相同 8 色循环。
- 状态规则搬运：通道 active 状态决定 row 是否进入 visible rows；重新启用后恢复原通道号、颜色、名称和高度。
- 算法搬运：数字通道自动布局使用原版 28px 最小高度、200px/窗口 50% 自动高度上限、100px 默认持久高度。
- 结构与样式搬运：RowV2 使用 4px 行间距；resize handle 覆盖整行宽度，默认透明，hover 时使用 60% 白色高亮并显示 `row-resize` 光标。
- 滚动规则搬运：GraphRows 自身作为 `overflow-y: auto` 的滚动容器，标签、Canvas、hover 测量和边沿跳转共用同一套逐行几何。

## 用户可见行为

- D0-D7 使用原版 8 色，D8-D15、D16-D23、D24-D31 依次循环。
- 在 Device Settings 点击已启用通道，会立即从当前捕获结果中移除该通道标签和波形；再次点击可恢复。
- 点击 `All` 会启用 32 个数字通道；点击 `Clear` 会隐藏并禁用全部数字通道。
- 通道较少时自动填充可用高度；32 通道或手动增高后，波形区出现纵向滚动条。
- 拖动通道交界线只改变目标通道高度，不会让其他自动适配通道突然恢复到 100px。
- 纵向滚动后，hover 测量与 Previous/Next Edge 按钮仍跟随正确通道。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`，载入 Demo capture。
- 打开 Device Settings，确认有 32 个 channel picker button。
- 隐藏 D3 后，波形行从 16 变为 15；恢复后回到 16。
- 点击 `All` 并重新捕获，确认显示 32 行、31 个行间 resize handle，颜色唯一值为 8 个。
- 1440x900 视口下，32 通道的 `scrollHeight` 大于 `clientHeight`，纵向滚动生效。
- 将第一条 28px 通道向下拖动 72px 后，第一条变为 100px，其他通道保持 28px。
- 浏览器控制台与页面运行错误均为空。

## 已知差距 / 后续任务

- 稀疏物理通道采集已在 `2026-07-23-pxview-sparse-channel-capture.md` 完成，Device Settings 的选择会写入真实 32 位 channel mask。
- 设备通道容量与 channel mode 已在 `2026-07-22-pxview-capabilities-ui.md` 完成，按钮数量来自真实 hardware capabilities。
- 原版 `isMarkedHidden` 与 `activeDesired` 是两层状态；当前 Device Settings 按钮将“显示/隐藏”和“下次采集启用/禁用”合并处理。
- 原版通道右键菜单中的 `Reset Y-height`、`Resize All Channels to Match` 尚未搬运。

## 对应 Git 提交

- `port: device settings channel layout`
