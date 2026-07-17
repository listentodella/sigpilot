# Range Measurement 交互对齐

## 功能范围

- 将 Add Range Measurement 的 placing preview 改回原版交互：
  - 从顶部工具栏或右侧 Measurements `+` 进入 placing 后，鼠标所在通道先显示零宽竖条。
  - 第一次点击/拖动后才显示临时 range band。
  - 拖动释放或第二次点击完成 range。
- 将主图 range tooltip 改为原版职责：
  - 统计属性继续显示在主图弹窗内，而不是右侧栏常驻明细。
  - tooltip 顶部操作区支持拖动，位置保存到当前 range。
  - 点击其他区域隐藏 tooltip；重新点击图上的 range 时按此前拖动位置恢复显示。
- 将右侧 Measurements 列表收敛为原版 `RangeItem` 风格：
  - 只保留颜色、名称、方向箭头、`ΔT`、备注预览。
  - 行右侧只保留 Go To 和三点菜单。
  - Add/Remove Measurements、Annotation Setting、逐项测量值继续保留在主图 tooltip。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/PlacingRange.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeTooltip.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/RangeItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/styles.module.css`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- `PlacingRange`：搬运其 `mouseTimeSec` 零宽 preview 规则，本地用 `placingRangeIndicator` 表示尚未开始的竖条。
- `RangeDisplay`：搬运 selected range 点击显示 tooltip、空白区域隐藏 tooltip、range 再点击恢复的状态规则。
- `RangeTooltip`：搬运 `DIALOG_DRAG_CLASS` 对应的顶部可拖动区域；本地用 `tooltipPosition` 保存每个 range 的位置，避免隐藏/恢复后丢失。
- `RangeItem`：搬运右侧列表职责，将测量明细和 Add/Settings 操作移回 tooltip，只在侧栏保留 marker 式条目与 Go To/More。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- `cargo test -p pxlogic-waveform`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 选择 demo device 后手动 Start/Stop，确认选择设备不自动采集。
  - 点击 Add Range Measurement，移动到通道上，确认只有 `placingRangeIndicator`，没有提前生成 `rangeBand`。
  - 拖动划定 range 后，确认主图 tooltip 出现并显示真实统计属性。
  - 拖动 tooltip 顶部区域，确认位置变化并保存。
  - 点击空白处 tooltip 隐藏；点击 range band，tooltip 按保存位置恢复。
  - 右侧 Measurements 行只显示轻量条目，行内按钮只有 Go To 和 More，`rangeMeasureTable` 数量为 0。
  - 浏览器 console error 为空。

## 已知差距 / 后续任务

- 当前拖动 tooltip 使用本地 mouse/pointer 事件实现，没有引入原版 `react-draggable` 依赖。
- 原版 Popper 的 viewport overflow/tether 细节未完整搬入；本地先将 tooltip 限制在 graph viewport 内。

## 对应 Git 提交

- `port: align range measurement interactions`
