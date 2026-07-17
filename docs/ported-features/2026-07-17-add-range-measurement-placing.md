# Add Range Measurement 放置模式与 Measurements 深化

## 功能范围

- 将 Add Range Measurement 从“立即创建固定范围”改为原版式 placing 模式。
- 顶部工具栏、`Cmd/Ctrl+G`、右侧 Measurements `+` 菜单统一进入同一条 Add Range 命令链路。
- Range 绑定创建时的数字通道，图上 overlay 只覆盖对应 row。
- 支持单击起点/第二次单击终点、拖拽创建、Esc 取消、Shift 临时放置入口。
- Range 边缘拖动允许左右穿越后自动交换起止侧。
- 补齐图上 selected range tooltip：Delta T、Edges、Frequency、Duty、Width 1、Channel、备注、颜色、Copy、Delete。
- 将右侧 Measurements 列表改为更接近原版 `RangeItem` 的紧凑行：展开箭头、颜色块、名称、ΔT、备注预览、Go-to、三点菜单。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/CommandAdapter.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/commands.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/store.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/RangeItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/PlacingRange.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeEdge.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeTooltip.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/defaults.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/text/rangeMeasurements.ts`

## 本地落点文件

- `src/App.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/lib/saleaeGraphLayout.ts`
- `src/styles.css`

## 复用方式

- 状态规则复刻：对照 `AdvancedMeasurementsStore` 增加 session 级 `rangePlacement`、range selection、tooltip、expanded 字段。
- 交互结构复刻：对照 `CommandAdapter` 和 `PlacingRange` 搬入 AddRange placing、Esc cancel、Shift placing、拖拽或二次单击完成。
- 几何规则复用：新增 `saleaeGraphLayout`，让 canvas hover、右键定位、range overlay 使用同一套 row layout。
- 视觉结构复刻：对照 `RangeItem` 和 `RangeTooltip` 迁移 sidebar row、菜单动作、tooltip 指标/备注/颜色/占位按钮。
- 算法适配：指标仍在前端基于当前 loaded tile 计算，但已改为按 range 绑定通道计算。

## 用户可见行为

- 点击顶部 Add Range Measurement 或右侧 Measurements `+ -> Add Measurement` 后，不会立即创建 range，而是提示在波形上点击/拖拽。
- 在某个通道上拖拽后，该通道出现半透明 range band，右侧生成一个 `M#` item，并显示 tooltip。
- 右侧 range item 可展开/收起，显示 Channel、Edges、Frequency、Duty、Width 1。
- 三点菜单包含 Find More Measurements、Go to Range、Zoom on Range、Copy、Delete、Delete All。
- Add / Annotation Setting 入口在 tooltip 中保留为可见禁用占位，等待完整 Measurements2 extension runner 搬运。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`。
- 启动页选择 demo device，确认未自动采集。
- Start 后停止或等待 capture complete，点击顶部 Add Range Measurement，确认 `.rangeOverlay placing` 出现且 range item 数量不变。
- 录制中 Add Range Measurement / Measurements `+` 保持禁用或提示不可添加。
- 在静态 capture 中拖拽创建 range，确认右侧 item 增加、图上 `.rangeBand` 只覆盖单个 row、tooltip 出现。
- 点击右侧 Measurements `+`，确认出现 `Add Measurement / Cmd/Ctrl+G` popover；点击后进入同一 placing 状态。
- Esc 取消 placing 后，确认 overlay 回到普通状态。
- 浏览器控制台 error 为空。

## 已知差距 / 后续任务

- 完整 Measurements2 extension runner、Add/Remove metric 菜单和 annotation settings 仍是占位。
- Range measurement 的真实后端计算还未接入，当前仍基于当前 waveform tile 做前端统计。
- 原版多选/Shift 批量选择、外部点击精细 deselect、tooltip 可拖动位置持久化尚未完整搬入。

## 对应 Git 提交

- `port: add range measurement placing`
