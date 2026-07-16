# Measurements 右侧栏

## 功能范围

- 将 range measurements 从计数改为 session 级对象数组。
- 复刻 Measurements 面板结构：标题 `+`、空状态、range 列表项、重命名、备注、Copy、Go to Range、Zoom on Range、Delete、Delete All。
- 在波形区增加 range band overlay，并支持拖动左右边界。
- 计算数字波形常用指标：duration、edges、frequency、duty、width 1。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/RangeItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeEdge.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/commands.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/Measurements2/Measurements2Sidebar.tsx`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 结构复刻：按原版 SidebarMenu 的 `+`、空状态、range item、菜单动作组织。
- 行为复刻：Add Range、选择、重命名、备注、复制、跳转、缩放、删除、Delete All。
- 交互适配：range band 和左右 edge 以 DOM overlay 叠加在 canvas 上，拖动时更新 sample 起止点。
- 算法适配：先基于当前 waveform tile 计算数字 range 指标。

## 用户可见行为

- 点击 Measurements 面板 `+` 会在当前 viewport 中间创建一个 range。
- 波形上出现半透明 range band，左右边界可拖动。
- 右栏 range item 显示 Duration、Edges、Frequency、Duty、Width 1。
- Go to Range / Zoom on Range 会调整 viewport；Copy 会复制该 range 的指标。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- Demo capture 后打开 `Measurements (N M)`。
- 点击 `+`，验证出现 1 个 range item 和 1 个 `.rangeBand`。
- 验证 range item 包含 Duration、Duty，并且 `Zoom on Range` 可执行。

## 已知差距 / 后续任务

- 指标目前基于当前 loaded tile；range 超出 tile 覆盖范围时不是全 capture 精确统计。
- 还未搬原版多选、Shift 拖拽放置、错误状态、完整 Measurements2 插件体系。
- Range tooltip 和图上数值标签还未搬入。

## 对应 Git 提交

- `port: measurements sidebar`
