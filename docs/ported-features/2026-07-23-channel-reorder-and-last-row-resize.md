# 通道拖动排序与最后一行高度调整

## 功能范围

- 在左侧通道名称面板按住鼠标左键并移动后进入通道拖动状态，沿用原版 drag handle 的移动阈值与取消语义。
- 拖动通道名称行可调整可见通道的上下顺序，D0-D31 的物理编号、颜色、解码通道和硬件配置保持不变。
- 拖动时整行提升为固定浮层：包含通道标签和当前 Canvas 对应行的波形快照；原位置保留 placeholder，相邻行按原版曲线平滑让位。
- 通道顺序按 session 独立保存，切换 session 或重新捕获不会覆盖用户已经调整的顺序。
- 最后一条通道的底部也提供 RowV2 风格的 resize handle，可以继续调整最后一个通道的高度。

## 原版参考路径

- .app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/index.tsx
  - Reorder 容器、visible rows 顺序和 reorderChannels 调用。
  - 拖动期间保持图形 renderer 刷新的交互规则。
- .app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Reorder.tsx
  - 原版基于 react-beautiful-dnd 的纵向 row reorder 结构。
- .app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/RowsManager.ts
  - reorderChannels(sourceRow, destinationRow) 的顺序状态规则。
- .app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowV2.tsx
  - 行级 resize handle 的布局边界。
- pxview-fork/PXView/pv/view/header.cpp
  - 最后一条 enabled trace 使用独立 bottom border resize 分支。

## 本地落点文件

- src/App.tsx
  - UiSession.channelOrder 状态。
  - 可见通道顺序计算、`DragDropContext/Droppable/Draggable`、目标 index 排序和 React 18 StrictMode 兼容层。
  - 拖动期按行裁剪单 Canvas，保证标签与波形预览同步让位；拖动结束后恢复单 Canvas 渲染。
  - 最后一行 resize handle 渲染。
- src/styles.css
  - 原版 RowV2 纵向列表、placeholder、浮层阴影、整宽拖动预览和 cubic-bezier 让位动画。
- package.json / pnpm-lock.yaml
  - 复用原版 `react-beautiful-dnd@13.1.1` 及 TypeScript 类型包。

## 复用方式

- 状态规则复刻：通道顺序与原版一样按 row 保存，不把显示顺序混入硬件 channel index。
- 结构规则复刻：波形 tile、标签行、分析器气泡和测量 overlay 共同使用 visibleChannelIndexes，因此排序后所有内容同步换位。
- 交互规则复刻：直接使用原版 `uikit/elements/Reorder.tsx` 的 `DragDropContext`、`Droppable`、`Draggable` 结构和 drag handle 属性；排序结果仍写回当前 React session 模型。
- 渲染适配：当前工程为性能保留单一波形 Canvas，因此拖动期间从 Canvas 按行裁剪预览，模拟原版完整 `GraphRow` 被提升后的视觉，不改变常态渲染路径。
- resize 规则复刻：行间 handle 继续调整上方通道；最后一行 handle 调整最后通道自身高度，对应 PXView 的 lastTrace 分支。

## 用户可见行为

- 普通短点击不会触发排序；按住左键并移动后显示固定浮层，减少与重命名、右键菜单的冲突。
- 拖动过程中原位置出现 placeholder，目标附近通道按 `0.2s cubic-bezier(0.2, 0, 0, 1)` 平滑让位；按 Escape 可取消且不改变顺序。
- 已隐藏或未启用的通道不参与当前拖动目标，但其在 session 顺序中的位置会被保留。
- 拖动最后一个通道名称不会改变通道高度；需要拖动最后一个通道底部的横向分隔区域。

## 验证方式

- PATH=/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH pnpm build
- git diff --check
- 启动 pnpm dev -- --host 127.0.0.1 --port 1420，确认 http://127.0.0.1:1420/ 正常返回。
- 通过 9222 的 CDP Runtime.evaluate 只读检查原版页面，确认拖动浮层为 `position: fixed`、`z-index: 5000`、`pointer-events: none`，并使用 placeholder 与 transform 让位。
- 在 Demo 捕获界面按住左侧 D0 标签并拖到 D2 前后，确认固定浮层、placeholder、标签/波形行预览和最终 session 顺序。
- 浏览器烟测确认最后一行 resize 的 `aria-valuenow` 从 43 变为 76，Escape 取消拖动后顺序和 DOM 状态恢复。
- 启用足够多的通道使纵向内容超过窗口，在最后一行底边拖动，确认最后通道高度发生变化且出现纵向滚动。

## 已知差距 / 后续任务

- 当前单 Canvas 架构无法像原版多个 `GraphRow` 一样逐层重绘 analyzer 气泡、cursor 和 range overlay；拖动期已同步波形快照，其他 overlay 保持静止以避免破坏捕获渲染性能。
- `react-beautiful-dnd` 本身已停止维护；本轮为最大化复用原版行为保留该依赖，React 18 通过 `StrictModeDroppable` 一帧延迟兼容注册生命周期。
- 当前排序是“可见数字通道”范围内的排序；模拟、HLA 等其他 row 类型尚未加入同一排序容器。
- 需要在真实 9222 页面上继续对比拖动阴影、placeholder 和跨滚动区域拖动边界；当前已完成 DOM 结构只读核对。

## 对应 Git 提交

- 待提交：port: channel reorder and last row resize
