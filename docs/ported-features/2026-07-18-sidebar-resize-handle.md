# 右侧 Sidebar 横向 Resize

## 功能范围

- 右侧工具栏面板打开后，可以拖动面板左边缘调整横向宽度。
- 右侧 47px icon rail 保持固定宽度，仅 active panel 宽度变化。
- 拖拽范围遵循原版最小宽度和主波形保留区域，避免把 graph 区域挤到不可用。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/manager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/Resizer.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/defaults.ts`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 复用原版尺寸常量语义：
  - `SIDEBAR_MIN_WIDTH = 300`
  - `SIDEBAR_DEFAULT_WIDTH = 300`
  - `SIDEBAR_TABS_CHANGER_WIDTH = 47`
  - `GRAPH_MIN_WIDTH = 50`
  - `GRAPH_ROW_LABEL_MAX_WIDTH = 293`
- 复用原版 Resizer 的垂直线拖拽语义：面板左侧 5px 热区、`ew-resize` 光标、拖动时根据左移距离增大 sidebar width。
- 复用 `services/themes/builtin.ts` 的 DarkTheme token，并限定在 Sidebar 子树：
  - `background-0/10/20/30`
  - `hover-background`
  - `border-10/20/focused/hover/highlight`
  - `on-background-0/10/20/30/40`
- 没有引入原版 `react-draggable` / MobX SidebarManager 依赖树；使用当前 React 状态模型承载 `sidebarPanelWidth`。

## 用户可见行为

- 打开任意右侧面板后，鼠标移动到面板左边缘会出现横向 resize 光标。
- 向左拖动会放大右侧面板，向右拖动会缩小，但不会小于原版 300px。
- 切换 Devices / Analyzers / Measurements 等右侧按钮时，用户调整过的宽度会保留。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 打开任意右侧面板，拖动左边缘可调整宽度。
  - 面板宽度不能小于 300px。
  - icon rail 宽度保持 47px，布局无文字重叠。
  - 计算样式应与原版 DarkTheme 一致：panel `#1B1B1C`、rail `#3A3A3E`、border `#57575E`。
