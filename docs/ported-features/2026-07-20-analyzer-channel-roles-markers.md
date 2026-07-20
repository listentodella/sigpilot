# Analyzer 通道角色、分轨气泡与时钟 Marker

## 功能范围

- Analyzer 结果从单一 `label/value` 扩展为结构化 `channel_values`，保留表格完整文本，同时给每个协议引脚提供独立短气泡文本。
- 左侧通道名称下方显示原版风格的 analyzer 通道角色，例如 `I2C [1] - SDA`、`SPI [1] - Clock`。
- I2C 气泡只显示 SDA 上的简洁文本，例如 `0x50 W`、`0x2A`。
- SPI MOSI/MISO 解码气泡分别渲染在对应数据通道上，不再挤在同一条 analyzer strip。
- I2C SCL 与 SPI Clock 根据有效采样边沿显示原版 `markerUpArrow` / `markerDownArrow` 标记。
- Analyzer 设置弹窗的通道选择控件从原生 select 改为原版 `ChannelSetting` 风格：颜色色块、通道名称、`(empty)` 标记和 `Disabled Channels` 分组。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzerManager.tsx`
  - `getChannelName`：多通道 analyzer 在通道下显示 `${customName} - ${channelName}`。
  - `channelsWithBubbles` / `channelsWithMarkers`：由 analyzer 状态决定气泡和 marker 分别绘制在哪些通道上。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzerStripchartData/index.tsx`
  - 同一 analyzer 在每个 channel row 分别挂载 `Bubbles` 与 `MarkersRender`。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzerStripchartData/Markers.tsx`
  - marker 绝对定位、水平 `translate(-50%)`，并可匹配通道颜色。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/marker-up-arrow.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/Icon/marker-down-arrow.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzerSettings/ChannelSetting.tsx`
  - 通道下拉选项使用 `RowIdentifier`，包含通道颜色与 `Disabled Channels` 分组。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/compositions/AnalyzerSettings/SingleSettingWrapper.tsx`
  - 设置项 120px label 列、12px 间距和 4px 行 padding。

## 实现落点

- `crates/pxlogic-core/src/decode.rs`
  - 新增 `DecodedChannelValue`，UART/I2C/SPI decoder 生成每个协议角色的短标签。
  - I2C 地址气泡为 `0xNN W/R`，Data 气泡为 `0xNN`。
  - SPI 同帧保留 MOSI/MISO 两个 channel value。
- `src/lib/api.ts`
  - TypeScript API 和 Preview analyzer frames 同步 `channel_values`。
- `src/lib/analyzers.ts`
  - 新增 `analyzerChannelRoles`、`analyzerBubbleRoles`、`analyzerMarkerRoles`、`analyzerChannelRoleLabel`。
  - `analyzerStripInsetForChannel` 改为按实际 bubble roles 计算每个通道的 analyzer 顶部 inset。
- `src/components/AnalyzerBubblesOverlay.tsx`
  - 由单 analyzer 主通道渲染改为按 role 展开 bubble tracks。
  - marker tracks 使用当前 waveform tile 的 `rising_edges` / `falling_edges` 做可视区投影。
- `src/components/AnalyzerSettingsDialog.tsx`
  - 通道选择控件复刻原版颜色标识、分组和 `(empty)` 行为。
  - Additional Settings 文本同步为 `Show in protocol results table` / `Stream to terminal`。
- `src/components/SaleaeIcon.tsx`
  - 直接搬运原版 marker up/down SVG 路径和 9x6 尺寸。
- `src/App.tsx`
  - 左侧通道副标题按 analyzer roles 展示，不再仅显示主 analyzer 名称。
- `src/styles.css`
  - 新增 analyzer marker layer 与 channel dropdown 的原版深色菜单样式。

## 用户可见行为

- 添加 I2C 后，D1 下显示 `I2C [n] - SDA`，D2 下显示 `I2C [n] - SCL`。
- 添加 SPI 后，MOSI/MISO/Clock/Enable 分别显示在对应通道名下，MOSI/MISO 数据气泡分别位于对应通道顶部。
- 放大到可见时钟边沿后，SCL/Clock 通道显示与有效采样边沿对应的上/下箭头。
- Analyzer 设置里选择通道时可以直接通过 Saleae legacy 通道颜色区分 D0-D31，并能看到捕获后未包含的 `(empty)` 通道。

## 验证方式

- `cargo test --workspace --no-default-features`
- `pnpm build`
- 浏览器验证：Demo capture 后添加 I2C/SPI analyzer，确认左侧通道角色、分通道气泡、Clock/SCL marker 与设置弹窗通道色块。

## 已知差距 / 后续任务

- marker 目前依赖当前 waveform tile 的 exact edge 列表；极大缩放全局视图下会自动限量，原版则由 Graph Server 返回专门的 marker result。
- Analyzer 设置字段顺序仍由本地内置 I2C/SPI/UART 设置模型定义，后续如引入原版 analyzer registry，可直接复用原版 settings 数组。
- 完整 LLA/HLA runtime、协议结果表模板和 analyzer trigger backend 尚未搬入。

## 对应 Git 提交

- 待提交。
