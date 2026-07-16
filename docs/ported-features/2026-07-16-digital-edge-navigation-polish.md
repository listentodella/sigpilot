# 数字通道边沿跳转细节优化

## 功能范围

本次修正上一次边沿跳转搬运中的三个细节：

- 按钮 hover 时立即显示快捷键提示，不再依赖浏览器 `title` 延迟。
- 点击 Previous Edge / Next Edge 后使用原版 300ms 平移动画，而不是生硬跳转。
- 按照原版 `.channelOverlayButton { transform: scale(-1, 1) }` 修正边沿跳转图标方向。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/DigitalNavigationButton.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Tooltip.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Tooltip.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/ShortcutIcon.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/defaults.ts`

## 本地落点文件

- `src/components/WaveformCanvas.tsx`
- `src/styles.css`

## 复用方式

- Tooltip 视觉复用原版 `Tooltip.module.css` 的背景色、边框、阴影、字号。
- 快捷键显示复用原版 `ShortcutIcon` 的 keycap 结构。
- 图标方向复用原版 `channelOverlayButton` 的 `scale(-1, 1)` 镜像规则。
- 平移动画复用原版 `PANNING_ANIMATION_DURATION = 300ms`，并采用 ease-out 曲线模拟 `animateToTime` 的连续过渡。

## 用户可见行为

- 鼠标移到左右边沿跳转按钮上，马上能看到 `Previous Edge / Next Edge` 和对应快捷键。
- 点击跳转按钮后，波形以 300ms 左右的动画滑到目标边沿。
- 左右按钮图标方向与提示语一致。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- Demo capture 后 hover 数字通道，移动到 Next Edge 按钮。
- 验证 tooltip 无 `title` 延迟，且显示 `Next Edge` 与 `Cmd/Ctrl + →`。
- 点击 Next Edge，水平视窗逐帧变化：`0 -> 28236 -> 73476 -> 75008`。
- 验证 SVG `transform` 为水平镜像。

## 已知差距 / 后续任务

- 当前动画在前端 viewport 上执行；原版动画由图形后端 `animateToTime` 统一驱动。等后端 per-session capture handle 完成后，可将边沿搜索和动画控制进一步后移。

## 对应 Git 提交

- `68e578c` (`polish: digital edge navigation`)
