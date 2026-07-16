# UI 骨架基线

## 功能范围

这是开始搬运真实功能前的第一个基线版本。它记录当前已经完成的 Saleae 风格可运行骨架：

- 启动页设备选择。
- 顶部工具栏。
- 多 session 底栏和新建 session 设备选择 popover。
- 右侧 47px icon rail 和 300px panel。
- 数字波形 Canvas 渲染、缩放、hover 边沿测量。
- UART analyzer 面板与 decode 入口。
- `.pxcap` 打开、保存、导出入口。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/BottomBar.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/tabs/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/DeviceManagement/DevicesMenuControlled.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/PanelSwitchers.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/icons/*.svg`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/DigitalCanvas.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/useHoveredDataMouseTracking.ts`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`
- `src/components/DeviceStartScreen.tsx`
- `src/components/LogicToolbar.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/lib/api.ts`
- `src/lib/format.ts`
- `src/assets/saleae/logicDarkTheme.png`
- `src/assets/saleae/logicMsoDarkTheme.png`
- `src/assets/saleae/sidebar/*.svg`

## 复用方式

- 直接复用：启动页设备图、右侧栏 SVG icon。
- 结构复刻：顶部工具栏、底栏 tabs、设备菜单 popover、右侧 sidebar/panel 布局。
- 状态规则复刻：多 session 暂存、当前 session 捕获状态、捕获中禁止关闭 tab、新 session 设备选择。
- 算法复刻/适配：数字波形平滑绘制、边沿吸附、hover 测量。
- 暂未整体搬入：Saleae 原工程的 MobX store、uikit、自动化服务器、完整 analyzer 数据库。

## 用户可见行为

- 打开应用时先选择真实设备或 demo device。
- 捕获后出现 session tab，旧捕获可暂存。
- 底栏 `+` 始终位于最后一个 session tab 右侧，点击后在原地弹出设备选择。
- 右侧栏使用 Saleae 原版 sidebar icon。
- hover 靠近上升沿或下降沿时，会显示脉宽、周期、Duty、Freq、width-1 等测量信息。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`
- 验证启动页、demo capture、session 切换、新建 session popover、右侧栏 icon、缩放与 hover 测量。

## 已知差距 / 后续任务

- 右侧各 panel 仍是骨架，后续要逐个搬入真实功能。
- 后端 capture 当前仍偏全局，前端多 session 已能暂存已加载 tile/summary，但长期需要后端 per-session capture handle。
- analyzer 目前只有 UART 路径，尚未搬入完整 Saleae analyzer 列表和配置流。
- marker / range measurement 目前有入口和计数，尚未完整实现原版交互层。

## 对应 Git 提交

- `c220332` (`chore: initialize pxlogic workspace baseline`)
