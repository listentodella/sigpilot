# Extensions 右侧栏

## 功能范围

- 将 Extensions 从两行占位内容替换为应用级扩展管理器，不依赖 active session。
- 复刻原版标题、帮助说明、三点菜单、搜索框、更新栏、扩展列表和 Create Extension 卡片。
- 扩展项支持详情、安装、卸载、启用、禁用、更新、Local 标记和本地扩展重新加载。
- 复刻 Create Extension 对话框，支持 High Level Analyzer、Digital Measurement、Analog Measurement 模板。
- 桌面版可真实创建扩展目录，生成 `extension.json`、`README.md` 和 Python 入口文件。
- 桌面版可选择并读取本地 `extension.json`，浏览器预览可通过文件输入加载 manifest。
- 已安装且启用的 High-Level Analyzer 会进入 Analyzers 面板的可选列表。
- 扩展状态写入浏览器/WebView `localStorage`，重启 UI 后仍保留。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/Manager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/Extension.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/LocalExtension.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/MarketplaceExtension.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/ExtensionsList/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/ExtensionsList/SingleExtension.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/ExtensionsList/ExtensionMenu.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/ExtensionsList/CreatePlugin.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/AddExtensionDialog/DialogContent.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/ExtensionDetail/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/ExtensionDetail/LeftPanel.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/ExtensionDetail/ExtensionReadme.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/extensions/creators.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/panelsContent.tsx`

## 本地落点文件

- `src/components/ExtensionsPanel.tsx`
- `src/lib/extensions.ts`
- `src/lib/api.ts`
- `src/App.tsx`
- `src/styles.css`
- `src-tauri/src/main.rs`

## 复用方式

- 结构复刻：直接按原版 `ExtensionsSidebar -> ExtensionsList -> SingleExtension -> CreatePlugin` 层级组织。
- 状态规则搬运：沿用 Local / BuiltIn / Marketplace 来源、installed/enabled/update 状态和原版排序优先级。
- 行为搬运：复用原版搜索字段、菜单命令、详情开关、捕获时禁用编辑、Escape 关闭和 Local reload 规则。
- 模板算法搬运：按原版 `creators.ts` 生成 manifest、README、类型入口文件和默认作者/version/API version。
- 运行时适配：用 React state + `localStorage` 代替原版 MobX + Electron store；用 Tauri command 代替 Electron `fs`。
- 视觉常量复用：使用原版 16px sidebar padding、32px update bar、Local badge、三种几何图形颜色和 220px detail left panel。

## 用户可见行为

- 没有 session 时也能打开 Extensions，其他依赖 session 的按钮保持禁用。
- 搜索会匹配扩展名称、作者和描述。
- 右上菜单包含 Create New Extension、Load Existing Extension、Publish Extension、Check for Updates、Marketplace Terms。
- Marketplace 项可 Install/Uninstall，已安装项可 Enable/Disable，本地项可 Reload/Uninstall。
- 点击扩展项会打开原版式大面积详情页，显示版本、作者、README、feature 类型和 entry point。
- Create Extension 会生成三类扩展模板；新 HLA 会立即出现在 Analyzers selector。

## 验证方式

- `pnpm build`
- `cargo fmt --all -- --check`
- `cargo check -p pxlogic-desktop`
- 浏览器访问 `http://127.0.0.1:1420/`，在没有 session 时打开 `Extensions (N E)`。
- 验证侧栏宽度为 300px，搜索 `clock` 后只保留 Clock Statistics。
- 验证三点菜单五个命令全部出现。
- 安装 Saleae Measurements V2，确认 installed/enabled 状态写入 `localStorage`。
- 创建 `PXLogic Frame Inspector` HLA，确认列表、详情页和 Analyzers selector 都出现该名称。
- 浏览器控制台无 error/pageerror。

## 已知差距 / 后续任务

- Marketplace 当前复刻管理状态和 UI 行为，尚未接入 Saleae 在线 marketplace API、zip 下载与版本兼容检查。
- Python HLA/Measurement 执行器尚未搬入；本轮生成和加载的 manifest 已能进入管理器，HLA 名称可进入 analyzer selector。
- 详情 README 使用轻量本地渲染，尚未搬入原版完整 Markdown、远程图片和相对链接解析。
- 当前扩展持久化使用 `localStorage`；后续可迁移到独立 Tauri 配置文件并加入 schema migration。

## 对应 Git 提交

- `port: extensions sidebar`
