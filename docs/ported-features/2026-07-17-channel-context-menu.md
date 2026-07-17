# 通道右键菜单

## 功能范围

本次搬运 Logic 2 数字通道标签右键菜单的可运行骨架与核心行为：

- 数字通道右键菜单替换为原版 `RowContextMenu` 的分组结构。
- 支持 `Resize All Digital Channels to Match`，将所有已启用数字通道高度匹配当前通道。
- 支持 `Fit all Rows to Window Height`，恢复自动按窗口适配高度。
- 支持 `Auto Layout` 勾选项，切换自动/手动通道高度布局。
- 支持 `Show Interactive Measurement` 勾选项，控制波形 hover 测量显示。
- 支持 `Hide Channel`，按原版 `row.isMarkedHidden` 思路只隐藏行，不禁用下一次采集通道。
- 支持 `Show/Hide Channels` 子菜单，包含 `Show All Channels` 和 32 个数字通道可见性勾选项。
- 支持 `Reset Channel Names`，恢复 `D0`... 默认名称并同步 summary/tile label。
- 支持 `Settings`，在当前 Tauri 骨架中打开右侧 `Device Settings` 面板。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowContextMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/ChannelLabel.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/rowVisibilityMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/Row.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RowsManager/RowsManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/text/rowContextMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/ContextMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/ContextMenuStyles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/ConnectedScreenshotContextMenuItems.tsx`

## 本地落点文件

- `src/App.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/styles.css`

## 复用方式

- 状态规则复刻：新增 `hiddenDigitalChannels`，对应原版 `row.isMarkedHidden`，与设备采集启用通道分离。
- 状态规则复刻：新增 `showInteractiveMeasurement`，对应原版 `rapidDataStore.showInstantaneousMeasurement`。
- 结构复刻：按原版数字通道 `RowContextMenu` 顺序组织高度、Auto Layout、交互测量、隐藏、Show/Hide、重置名称和 Settings。
- 结构复刻：按原版 `RowsVisibilityMenu` 实现 `Show All Channels` 与不关闭菜单的多选通道列表。
- 视觉复刻：参考原版 `ContextMenu` 的 8px checkmark 列、60px shortcut 列、31px 行高、深色菜单和 flyout 子菜单。
- 适配实现：原版 screenshot 菜单依赖 Electron `BrowserWindow.capturePage`；当前 Tauri 运行时还没有等价后端，本轮记录为差距。

## 用户可见行为

- 右键任意通道标签会出现 Saleae 风格菜单，不再显示旧的 Rename / Trigger / Add Analyzer 自定义菜单。
- `Hide Channel` 会立即从波形区隐藏该通道，但不会改变 Devices 面板里的采集启用状态。
- `Show/Hide Channels` 可展开子菜单，勾选/取消勾选通道可见性，`Show All Channels` 可恢复隐藏行。
- `Show Interactive Measurement` 取消勾选后，hover 脉宽/周期/频率测量不再绘制；左右边沿跳转按钮仍可使用。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- 选择 `Try a demo Logic device` 后不自动采集。
- 右键 `D0`，验证菜单包含原版数字通道菜单项。
- 点击 `Hide Channel`，验证 `D0` 行消失且状态变为 `D0 hidden`。
- 右键 `D1`，展开 `Show/Hide Channels`，点击 `Show All Channels`，验证 `D0` 恢复且菜单保持打开。
- 点击 `Show Interactive Measurement`，验证 `aria-checked` 从 `true` 切换为 `false`。

## 已知差距 / 后续任务

- 原版 `ConnectedScreenshotContextMenuItems` 依赖 Electron screenshot/clipboard/file API；当前 Tauri 后端尚未提供截图命令，因此本轮没有伪造 screenshot 菜单项。
- 原版 `Settings` 打开 Preferences；当前骨架尚无 Preferences 面板，暂时映射到右侧 `Device Settings`。
- 原版菜单使用 `@saleae/react-contexify`；当前为了避免引入原版大型依赖树，复刻其菜单结构、尺寸和状态行为。

## 对应 Git 提交

- `port: channel context menu`
