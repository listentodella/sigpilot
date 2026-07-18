# Range Measurement 右侧栏细节收尾

## 功能范围

- 新增的 range measurement 默认折叠，不再展开默认 measurement 明细。
- 右侧 measurement 明细里的 falling / rising edge 计数改回原版可读文本。
- 右侧每个 range item 末尾的 goto / menu 图标按原版 `IconButton` 风格收紧尺寸和默认颜色。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/RangeItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/sidebar/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Button.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/store.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/store.ts`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`
- `src/lib/rangeMeasurements.ts`

## 复用方式

- 状态规则复刻：range 新建时 `expanded` 默认值改回 `false`。
- 文案复用：`No. Falling Edges` / `No. Rising Edges` 改为原版可读文本顺序和写法。
- 视觉常量复用：goto 使用 `size=10`、menu 使用 `size=14`，并采用 `on-background-20` 默认色与 `on-background-0` hover 色。

## 用户可见行为

- 新建 Range Measurement 后，右侧条目默认是折叠的，只显示摘要行。
- 展开后能看到可读的数字统计项，不再出现 `N↓` / `N↑` 这种符号化标签。
- 右侧 goto / menu 控件比之前更接近原版，默认更容易被识别。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 新建 range measurement 后，`.rangeMeasurementItem` 默认没有展开明细。
  - 展开后，`No. Falling Edges` / `No. Rising Edges` 文案可见。
  - goto / menu 图标尺寸和默认色对比前一版更接近原版。

## 已知差距 / 后续任务

- 当前仍使用本地 React 结构，不是原版 `IconButton` 的完整组件树；如果后续要继续抠像，可以再把 icon wrapper 迁成完整的原版 button 结构。

## 对应 Git 提交

- `port: refine range measurement sidebar parity`
