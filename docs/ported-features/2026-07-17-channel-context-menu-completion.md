# 通道右键菜单补全

## 功能范围

本次补齐上一版通道右键菜单遗漏的原版菜单面，并把 `Delete Data` 接成真实功能：

- 通道标签右键继续显示原版高度、可见性、设置和截图区域。
- 波形图表区右键新增同一套 RowContextMenu，并带当前通道与点击 sample。
- `Delete Data` 按 Logic 2 运行时规则在图表区和通道标签右键均可用，包含：
  - `Before This Point`
  - `After This Point`
  - `Off Screen`
- 补齐原版 `ConnectedScreenshotContextMenuItems` 的菜单占位：
  - `Screenshot Dn`
  - `Screenshot Window`
  - `Screenshot Destination [File]`
- 新增 Tauri `trim_capture` 命令，真实裁剪当前 capture sample buffer。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowContextMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/ChannelLabel.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/useTrimApi.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/useViewStateApi.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/ConnectedScreenshotContextMenuItems.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/takeScreenshot.ts`

## 本地落点文件

- `src/App.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/lib/api.ts`
- `src-tauri/src/main.rs`
- `src/styles.css`

## 复用方式

- 状态规则复刻：有 capture 时显示 `Delete Data`；空 session 不显示。恢复源码中的 `isChannelLabel` 条件与 2.4.43 实际运行结果不一致，最终按 9222 运行时验证结果实现。
- 算法搬运：图表区的 `Before/After This Point` 使用右键点击 sample；通道标签没有 X 坐标，使用当前 viewport 左边界；`Off Screen` 使用当前 viewport 的 left/right sample 作为保留区间。
- 行为适配：裁剪后重置 tile/analyzer frame window，range/marker sample 坐标按裁剪起点平移并夹紧。
- 后端适配：Tauri `trim_capture` 对当前 `CaptureData.samples` 按 `unitsize` 切片，并更新 `metadata.sample_count`。
- 平台适配：Screenshot 菜单通过 Tauri 截图后端提供 `Save to File` / `Copy to Clipboard`。

## 用户可见行为

- 右键通道标签能使用 `Delete Data`，裁剪锚点为当前 viewport 左边界。
- 右键波形区域时，`Delete Data` 可用且展开后能执行三种裁剪。
- 执行 `Before This Point` 后，capture 样本数和字节数会减少，状态显示 `Deleted data before point`。
- Screenshot 项可保存当前通道或整个窗口，也可切换文件/剪贴板目标。

## 验证方式

- `pnpm build`
- `cargo check`（在 `src-tauri` 目录）
- 浏览器访问 `http://127.0.0.1:1420/`
- 选择 demo device，手动 Start，采样约 650ms 后 Stop。
- 右键 `D0` 标签，验证 `Delete Data` 可用并包含三个子项。
- 右键波形区第一行，验证 `Delete Data` 可用并包含三个子项。
- 执行 `Delete Data -> Before This Point`，验证状态变为 `Deleted data before point`，样本数从约 `24.9 MS` 变为 `58.02 kS`。

## 已知差距 / 后续任务

- 当前裁剪后会重置 analyzer decode window；后续如果实现后端 analyzer cache，可按原版 session graph backend 增量更新。
- Demo 浏览器运行时裁剪会更新 summary 和 viewport，但 demo waveform 函数仍按局部 sample 重新生成，不保留旧绝对 sample offset。

## 对应 Git 提交

- `port: complete channel context menu`
