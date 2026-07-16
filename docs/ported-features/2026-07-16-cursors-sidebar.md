# Cursors 右侧栏

## 功能范围

- 复刻 Cursors 面板结构：Cursors On、x1/x2、Delta x、1/Delta x、y1/y2、Delta y 表格、Copy 按钮。
- 增加 session 级 cursor 状态，切换 session 不串状态。
- 在波形区增加 x1/x2 垂直 cursor overlay，可拖动并按当前 viewport 映射到 sample。
- 增加原版 `C` 快捷键切换 cursors，可见性仍遵循原版 MSO 规则。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/cursors/Settings.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/cursors/compositions/Cursors.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/cursors/compositions/Cursor.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/cursors/compositions/useCursorDrag.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/cursors/toggleSessionCursorsVisibility.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/shortcuts/keyBindings.ts`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`

## 复用方式

- 结构复刻：按原版 `Settings` 表格呈现 x/y cursor、delta 和 copy 行为。
- 行为复刻：`Cursors On` 开关、`C` 快捷键、x cursor 拖动。
- 算法适配：x cursor 使用 sample/sampleRate 计算时间、Delta x 和频率；拖动时用 viewport sample range 映射屏幕坐标。

## 用户可见行为

- 在 Cursors 可见的 session 中，右栏可打开/关闭 cursor。
- x1/x2 会显示在波形上方，可拖动改变样本位置。
- 表格实时显示 x1/x2、Delta x 和 1/Delta x。
- Copy 会复制当前 cursor 表格内容。

## 验证方式

- `pnpm build`
- 普通 Logic demo session 中 Cursors 入口按原版 MSO 可见性隐藏。

## 已知差距 / 后续任务

- 当前 y1/y2 仅保存数字通道绑定，尚未搬完整模拟电压计算和水平 cursor 线。
- Off-screen cursor indicators 尚未搬入。
- 当前 Cursors 仍遵循原版 MSO 可见性；若后续决定普通 Logic 也显示，需要单独改可见性策略并补浏览器验证。

## 对应 Git 提交

- `port: cursors sidebar`
