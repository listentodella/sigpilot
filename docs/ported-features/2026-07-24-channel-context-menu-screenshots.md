# 通道右键菜单截图功能

## 功能范围

- 启用通道右键菜单中的 `Screenshot <channel>`、`Screenshot Window` 和 `Screenshot Destination [File/Clipboard]`。
- 通道截图只包含该通道的波形 mouse target，不包含左侧名称、analyzer strip 或右键菜单。
- 文件目标支持 PNG、JPEG 和原版 JPEG 80% quality；剪贴板目标写入 macOS 图像剪贴板。
- 截图目标和上一次文件路径按应用全局持久化，默认目标为 `File`。
- 文件名按自定义 session 名、设备名、`Logic 2` fallback 的顺序推导，已有文件使用 `_2`、`_3` 递增。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/ConnectedScreenshotContextMenuItems.tsx`
  - 直接搬运 300ms 菜单关闭延迟、row `mouseTarget.getBoundingClientRect()` 裁剪语义、destination submenu 不关闭规则。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/takeScreenshot.ts`
  - 直接搬运整 WebView capture、全局 destination、PNG/JPEG 编码和 JPEG 80% quality。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/getNextFilePath.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/getDerivedFilePath.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/screenshots/incrementFilePathNumericIndex.ts`
  - 直接搬运默认 session 名、设备名、custom basename 和数字后缀规则。

## 本地落点文件

- `src/App.tsx`
- `src/lib/screenshots.ts`
- `src-tauri/src/main.rs`
- `src-tauri/capabilities/default.json`
- `Cargo.toml`
- `src-tauri/Cargo.toml`
- `package.json`

## 复用方式

- 菜单结构与状态规则按原版 `ConnectedScreenshotContextMenuItems` 搬运：目标切换项带 checkmark，单击后 submenu 保持打开。
- Tauri 正式链路使用 macOS `WKWebView.takeSnapshot`，对应原版 Electron `BrowserWindow.capturePage` 的原生 WebView 像素捕获；通道矩形在原生图像上按实际 scale factor 裁剪。
- 普通浏览器预览保留 lazy-loaded `html2canvas` fallback，不进入 Tauri 正式链路。
- 文件命名与递增规则在 Rust 中使用结构化 path 处理，不使用字符串拼接猜测目录或扩展名。
- 用户未输入有效扩展名时补上当前首选 PNG/JPEG 扩展名，保持原版 file filter 行为。

## 用户可见行为

- 右键任意可见通道后，菜单显示当前重命名后的通道名称，例如 `Screenshot SDA`。
- 单击截图动作时菜单先关闭，300ms 后捕获，因此成品不会包含右键菜单。
- `Screenshot <channel>` 只输出波形视口中对应信号行；`Screenshot Window` 输出完整 WebView。
- `Clipboard` 成功后状态显示 `Screenshot copied to clipboard`；文件成功后显示最终文件名。

## 验证方式

```sh
pnpm build
cargo test -p pxlogic-desktop screenshot_
cargo test --workspace --no-fail-fast
cargo fmt --all -- --check
git diff --check
```

真实 Tauri smoke：

- Demo session Start/Stop 后，从 D0 右键菜单切换到 `Clipboard`，随后仍能在同一菜单命中 `Screenshot D0`。
- 通道截图成功写入 macOS pasteboard，PNG 为 `2162x162`；宽度对应 graph viewport，且不含左侧标签、analyzer strip 和菜单。
- 整窗截图成功写入 macOS pasteboard，PNG 为 `2640x1680`，对应 `1320x840` WebView 的 Retina 2x 像素。
- 原先的 WKWebView `html2canvas` 挂起已通过原生 snapshot 路径消除。

## 已知差距 / 后续任务

- macOS Tauri 使用原生 snapshot；非 macOS Tauri 目前明确返回 unsupported，后续在 Windows/Linux 桌面目标启用时分别接入 WebView2/GTK 原生截图。
- 浏览器 fallback 只用于 `http://127.0.0.1:1420/` 前端预览，不代表桌面正式截图后端。

## 对应 Git 提交

- `port: complete channel screenshot actions`
