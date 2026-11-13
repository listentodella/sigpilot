# 悬浮终端

SigPilot 内嵌终端使用 xterm.js 绘制终端，通过 Rust `portable-pty` 启动本机真实 shell。macOS/Linux 使用用户默认登录 shell（优先 `SHELL`，否则读取账户默认值），Windows 使用 `ComSpec`（通常为 cmd.exe）。初始工作目录为用户主目录；用户可自行 `cd` 并运行已经安装的命令行工具，不安装 Codex、Claude 或其他 agent。

## 使用

- 点击标题栏“终端”或右下方终端按钮打开，首次打开才创建 shell。
- 拖动终端标题栏移动，拖动右下角调整大小；大小与位置会保存，窗口变小后自动约束到可见区域。
- 终端在 SigPilot 内悬浮置顶，不改变波形、解码侧栏的布局。它不是操作系统级的独立置顶窗口。
- 点击减号收起为小按钮，保留 shell、当前目录和输出；展开后继续同一个会话。
- 点击放大按钮扩展终端，再次点击恢复原尺寸。
- 点击关闭结束 shell 会话，按钮仍可再次启动新 shell。自然退出显示退出码并提供“启动新会话”。
- `Ctrl/Cmd + \`` 切换展开/收起。终端聚焦时，键盘输入由终端处理；波形快捷键不会响应。

MCP 接入与终端是独立功能，终端不会自动注册服务或配置 agent。终端输入按用户 shell 的普通权限执行。

## 会话与资源

每个桌面窗口最多保留一个 shell。应用窗口销毁时关闭 PTY，清理 shell 和其当前前台进程。滚动历史最多 5000 行；后端未消费输出上限 256 KiB，满时对 PTY 施加背压。收起后继续解析输出，因此状态和输出可恢复。输入串行发送并限制排队量，避免大型粘贴无限堆积。

终端内容不保存到采集文件、不记录到应用日志。只保存浮层几何位置，不跨应用重启恢复 shell。浏览器预览明确提示无法运行真实系统命令。

前端通过 Tauri 命令调用生产 PTY 服务；仅启用桌面现有本地窗口入口，不把任意终端命令发布为 MCP 工具。平台启动不依赖终端程序或额外 Chromium 分发。

## 验证

Instabox 验证入口：

```sh
cargo test -p sigpilot-terminal
cargo build -p sigpilot-terminal --example browser_fixture
node node_modules/vite/bin/vite.js build --config tools/terminal-verify/vite.config.ts
python3 tools/terminal-verify/run.py
```

所有运行验证需通过项目的 Instabox 资源限制包装器。浏览器验证使用生产 Rust PTY 后端与实际 xterm.js，涵盖键盘输入、Unicode、尺寸同步、拖动、收起后台输出、展开会话保持、退出与重新启动。平台级验证结果以执行记录为准，不把 Linux 实测扩展为 macOS/Windows 实测。

2026-11-13 在 Instabox Linux 上通过：2 项真实 shell 集成测试、2 项前端几何/输入测试、TypeScript 检查、Vite 生产构建、完整桌面 `cargo check --locked`，以及 16 项浏览器与生产 PTY 联动检查（包含方向键与 Ctrl+C）。运行均限制为 1 CPU、2 GiB 内存和零 swap。

浏览器验证页背景使用示意波形，终端组件与 shell 后端为生产实现；这不是完整桌面原生窗口的运行验证。macOS/Windows 的实际 shell、输入法及平台剪贴板行为尚需分别验证。
