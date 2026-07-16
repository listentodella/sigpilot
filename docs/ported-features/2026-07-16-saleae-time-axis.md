# Saleae 双层时间轴

## 功能范围

- 修复缩放或平移后多个刻度错误显示为同一时间的问题。
- 恢复原版“基准时间 + 相对 offset”双层时间标签。
- 恢复每 10 个相对刻度进入下一个基准时间段的分组规则。
- 恢复 major / minor 刻度对应的两级竖直虚线。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/utils/timingDisplay.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/ConnectedTimingDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/TimingDisplay.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/TimingDisplay/drawTick.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GridLines.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/shared/utils/compareApprox.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/shared/utils/getFriendlyDegree.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/shared/utils/getMetricPrefixByDegree.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/shared/utils/getPrefixForDegree.ts`

## 本地落点文件

- `src/lib/saleaeTimingDisplay.ts`
- `src/components/WaveformCanvas.tsx`
- `src/styles.css`
- `package.json`
- `pnpm-lock.yaml`

## 复用方式

- 直接搬运原版 `getRawTicks`、`getTicksSpan`、`getHorizontalGraphTicks`、major/minor 标签格式和 metric prefix 规则。
- 引入原版使用的 `decimal.js`，保留高精度 modulo，避免普通 JavaScript 浮点余数导致刻度归组错误。
- 绘制位置复用原版 `drawTick.ts`：major 标签位于 30px 标尺中线，minor offset 位于底部。
- 网格线复用原版 `GridLines.tsx`：major 和 minor 刻度都向下绘制虚线，颜色级别不同。
- 移除原版 MobX、主题 hooks、canvas helper 和缓存包装，但不改变刻度计算行为。

## 用户可见行为

- 10ms 量级视图中显示 `0 s` 基准，以及 `+1 ms`、`+2 ms` 等连续 offset。
- 平移到非零位置时，offset 仍按其所属 major 基准计算，不会全部显示成当前左边缘时间。
- 放大后自动切换到 us/ns/ps；缩小后自动切换到 s/ks 等原版单位分组。
- 每个可见 offset 都有对应竖直虚线，major 虚线使用更低层级背景色。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm build`
- 浏览器打开 `http://127.0.0.1:1420/`，载入 Demo capture。
- 验证标尺同时显示 `0 s` 与 `+1 ms`、`+2 ms`、`+3 ms`、`+4 ms`，且每个数值不同。
- 验证 offset 标签和向下虚线处于同一 x 坐标。

## 已知差距 / 后续任务

- wall-clock、trigger-relative 和自定义 time-zero 模式尚未接入当前 session 模型。
- 当前沿用本地深色主题值，未搬入原版完整主题切换系统。

## 对应 Git 提交

- `fix: port Saleae timing display algorithm`
