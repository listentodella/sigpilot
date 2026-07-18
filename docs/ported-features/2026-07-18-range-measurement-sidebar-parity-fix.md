# Range Measurement 侧栏原版状态修正

## 功能范围

- 修正右侧 Measurements 面板里 range item 的默认、hover、selected 背景色。
- 修正 range item 右侧 goto / menu 操作按钮的默认可见状态。
- 修正 falling / rising edge 统计在明细表中的原版数学标签。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/sidebar/defaults.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/sidebar/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/Measurements2/utils.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/runner.ts`

## 本地落点文件

- `src/lib/rangeMeasurements.ts`
- `src/styles.css`

## 复用方式

- 背景状态复用原版 `ITEM_DEFAULT_COLOR / ITEM_HOVER_COLOR / ITEM_SELECTED_COLOR` 规则：
  - default: `var(--background-10)`
  - hover: `var(--background-0)`
  - selected: `var(--hover-background)`
- action 区域复用原版 `rangeActions` 常显行为，不再仅 hover 时出现。
- 明细表 label 复用原版 measurement runner 允许的 HTML 标签范围，将 edge count 展示为 `N` 加文字下标。

## 用户可见行为

- 选中 range item 后不再显示蓝色整行背景。
- goto / menu 按钮默认就能辨认，hover 时仍会提亮。
- 展开明细后，edge 统计显示为 `N_falling` / `N_rising` 风格，不再显示整句或箭头符号。

## 验证方式

- `pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 新增 range measurement 后右侧 item 默认收起。
  - 点击 item 后背景为原版暗色 selected 状态，而不是蓝色。
  - 展开明细后 falling / rising edge 统计为 `N` 加文字下标。
  - item 右侧 goto / menu 按钮在非 hover 状态下也可见。
