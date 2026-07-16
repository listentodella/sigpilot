# Timing Markers 右侧栏

## 功能范围

- 将 marker pair / single marker 从计数升级为 session 级对象数组。
- 复刻 Timing Markers 面板结构：标题 `+`、Add Marker Pair、Add Single Marker、空状态、marker 列表。
- Marker item 支持重命名、备注、Go to Marker、Zoom、Delete、Delete All。
- 在波形区增加 marker overlay：single marker 单线，pair marker 双线 + band，边界可拖动。
- 保留原版快捷键入口：`Cmd/Ctrl+T` 添加 pair，`Shift+Cmd/Ctrl+T` 添加 single。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/AddMarkerMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/sidebar/MarkerItems.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/sidebar/MarkerItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/sidebar/PairItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/GraphMarkers/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/commands.ts`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 结构复刻：`+` 菜单、marker list、empty state、item actions。
- 行为复刻：pair/single 创建、选择、重命名、备注、跳转、缩放、删除。
- 交互适配：marker graph layer 用 DOM overlay 叠加到 canvas，上层拖动 sample 位置。

## 用户可见行为

- 点击 Timing Markers 面板 `+` 可添加 Marker Pair 或 Single Marker。
- 波形上 pair 显示 A1/A2 双线，single 显示 T 单线。
- 右栏 item 显示 Delta/Time 与 Sample，可备注和删除。
- Marker line 可在波形上拖动。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- Demo capture 后打开 `Timing Markers (N T)`。
- 添加 1 个 Marker Pair 和 1 个 Single Marker。
- 验证出现 2 个 `.timingMarkerItem`、2 个 `.timingMarkerBand`、3 条 `.timingMarkerLine`。

## 已知差距 / 后续任务

- 原版 marker summary popup、edit popup、off-screen indicator、全选删除还未搬入。
- 当前 Go To / Zoom 在前端直接更新 viewport，后续可统一到 rendering manager 行为。

## 对应 Git 提交

- `port: timing markers sidebar`
