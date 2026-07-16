# 通道待采集占位、局部高度拖拽与原版网格色

## 功能范围

- 将通道高度调整的鼠标命中范围限制在左侧通道标签栏，波形区的行间隙继续用于平移波形。
- 捕获完成后启用本次未采集的通道时，立即创建空通道行，不必等到下一次捕获才显示。
- 时间标尺和波形区竖直虚线改用 Logic 2.4.43 暗色主题的原始 GridLines 色值。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowV2.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowV2.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channels/ChannelsStore.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/RowsManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GridLines.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/TimingDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/themes/colorHelpers.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/themes/builtin.ts`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`
- `src/components/TimingDisplayCanvas.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/lib/saleaeTimingDisplay.ts`

## 复用方式

- 状态规则搬运：参考原版 `ChannelsStore` 将“用户希望启用”和“当前是否已有数据”分开处理，并参考 `RowsManager` 为可用通道保留行对象。PXLogic 的可见通道上限现在同时考虑捕获元数据、下次捕获设置和最高启用通道。
- 空数据表现搬运：`tileForVisibleChannels` 按当前启用通道顺序组装画布行；捕获 tile 中不存在的通道会得到空 `bins/segments/edges`，因此只显示标签和空行，不伪造高低电平。
- RowV2 几何复用：继续使用原版 4px 行间距、4px 容器 padding 和通道标签宽度；根据原版应用的实际操作范围，将 resize handle 限制在标签栏，并取消向波形区扩张的额外命中区域。
- 色彩直接搬运：原版 `GridLines` 调用 `useGridlineColors()`，后者分别取 DarkTheme 的 `border-10` 和 `border-20`。本地使用相同的 `#303136` primary 与 `#57575E` secondary，并让时间标尺和波形 Canvas 共用这两个常量。

## 用户可见行为

- 鼠标位于左侧两个通道标签之间时可以调整前一行高度。
- 鼠标位于相同 y 坐标的波形区时仍然抓取画布进行水平平移，不再误触高度调整。
- 例如仅捕获 D0-D2 后启用 D3，D3 标签和空白波形行立即出现，明确表示它已准备参与下一次捕获。
- 空通道行仍属于 session 的正常行状态，可以立即重命名并保留显示名称。
- major/minor 时间虚线采用原版暗色主题色，层级更清楚且不再过暗。

## 验证方式

- `pnpm build`
- 浏览器以 D0-D2 完成一次 Demo 捕获，再在 Device Settings 中启用 D3：通道行数量立即从 3 增加到 4。
- Canvas 像素检查：D2 行检测到 1698 个对应通道色像素，新增 D3 空行检测到 0 个对应通道色像素。
- 将空 D3 行重命名为 `Awaiting D3` 后，四行标签立即显示为 `D0 / D1 / D2 / Awaiting D3`。
- 命中检查：resize handle 为 `x=4, width=184`，波形起点为 `x=192`；左栏交界点命中 `channelResizeHandle`，波形区同一高度命中 `waveform-canvas`。
- GridLines 像素检查：时间标尺和波形 Canvas 均实际绘制了 `#303136` 与 `#57575E`。

## 已知差距 / 后续任务

- 当前后端捕获接口仍用连续 `channel_count` 表达启用范围。接入第三方 32 通道硬件时应升级为 32 位 channel mask，才能支持非连续通道的真实采集；本次 UI 行状态已允许非连续显示。
- 当前同一个 Device Settings 开关同时控制波形显示和下次捕获启用。原版内部模型已将 `activeDesired`、`ready`、row hidden 等状态进一步分层，后续可在通道右键菜单搬运时继续拆分。

## 对应 Git 提交

- `port: channel arming rows and gridline colors`
