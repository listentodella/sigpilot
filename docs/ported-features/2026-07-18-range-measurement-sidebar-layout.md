# Range Measurement 侧栏条目布局补齐

## 功能范围

- 右侧 Measurements 列表的 RangeItem 改为原版 subgrid 行结构。
- 备注气泡从 inline span 组合改为原版 `Note` 的 div/overflow 单行省略结构。
- 范围名输入框补上原版 `StringAutosizingInput` 的轻量 autosizing 行为，避免默认 input 宽度挤压 comment 列。
- 展开状态下补回每个 range 的 measurement label/value 行。
- 右侧 goto / menu 控件改回原版 hover/focus 才显示，不再因 selected 常驻。
- 空状态改用原版 `empty_measurement.svg` 视觉资产。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/RangeItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/sidebar/Note.tsx`
- `.app-data/saleae-logic-2.4.43/assets/58341a7c2e2c3a97f64c0172e492aeb2.svg`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`
- `src/assets/saleae/empty_measurement.svg`
- `docs/PORTING_LOG.md`
- `docs/FILE_MAP.md`

## 复用方式

- 结构复刻：按原版 `RangeItem` 的 `expandButton/icon/label/value/comment/goto/menu` subgrid 列名重排本地 DOM。
- 视觉常量复用：复用原版 18px action 列、8px swatch、18px auto row、5px row gap、8px 纵向 padding、`Note` 的 999 圆角和 `4px 8px` padding。
- 行为复刻：goto/menu 控件按原版仅在 hover 或菜单 focus 时出现；selected 只影响条目背景和文字色。
- 资源复用：直接复制原版空态 SVG asset 到 `src/assets/saleae/empty_measurement.svg`。

## 用户可见行为

- 右侧 Measurements item 的 `M0 -> Delta`、duration、comment 气泡、goto/menu 控件按原版列对齐。
- 在 tooltip 的 `Comment here` 输入长文本后，右侧 item 的气泡会显示开头文本并正常单行省略，不再被范围名 input 挤到几乎不可读。
- range 展开时，右侧 item 下方会显示当前启用 measurement 的 label/value 行。
- 没有 measurement 时，右侧面板显示原版空态插图。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 选择 demo device，确认不会自动采集。
  - 手动 Start/Stop 后添加 Range Measurement。
  - 在 tooltip `Comment here` 输入长中文备注。
  - DOM 检查 `.rangeCommentContainer` 宽度约 `119px`，`.rangeCommentBubble` 宽度约 `111px`，内部文本 `text-overflow: ellipsis`。
  - 截图确认右侧 item 中备注气泡显示为原版深色 pill + 左下角尖角，展开测量行与主行列对齐。

## 已知差距 / 后续任务

- 本地仍用 React 状态模型代替原版 MobX `Range` 对象；当前搬运重点是 sidebar item 的视觉结构和可操作行为。
- `StringAutosizingInput` 只用轻量 `ch` 宽度模拟，后续如果搬入原版 uikit input，可替换为完整 autosizing 组件。

## 对应 Git 提交

- `port: polish range measurement sidebar layout`
