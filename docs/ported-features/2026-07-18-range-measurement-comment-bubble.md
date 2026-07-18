# Range Measurement 备注气泡

## 功能范围

- 右侧 Measurements 列表里，range tooltip 的 `Comment here` 内容不再作为裸文本显示。
- 当 range 有 comment 时，对应 Measurements item 渲染一个原版 Note 风格气泡。
- 没有 comment 时不显示气泡内容，保持原版空状态。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/RangeItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/timingMarkers/sidebar/Note.tsx`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 结构复刻：按原版 `RangeItem` 中 `<Note>{range.comment}</Note>` 的职责，将本地 sidebar comment 包成 `RangeCommentBubble`。
- 视觉常量复用：复用原版 `Note` 的 `hover-background`、999 圆角、左下角尖角、`spacing(1) spacing(2)` 对应的 `4px 8px` padding，以及 `spacerSizes.xs` 对应的 `8px` 左间距。
- 状态复用：继续使用同一个 `UiRangeMeasurement.note` 字段，所以 tooltip 输入后右侧栏立即同步。

## 用户可见行为

- 在 range tooltip 的 `Comment here` 中输入内容后，右侧 Measurements 对应条目会出现一个小气泡。
- 气泡内显示 comment 内容，过长时单行省略。
- 删除 comment 后气泡消失。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 选择 demo device，手动 Start/Stop。
  - Add Range Measurement 后在 tooltip comment 输入 `comment bubble parity`。
  - 右侧 Measurements item 出现 `.rangeCommentBubble`，文本同步为 `comment bubble parity`。
  - 读取样式确认 `background: rgb(58, 58, 62)`、`border-radius: 999px 999px 999px 0px`、`margin-left: 8px`、`padding: 4px 8px`。

## 已知差距 / 后续任务

- 当前气泡已复刻 Note 的静态视觉和同步行为；后续若继续搬运 sidebar 动画，可接入原版 `ITEM_MOUNT_ANIMATION` 与 ContextMenu 细节。

## 对应 Git 提交

- `port: add range measurement comment bubble`
