# 原版 Strip Chart 水平时间滚动条

## 功能范围

- 移除波形区底部独立的平移 range 与缩放 range。
- 搬入 Logic 2.4.43 的单 thumb `StripChartScrollBar`。
- thumb 宽度表示当前 viewport 占完整捕获的比例，thumb 位置表示 viewport 起点。
- 拖动 thumb 即时平移；点击轨道使用原版 300ms 平移动画。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRows/styles.module.css`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/stripChartScrollbar/index.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/stripChartScrollbar/ScrollBarRender.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/renderingManager/RenderingManager.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/constants.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/defaults.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/themes/builtin.ts`

## 本地落点文件

- `src/components/StripChartScrollbar.tsx`
- `src/App.tsx`
- `src/styles.css`
- `docs/FILE_MAP.md`

## 复用方式

- 结构搬运：复用原版 `GraphRows -> horizontalScrollBar -> StripChartScrollBar -> ScrollBarRender` 层级，滚动条从通道标签宽度之后开始并贴在底栏上方。
- 算法搬运：复用原版 `MIN_BAR_WIDTH=25`、`timeToPixel` 和 `pixelToTime`。thumb 宽度为 `viewportSamples / totalSamples * graphWidth`，位置在扣除 thumb 后的剩余轨道宽度中换算。
- 尺寸搬运：复用 `STRIPCHART_SCROLLBAR_HEIGHT_PX=10`、thumb 高 `8px`、顶部 `1px`。
- 色彩搬运：轨道使用 DarkTheme `background-10=#1B1B1C`；thumb 使用 `on-background-40=#4A4A4B` 的 0.8 默认透明度、1.0 hover 与 0.9 dragging 状态。
- 动画搬运：轨道点击复用 `PANNING_ANIMATION_DURATION=300ms`；拖拽路径不添加动画，保证鼠标与 thumb 实时同步。

## 用户可见行为

- 底部只显示一条与纵向滚动条同类的水平时间滚动条，不再出现两个浏览器 range 控件。
- 放大波形后 thumb 变短，缩小时变长；Fit Capture 时 thumb 填满轨道。
- 拖动 thumb 只左右移动当前时间窗口，不改变缩放比例。
- 点击 thumb 外的轨道区域会平滑移动到目标时间位置。
- 极高缩放时 thumb 保持至少 25px，仍然可以可靠抓取。

## 验证方式

- `pnpm build`
- 1440x900 浏览器验证：轨道 `x=184, height=10`，thumb `height=8`，滚动条下边缘与 BottomBar 上边缘均为 `y=860`。
- 250k 样本捕获显示 100k 时，1209px 轨道对应 484px thumb；显示 50k 时对应 242px thumb。
- 拖动 thumb 300px 后，viewport 起点从 25,000 变为 87,048，`aria-valuemax=200,000` 保持不变，确认缩放比例未改变。
- 轨道点击动画观测：起点从 87,048 经约 90ms 的 161,973 平滑到 300ms 后的 200,000。
- Fit Capture 验证：thumb 与轨道同为 1209px，起点和最大平移量均为 0。
- 连续放大验证：理论宽度小于 25px 时，实际 thumb 保持 25px。
- `.horizontalScrollBar` 内 `input[type=range]` 数量为 0，浏览器控制台无错误。

## 已知差距 / 后续任务

- 原版连续采集还支持 `LatestData` follow mode，此时 thumb 会固定在最右侧。PXLogic 当前只有固定长度 Buffer/Stream 捕获模型，待真实 streaming viewport 搬运时补充该状态。
- 当前时间范围从样本 0 开始；原版 `displayableInterval` 可包含裁剪后范围和负时间。后续搬运 trigger-relative time zero 与 Trim 时需将滚动条输入升级为显式 begin/end interval。

## 对应 Git 提交

- `port: strip chart horizontal scrollbar`
