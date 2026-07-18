# Range Measurement Tooltip 视觉补齐

## 功能范围

- Range measurement 新建颜色改回原版默认 `fuchsia`，不再按序自动轮换。
- 主图 measurement tooltip 显示完整默认数字测量项：
  - `Delta T`
  - Time: Frequency、Period、Width 1、Width 0、Duty 1、Duty 0
  - Digital: Maximum Frequency、Average Frequency、Minimum Frequency、No. Falling Edges、No. Rising Edges、Period Std. Deviation
- 测量标签改为原版 `MeasurementLabel` 风格的 HTML/math notation 渲染。
- Tooltip 视觉拆成原版两段：
  - 上方灰色统计区域
  - 下方深色 Comment / color / delete 区域
- Comment 继续保存在 `UiRangeMeasurement.note`，tooltip 输入后右侧 Measurements 列表实时展示备注预览。
- 新增 `SaleaeIcon` 小图标组件，复用原版 SVG path，替换当前 range tooltip 和 Measurements 列表里的 Lucide / 文本符号。
- 右侧 Measurements RangeItem 补齐原版 arrow-head expand、8px swatch、arrow、goto、vertical-three-dots 控件外观。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeTooltip.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/MeasurementValue.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/labels.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/RangeItem.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/SidebarMenu/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/addMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/addMenu/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/settingsMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/settingsMenu/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/defaults.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/utils/colors.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/arrow.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/arrow-head.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/checkmark.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/copy.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/cross.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/gear.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/goto.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/minus.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/plus.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/trash.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/vertical-three-dots.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Switch.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/SwitchStyles.module.css`

## 本地落点文件

- `src/App.tsx`
- `src/styles.css`
- `src/lib/rangeMeasurements.ts`
- `src/components/SaleaeIcon.tsx`

## 复用方式

- 资源复用：将原版 range tooltip / sidebar 所需的小 SVG path 搬入 `SaleaeIcon`，集中给 tooltip、AddMenu、SettingsMenu 和 Measurements RangeItem 使用。
- 结构复刻：按原版 `RangeTooltip` 的 470px 面板、两列 measurement grid、顶部 drag 操作区、底部 comment/color/delete 区重排本地 DOM。
- 状态规则复刻：保留原版“默认颜色 fuchsia，不主动自动切换；颜色只由用户在 tooltip 里点击 swatch 修改”的规则。
- 视觉常量复用：复用原版 `rangeColors` 顺序和 hsl 值、18px color square、8px sidebar swatch、340px AddMenu、289px SettingsMenu、36x20 Switch。
- 数据层复用：延续 `rangeMeasurements.ts` 的真实 backend stats 映射，本轮增加 `labelHtml` 和 3 significant digits 的展示规则。

## 用户可见行为

- 连续添加多个 Range Measurement 时，默认都是 fuchsia，只有手动点击 tooltip 内颜色块才改变颜色。
- Tooltip 统计区域显示 `Delta T + 12` 个默认数字属性，并使用 `f`、`T`、`t_high`、`f_max`、`sigma_T` 等 HTML/math 风格标签。
- Tooltip 上半部分是灰色统计面板，下半部分是深色 comment/color/delete 操作区。
- 在 tooltip 的 `Comment here` 输入内容后，右侧 Measurements 行立即显示备注预览。
- Tooltip 和右侧 Measurements 列表使用从原版 icon 文件搬来的 plus、minus、gear、copy、trash、arrow、goto、three dots 等图标。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- `cargo test -p pxlogic-waveform`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 选择 demo device 后确认仍显示 `No samples`，不会自动开始采集。
  - 手动 Start/Stop 后，Add Range Measurement 可用。
  - 拖动划定 range 后，主图 tooltip 出现并显示 `Delta T + 12` 项默认统计。
  - 连续添加两个 range，两个 `rangeBand` 的 `--range-color` 都是 `hsl(334, 58%, 53%)`。
  - Tooltip comment 输入后，右侧 Measurements 的 `rangeCommentPreview` 立即同步显示备注。

## 已知差距 / 后续任务

- HTML/math label 由本地可信常量映射实现。原版 measurement package 里的完整 metadata 没有在 recovered UI source 中出现，后续若恢复 native package metadata，可进一步替换为原始 labels。
- Tooltip 的 pending/error 显示仍是本地 lightweight 文本，不包含原版 `Loader` 组件动画。

## 对应 Git 提交

- `port: polish range measurement tooltip`
