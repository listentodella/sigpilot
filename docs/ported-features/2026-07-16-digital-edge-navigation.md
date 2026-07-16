# 数字通道边沿跳转

## 功能范围

本次搬运原版 Logic 2 在数字通道 hover 时显示的左右边沿跳转按钮：

- 鼠标停在某个数字通道上时，通道左侧显示 Previous Edge，右侧显示 Next Edge。
- 按钮仅在当前 tile 能找到对应方向的视窗外边沿时显示。
- 点击 Next Edge 后，将目标边沿放到视图左侧约 25% 位置。
- 点击 Previous Edge 后，将目标边沿放到视图左侧约 75% 位置。
- 支持原版快捷键：`Cmd/Ctrl + Left` 和 `Cmd/Ctrl + Right`。
- 快捷键跟随鼠标所在通道生效，输入框聚焦时不会触发。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/DigitalNavigationButton.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/KeyCommands.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/interactionCommands.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/shortcuts/keyBindings.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/jumpToNextEdge.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/jumpToPreviousEdge.tsx`

## 本地落点文件

- `src/components/WaveformCanvas.tsx`
- `src/styles.css`

## 复用方式

- 直接复用：`jumpToNextEdge` / `jumpToPreviousEdge` SVG path。
- 结构复刻：原版 `DigitalNavigationButton` 的 26px 按钮、边框、hover 变亮、左右贴边位置。
- 状态规则复刻：只有 hover 到通道时按钮和快捷键才生效。
- 算法复刻：参考原版 `directionProps`，Next Edge 放到 25% 位置，Previous Edge 放到 75% 位置。
- 适配实现：原版依赖 `RenderingManager.response.previousTransitionTime/nextTransitionTime`；当前先从 `WaveformTile.rising_edges/falling_edges` 查找视窗外边沿，并在没有精确边沿数组时从 bin fallback 估算。

## 用户可见行为

- 放大波形后，把鼠标放到任意数字通道上，会在该通道左右两侧出现边沿跳转按钮。
- 点击右侧按钮会跳到下一个边沿，点击左侧按钮会跳到上一个边沿。
- 鼠标停在通道上时，可直接使用 `Cmd/Ctrl + ←/→` 跳转。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- Demo capture 后移动鼠标到第一条通道。
- 验证 `.digitalNavigationButton.next` 出现。
- 点击 Next Edge，水平视窗从 `0` 跳到 `75008`。
- 使用 `Cmd/Ctrl + Right`，水平视窗继续跳到 `150000`。

## 已知差距 / 后续任务

- 原版由渲染后端直接返回视窗外边沿；当前前端只搜索已加载 tile 和 overscan 范围。若目标边沿距离当前视窗超过 tile 覆盖范围，按钮会暂时隐藏。
- 后续可增加后端 `find_edge` / per-session capture handle，让边沿跳转覆盖整段 capture。

## 对应 Git 提交

- `9948ace` (`port: digital edge navigation`)
