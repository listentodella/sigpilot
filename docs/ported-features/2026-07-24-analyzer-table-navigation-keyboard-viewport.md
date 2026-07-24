# Analyzer Data Table 跳转与键盘视口交互

## 功能范围

- Data Table 每一行的 `Go to data` 按钮固定在当前横向可视区域右侧，不再随 MOSI/MISO 等动态协议列移动到表格末端。
- 跳转按钮直接复用 Logic 2.4.43 的 `goto` SVG 路径、24px 容器、10px scrollbar 间距及主题色。
- 搬运 Logic 2 横向视口快捷键：`Up / = / W` 放大、`Down / - / S` 缩小、`Left / A` 左移、`Right / D` 右移。
- 键盘缩放围绕当前视口中心执行 0.5x/2x，键盘平移每次移动三分之一屏，并使用原版 100ms 动画。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/dataTable/DataView.tsx`
  - `tableXVisibleRight = totalColumnsWidth - tableClientWidth - tableXScroll`。
  - `RowButtons` 在 hover row 内渲染，并用可视右边界动态设置 `right`。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/dataTable/styles.module.css`
  - `rowButtonWrapper`、`rowButton` 的 24px 尺寸、2px radius、`background-10`、`border-20` 和 scrollbar 右侧间距。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Button.tsx`
  - `GoToButton` 的默认颜色、hover 颜色和 10px icon 规则。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/goto.tsx`
  - 9x8 viewBox 和原始 path 数据。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/shortcuts/keyBindings.ts`
  - Logic 2 `ZoomIn / ZoomOut / PanLeft / PanRight` 的完整按键映射。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/useInteraction.ts`
  - 0.5/2 zoom factor、三分之一 viewport 平移和 100ms animation duration。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/KeyCommands.tsx`
  - 输入控件排除、命令优先级和事件消费规则。

## 本地落点

- `src/App.tsx`
  - Data Table scroll/resize 时按 `scrollWidth - clientWidth - scrollLeft` 更新 `--table-visible-right`，等价搬运原版 `tableXVisibleRight`。
  - 使用容器 CSS variable 更新按钮位置，横向滚动不会触发 500 行 React 重渲染。
  - `SaleaeGoToIcon` 直接使用原版 `goto.tsx` 的 viewBox/path。
  - `animateViewport` 支持可选 duration；原有 range/frame 跳转保持 300ms，键盘交互使用原版 100ms。
  - 全局快捷键先处理 `N A`、`M D` 等多键序列，再处理 `A/D/W/S` 视口交互，避免命令冲突。
- `src/styles.css`
  - 跳转按钮 `right` 改为 `calc(var(--table-visible-right) + 10px)`。
  - 保持原版 hover/focus 显示规则、主题色和无额外淡入动画。

## 用户可见行为

- SPI 等多数据列 analyzer 不需要先拖到表格最右端；鼠标经过任一 frame row 时，跳转按钮始终出现在当前可视区域右侧。
- 单击按钮将 frame 平滑移动到视口中央；双击继续使用已有的 frame interval zoom 行为。
- 波形区域存在 capture 时，可直接使用方向键或 WASD 缩放/平移；输入框、textarea、select 和 contenteditable 获得焦点时不响应。
- `Cmd/Ctrl + Left/Right` 仍保留给通道边沿和 analyzer bubble 导航，不与无 modifier 的视口平移冲突。

## 验证方式

```sh
pnpm build
```

浏览器使用 SPI Demo、`Type / Start / Duration / MOSI / MISO` 多列表格验证：

- table `scrollWidth = 433px`、`clientWidth = 268px`。
- 横向滚动 `0 -> 120 -> 165px` 时，按钮始终距离可视内容右边缘 10px。
- 按 `Right` 后 100k-sample 视口从 sample 0 平移到 33,333；按 `Left` 返回 0。
- 按 `Up` 后视口中心保持不变，Zoom 从 `137 S/px` 变为 `68 S/px`；按 `Down` 恢复 `137 S/px`。
- `N -> A` 保持 viewport sample 不变并执行 sidebar command；随后单独 `A` 仍正常左移 33,333 samples。
- 第 101 个 SPI frame 的 `Go to data` 按钮成功将 viewport 移至 sample 1,484,131。

## 已知差距 / 后续任务

- 当前 Data Table 最多渲染 500 行；原版使用 `BiVirtualList` 和 FrameDB，可在完整持久 frame database 接入时继续搬运双向虚拟列表。
- 对应 Git 提交：本文所在的 `port: align analyzer row navigation and viewport keys` 提交。
