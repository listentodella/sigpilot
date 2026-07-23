# 启动设备收敛、8 通道默认值与边沿导航修复

## 功能范围

- 启动页移除 Logic MSO 设备卡，只保留 PXLogic 当前支持的 Logic 设备与 Demo Device。
- 新建 session 默认启用 D0-D7；D8-D31 仍可在 Device Settings 中按需启用。
- 修复数字通道 Previous Edge / Next Edge 按钮偶发不显示，以及同一情况下快捷键无法跳转的问题。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/index.tsx`
  - `getJumpToTime()` 直接读取 Graph Server 的 `previousTransitionTime` / `nextTransitionTime`。
  - 鼠标进入整条 channel overlay 后激活按钮与 `Previous` / `Next` 快捷键作用域。
  - 跳转后将目标 transition 放在视口 25% / 75% 位置。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/GraphClient/GraphData.ts`
  - `DigitalRenderData` 明确定义请求区间外最近的 previous / next transition。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/channelOverlay/DigitalNavigationButton.tsx`
  - Previous Edge / Next Edge 按钮与快捷键提示结构。

## 根因

- 本地实现只在当前 waveform tile 和 50% overscan 中搜索边沿。
- 当最近边沿位于 overscan 外、长空闲电平之后，或新 tile 尚未覆盖目标区域时，会错误返回没有边沿。
- analyzer bubble、row top inset 等覆盖层会截获 pointer event；此前 `WaveformCanvas` 只监听自身事件，因此鼠标虽然仍在通道行内，导航作用域却会被清空。

## 实现

- `ChannelTile` 新增可选 `previous_transition` 与 `next_transition`。
- 增量 Rust `DigitalGraph` 直接使用完整通道边沿索引查找请求区间外最近 transition，不再受 tile 像素预算和 overscan 距离影响。
- 扫描版 waveform builder 和浏览器 Demo tile 同步提供相同字段，保证测试、浏览器预览和 Tauri 行为一致。
- 前端先使用 tile 内离视口最近的边沿，超出 tile 时回退到 Graph Server transition 元数据。
- hover 行判定使用完整 outer row，并在 `graphViewport` 上补充 overlay pointer tracking；波形、analyzer bubble 和顶部 inset 区域共享同一导航作用域。
- 保留原版 25% / 75% 定位和 `Cmd/Ctrl + Left/Right` 快捷键。

## 默认设备与通道

- `DeviceStartScreen` 只渲染一张居中的 Logic 卡，删除 MSO 图片和设备提示。
- React session、浏览器 Preview、Rust `CaptureSettings::default()` 和 capabilities 的建议默认值统一为 8 通道。
- 32 通道硬件能力、模式列表和手动 Select All 行为不变。

## 验证

- `cargo test -p pxlogic-waveform -p pxlogic-graph`：13 项测试通过。
- `cargo test -p pxlogic-core`：35 项测试通过。
- `pnpm build`：TypeScript 与 Vite production build 通过。
- `git diff --check`：通过。
- 浏览器启动页：1 张设备卡、无 `Connect Logic MSO`、新 session 显示 8 Channels。
- Demo capture 缩放后逐行 hover D0-D7：每行均显示 Previous Edge 与 Next Edge。
- 在 waveform 上方插入可交互 overlay 后 hover：两个边沿按钮仍然显示。
- 快捷键和按钮烟测：Next keyboard、Next button、Previous keyboard 均改变 scrollbar `aria-valuenow`。

## 对应 Git 提交

- 待提交：fix: default channels and edge navigation metadata
