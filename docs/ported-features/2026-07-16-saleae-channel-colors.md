# Saleae Legacy 通道色板

## 功能范围

- 修正 Devices 面板数字通道按钮颜色重复过密的问题。
- 左侧通道标签和波形颜色同步使用同一套通道色。
- 将本地 4 色 MSO 映射改为原版 legacy 8 色映射。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/themes/builtin.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/themes/colorHelpers.ts`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/elements/ChannelPicker.tsx`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/uikit/utils/colors.ts`

## 本地落点文件

- `src/lib/saleaeChannelColors.ts`
- `src/App.tsx`
- `src/components/WaveformCanvas.tsx`
- `src/styles.css`

## 复用方式

- 直接搬运原版 `DarkTheme` 中 `channel-legacy-0..7` 的 8 个颜色值。
- 复用原版 `getChannelLabelColorTheme` 的 legacy 通道规则：`deviceChannel % 8`。
- Devices 通道按钮、左侧通道 badge、波形画布都改为从同一个 `saleaeLegacyChannelColor()` 取色。
- 保留原版 ChannelPicker 语义：未启用时只显示通道色文字/边框，启用时填充通道色。

## 用户可见行为

- D0-D7 颜色分别为灰、棕、红、橙、黄、绿、蓝、紫。
- D8-D15 按原版 legacy 规则循环复用 D0-D7 色板。
- Devices 面板、左侧通道标签、波形颜色保持一致。

## 验证方式

- `PATH="/Users/leo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm build`
- 浏览器打开 `http://127.0.0.1:1420/`，载入 Demo capture。
- 检查前 16 个 `.channelHeader` 背景色，确认 unique 色值为 8 个。

## 已知差距 / 后续任务

- 当前实现的是 Logic legacy 通道色板；MSO 专属端口色和探头色仍留待后续硬件类型模型接入。

## 对应 Git 提交

- `fix: port Saleae legacy channel colors`
