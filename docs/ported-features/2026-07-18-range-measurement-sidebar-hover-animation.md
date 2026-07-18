# Range Measurement 侧栏 hover 与跳转动画

## 功能范围

- Measurements 右侧栏 range item 不再因为新增、点击或跳转而显示持久 selected 高亮。
- 侧栏 item 仅保留 hover 时的暗色背景反馈。
- 侧栏 Go to Range / Zoom on Range 改走应用内 animated viewport path，不再直接硬切 viewport。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/defaults.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/defaults.ts`

## 本地落点文件

- `src/App.tsx`

## 复用方式

- 侧栏视觉：保留原版 `ITEM_DEFAULT_COLOR` / `ITEM_HOVER_COLOR` 的 item row 模式，不再把本地 `range.selected` 映射成右侧列表的 class。
- 跳转动画：复用现有 `animateViewport()`，它使用原版 `PANNING_ANIMATION_DURATION = 300ms` 对齐的时间尺度；右侧栏的 `goToRange()` 现在通过该动画入口执行。

## 用户可见行为

- 新增 measurement 后，右侧 Measurements 列表不会自动出现一条高亮项。
- 鼠标移到某个 measurement item 上时，才出现暗色 hover 高亮。
- 点击 goto 或菜单里的 Go to Range / Zoom on Range 时，波形视图平滑过渡到目标区域。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 添加多个 range measurement 后，右侧 item 默认都不是 selected 高亮。
  - hover item 时有暗色背景反馈。
  - 点击右侧 goto / menu jump，viewport 有 300ms 左右平滑过渡。
