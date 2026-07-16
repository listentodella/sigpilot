# Notes 右侧栏

## 功能范围

- 将 Notes 占位 textarea 替换为原版 `CaptureNotes` 结构。
- 复刻原版 Notes 标题、帮助说明、textarea 占位文案和排版常量。
- 继续使用 `UiSession.notes`，保证每个 session 独立保存捕获说明。
- 保留原版右栏快捷键序列 `N N`。
- 验证 session 切换、关闭 active session 和邻近 session 自动接管时的 notes 隔离。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/CaptureNotes.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/CaptureNotes.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/text/notesSidebar.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/panelsContent.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/commands.tsx`

## 本地落点文件

- `src/components/CaptureNotesPanel.tsx`
- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 结构搬运：沿用原版 `SidebarTitle + textarea` 的单列 flex 布局。
- 状态规则搬运：textarea value 直接绑定 active session 的 notes，输入时只更新当前 session。
- 文案复用：使用原版占位文案和 `notesSidebar.notes` 帮助说明。
- 视觉常量复用：左侧 16px、右/下 16px、14px 字号、22px 行高、透明背景、无边框和不可缩放。
- 快捷键复用：沿用现有原版 `N` 前缀命令层，通过 `N N` 打开 Notes。

## 用户可见行为

- 打开 Notes 后可直接输入捕获环境、测试条件和信号特征说明。
- 点击标题旁帮助图标可查看原版 Notes 用途说明。
- 新建 session 时 Notes 为空，不会复制上一 session 的内容。
- 在 session tabs 之间切换时，每个 session 恢复自己的 Notes。
- 关闭 active session 后切到邻近 session，Notes 面板保持打开并显示邻近 session 的内容。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`。
- Demo capture 后按 `N N`，确认 Notes 面板打开。
- Session 1 输入 `Session 1: UART idle line rises after reset.`。
- 通过底栏 `+` 创建 Session 2，确认 textarea 初始为空并输入独立内容。
- 在两个 tab 间来回切换，确认内容不串线。
- 关闭 Session 2，确认自动回到 Session 1 并恢复原笔记。
- 检查 textarea computed style：`font-size: 14px`、`line-height: 22px`、`padding: 0 16px 16px 0`。
- 浏览器控制台无 error/pageerror。

## 已知差距 / 后续任务

- Notes 当前随前端 `UiSession` 生命周期保存；`.pxcap` 文件格式尚未增加 capture notes 字段，因此关闭应用后不会随捕获文件恢复。
- 原版 tooltip 使用统一 uikit portal；本地实现使用同视觉规则的轻量 popover。

## 对应 Git 提交

- `port: notes sidebar`
