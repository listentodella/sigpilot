# README 界面素材

- `start-screen.png`：首次打开、未连接硬件的启动页，包含演示设备和文件加载入口。
- `workbench-dark.png`：Saleae Dark 主题，数字波形、Async Serial 字节气泡和解码结果表。
- `workbench-midnight-aurora.png`：Midnight Aurora 深蓝主题。
- `workbench-solarized-night.png`：Solarized Night 蓝绿主题。
- `workbench-terminal-green.png`：Terminal Green 黑绿主题。
- `workbench-light.png`：同一段演示采集，切换到 Lab Light 主题。
- `theme-overview.png`：1600 × 1240 的五主题层叠合成图，源排版保存在 `theme-overview.html`。背景卡片透明度为 58% / 70% / 80% / 90%，前景为 100%；仅加展示用标题栏、圆角、阴影与背景，不改绘 UI 内容。
- 原始截图尺寸：1600 × 1000；六张原始 PNG 合计约 778 KiB，总览图另计。
- 来源：本项目真实 React 前端，通过 Chrome Playwright 操作界面截取；无图像生成、无手工补绘波形或解码结果。
- 数据：浏览器演示后端生成，非硬件实测。界面上的 Saleae Native 标签是解码器选择状态，不表示浏览器调用了原生 sidecar。

更新时运行 `pnpm dev`，启用演示设备，添加默认 Async Serial 解码器，开始/停止采集，放大到可读字节气泡，打开解码器数据表。在同一个会话中依次切换全部五个内置主题，保持采集和视口不变，直接截图；使用隔离浏览器会话，避免带入个人设备、日志和私人采集。
启动页截图使用全新浏览器会话，页面加载后不选择设备、不导入文件，直接截取初始界面。

README 的截图应与其功能说明一致。如果换成桌面应用或硬件采集截图，请同步更新来源与测试环境说明。

总览图更新：在 Chrome 打开 `theme-overview.html`，以 1600 × 1240、设备缩放 1 截取整页，输出 `theme-overview.png`。保持所有源图片加载完成，勿把该合成效果描述为应用真实透明窗口。
