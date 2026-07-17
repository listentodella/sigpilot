# Range Measurement Runner 与 Add/Remove Measurements

## 功能范围

- 将 range measurement 指标从当前 viewport tile 估算，改为对当前 capture 的指定 channel/range 做真实统计。
- 新增 Tauri 命令 `measure_digital_range`，返回 range 内的 duration、high/low samples、rising/falling edges、pulse width、period、frequency、duty 和 period std dev。
- 右侧 Measurements 面板和图上 tooltip 共用同一套 measurement ids、默认列表、格式化和 copy 输出。
- 搬运 Measurements2 风格 Add/Remove Measurements：
  - 每个 range 默认启用全部内置数字 range measurements。
  - `+` 菜单支持 Search、All、Clear、逐项 Add/Remove、Install More Measurements。
  - gear 菜单支持 `Display Annotations` 状态，先保留为 range 级真实设置。
- range 展开表格支持逐项删除，Clear 后允许只保留 `Delta T`，不会自动恢复默认项。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/store.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/runner.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/addMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/settingsMenu/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/measurements2/sidebar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/advancedMeasurements/ChannelRanges/RangeTooltip.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/Measurements2/useAddMeasurement2Panel.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/Measurements2/utils.ts`

## 本地落点文件

- `src/App.tsx`
- `src/lib/api.ts`
- `src/lib/rangeMeasurements.ts`
- `src/styles.css`
- `src-tauri/src/main.rs`
- `crates/pxlogic-waveform/src/lib.rs`

## 复用方式

- 状态结构：对照原版 `MeasurementsDataSourceBase` / `Range`，给每个 `UiRangeMeasurement` 增加 `measurements`、`annotationsVisible`、runner result/error/busy/key 字段。
- Runner 结构：对照原版 `RangeRunner` 观察 range 边界变化后发起测量请求；当前用 Tauri command 替代 Saleae graph native node。
- Measurement 列表：对照 `useAddMeasurement2Panel` 的 Time/Digital 分类和 `clockStatisticsMeasurementsToPartialExtensionMeasure` 文案，建立本地内置数字 measurement ids。
- AddMenu：对照 `measurements2/addMenu` 搬入 Search、All、Clear、逐项加减和 Install More Measurements 结构。
- 数值格式：对照原版 `BaseMeasure.formattedValue` 的三位/metric prefix 风格，前端集中格式化 Hz、s、% 和 count。
- 算法适配：由于原版 `@saleae/graph-interface.node` 不能直接运行在 Tauri 内，本地在 `pxlogic-waveform` 中实现等价数字 range scanner。

## 用户可见行为

- 创建 range 后，右栏和 tooltip 会先显示 pending，然后更新为当前 capture/range 的真实统计值。
- range 在当前画面外或比当前 tile 更大时，统计不再依赖画面 tile，因此不会显示旧的占位/失真值。
- `+` 菜单可以按原版方式启用/移除 Frequency、Period、Width 1/0、Duty 1/0、Max/Avg/Min Frequency、Rising/Falling Edges、Period Std Dev。
- `Clear` 后表格只保留 `Delta T`；`All` 会恢复 12 个默认数字测量项。
- `Copy` 会复制 `Delta T` 和当前启用且有效的测量项。

## 验证方式

- `cargo test -p pxlogic-waveform`
- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH" pnpm build`
- 浏览器访问 `http://127.0.0.1:1420/`：
  - 启动页选择 demo device，确认未自动采集。
  - Start 后停止，Add Range Measurement 在 D1 行拖拽创建 range。
  - 右栏 range 表格和 tooltip 显示真实 `Delta T / Duty / Width / Edges`，没有 console error。
  - 打开 `+` 菜单，确认 12 个默认项启用。
  - 点 `Clear` 后只剩 `Delta T`；点 `All` 后 12 项恢复。

## 已知差距 / 后续任务

- 原版完整 Measurements2 extension runner、Python extension measurer 和 annotation renderer 尚未搬入；当前实现覆盖内置数字 range measurements。
- `Display Annotations` 已作为 range 级状态保存，但数字内置测量项暂未渲染图上 annotation。
- 当前 digital scanner 逐样本统计，普通 demo/USB capture 足够；超大多 range 并发时后续可引入边沿索引缓存。

## 对应 Git 提交

- `port: implement range measurement runner`
