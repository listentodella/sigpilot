# Timing Markers 完整交互搬运

## 功能范围

- 顶部 `Add Timing Markers` 与右侧 Timing Markers `+` 共用同一套 Pair / Single placement 状态。
- 搬运原版 temp manager 放置流程：标记跟随鼠标、数字边沿吸附、pair 两次点击提交、跨越第一端时自动交换左右语义、`Esc` 取消。
- 时间标尺空白处可直接添加 Single Marker，行为与原版 `GraphMarkers/index.tsx` 一致。
- 图上 marker 支持选择、多选、拖动、hover summary、可拖动 Edit Popup、注释、颜色和删除。
- 图上右键菜单与右侧列表菜单提供 Edit、Go to、Zoom、Ungroup、Create Pair、Delete、Delete All 等原版动作入口。
- 右侧列表支持 Pair 折叠/展开、平滑 Go to / Zoom、comment 气泡和原版时间/频率格式。
- 搬运快捷键：`Cmd/Ctrl+T`、`Shift+Cmd/Ctrl+T`、`Backspace/Delete`、`M D`、`Cmd/Ctrl+A`、`N T`。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/AddMarkerMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/BaseManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/MarkerManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/PairManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/Store.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/hooks.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/menuActions.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/MarkersOutsideClickAdapter.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/GraphMarkers/*`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/sidebar/*`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/shared/utils/getLabelForTime.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/shared/utils/getLimitedValueLabel.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/shortcuts/keyBindings.ts`

## 本地落点文件

- `src/App.tsx`
- `src/components/LogicToolbar.tsx`
- `src/components/SaleaeIcon.tsx`
- `src/components/timingMarkers/TimingMarkers.tsx`
- `src/lib/timingMarkers.ts`
- `src/styles.css`

## 复用方式

- 状态规则搬运：沿用原版 marker / pair manager 的 id、label、颜色轮换、选择、Pair 排序、展开和 note 语义。
- 事件流程搬运：沿用 `useHandleTempMarker` 的初始鼠标位置、document 级移动/提交思想，以及 `MARKER_MOVEMENT_THRESHOLD_PX = 5`。
- 几何与视觉常量搬运：沿用 30px timing display、17px marker head、16px pair head、250px edit popup、原版 markerColors 和 line/label opacity。
- 算法搬运：沿用 `getLabelForTime` / `getLimitedValueLabel` 的 1ns 分辨率时间显示和两位频率显示。
- 结构搬运：Graph Marker、Summary Popup、Edit Popup、Sidebar BaseItem、PairItem、Note 和 menuActions 以当前 React session 状态承载，没有引入原版 MobX/uikit 依赖树。

## 用户可见行为

- 点击顶部或右侧 Add Marker Pair 后，临时竖线立即出现在当前鼠标横坐标或图表中心；两次点击后保存 Pair。
- 第二端越过第一端时，左侧始终保持 A、右侧始终保持 B，摘要只跟随当前移动端。
- 点击时间标尺空白区域可直接添加 `Tn`；点击 marker head 打开可拖动编辑框。
- Pair 在右侧显示为 `Pn` 和 `Δ... (...)`，展开后显示 `n-A`、`n-B`，格式和顺序与原版一致。
- 右键图上 marker 或右侧 item 可打开动作菜单；双击图上 marker 打开 Timing Markers 面板。
- `Esc` 取消放置或清除选择，`Backspace/Delete` 与 `M D` 删除已选，`Cmd/Ctrl+A` 在已有选择时全选 Timing Markers。

## 验证方式

- `pnpm build` 通过，包含完整 `tsc` 与 Vite production build。
- `git diff --check` 通过。
- 浏览器 `http://127.0.0.1:1420/` 实测：
  - Demo device 仅创建 session，点击 Start 后才开始采集。
  - 顶部 Pair 与右侧 Single 均完成 placement / commit。
  - Pair 第二端跨越第一端后 DOM 左右类型仍为 `left` / `right`。
  - 时间标尺直接创建 Single Marker。
  - Edit Popup 注释同步到右侧 Note 气泡，弹窗可拖动且点击外部隐藏。
  - Pair 折叠/展开、Go to、Zoom、右键菜单、Delete、Delete All 正常。
  - `Cmd+A` + `Backspace`、`M D`、`Esc` 正常。
  - 最后一轮回归没有新增浏览器 console error。

## 已知差距 / 后续任务

- 本地状态模型尚未提供原版 `TimeApi` 和完整 `TrimApi`，因此 `Set as T0` 与 marker 菜单里的 Delete Data 保留可见入口和明确状态提示；图表通道右键菜单中的真实 Delete Data 已由现有 sample trim API 提供。
- Logic MSO 专属的 Timing Marker 禁用说明沿用当前设备能力门控，待接入真实 MSO backend 后再做硬件级验证。

## 对应 Git 提交

- `port: complete timing marker interactions`
