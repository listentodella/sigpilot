# Saleae / Sigrok Native I2S

## 功能范围

- 在 Saleae Native 和 Sigrok Native 两个后端中接入 I2S / PCM。
- 复用原版 Saleae I2S 插件和 PXView `libsigrokdecode` 的 `i2s_c` decoder。
- 支持 packed PXLogic capture、稀疏 `.sal` transition capture 和 64 位 sample index。
- `.sal` 中保存的 I2S / PCM analyzer 配置会自动恢复为 Saleae Native。
- 前端按原版顺序提供 I2S 通道和格式设置；I2S 不进入 Legacy Rust catalog。

## 复用来源

- Logic 2.4.43 macOS arm64：
  - `libi2s_analyzer.so`
  - 原版 analyzer setting interface、bubble text 和 FrameV2 输出。
- Saleae Analyzer SDK commit `16a9ebff783614691781a8cd69d733abc8c8c722` test harness。
- `pxview-fork/libsigrokdecode/c_decoders/i2s_c.c`：
  - SCK / WS / SD transition state machine。
  - `ws_polarity`、`clk_edge`、`bit_shift`、`bit_align`、`bitorder`、`wordsize` 设置。
- `.app-data` 中 Logic 2.4.43 的 analyzer 设置顺序和前端展示规则。

## 本地落点

- `native/saleae-analyzer-sidecar/`
  - 加载并校验原版 `libi2s_analyzer.so`，配置原版 setting interface，保留 bubble 与 channel 字段。
- `native/sigrok-analyzer-sidecar/`
  - 构建并加载 PXView `i2s_c`，将 Left / Right annotation 和 binary output 归一化为 `DecoderOutput`。
- `crates/pxlogic-core/src/decode.rs`
  - 新增协议无关的 `NativeDecodeSettings`，承载外部 decoder 的通道与 option map。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - 通用 native transition request、结果归一化以及 packed/sparse I2S sidecar tests。
- `crates/pxlogic-file/src/lib.rs`
  - 将 `.sal` 原版 I2S settings 恢复为通用 Native contract。
- `src/lib/analyzers.ts`、`src/components/AnalyzerSettingsDialog.tsx`
  - Saleae/Sigrok I2S catalog、原版顺序设置项和 session restore。
- `testdata/decoders/sigrok-native-conformance-v1.json`
  - 16-bit Left `0x1234` / Right `0x5678` transition fixture。

## 架构边界

- 没有新增 Rust I2S decoder、协议状态机或 I2S Demo waveform generator。
- Rust 只负责 transition/configuration 传输、sidecar 生命周期和结果归一化。
- `LegacyRust` 是迁移期兼容后端，不再接收新协议；Saleae Native 与 Sigrok Native 覆盖成熟后从 catalog 移除并最终删除。

## 用户可见行为

- Add Analyzer 中的 Saleae Native 与 Sigrok Native 分组都提供 I2S。
- 设置面板按原版顺序显示 CLOCK、FRAME、DATA、bit order、clock edge、bit depth、frame transition、alignment、shift、signed 和 WS polarity。
- Saleae 支持 2-64 bit，Sigrok/PXView `i2s_c` 支持 2-32 bit。
- DATA 通道显示 Left / Right 解码气泡；Data Table 保留声道和值。
- 导入含 I2S / PCM analyzer 的 `.sal` 后，原通道和格式配置自动恢复并使用 Saleae Native 重算。

## 验证

```sh
cargo test --workspace --no-fail-fast
pnpm build
native/saleae-analyzer-sidecar/verify.sh \
  /Volumes/tp7100s/Downloads/Logic-2.4.43-macos-arm64.zip
native/sigrok-analyzer-sidecar/verify.sh
```

- Saleae 原版 I2S / PCM 插件解出 Ch 1 `0x1234`、Ch 2 `0x5678`。
- PXView `i2s_c` 解出 Left `0x1234`、Right `0x5678`。
- 两个 native backend 都覆盖 packed 和 490 亿 sample 偏移的 sparse fixture。
- `.sal` 单测覆盖所有 I2S setting 的枚举值映射。

## 已知边界

- 当前没有生产用的 I2S Demo mock；Demo 采集不会伪造与 analyzer 配置匹配的 I2S 数据。
- Saleae 插件依赖固定 Logic 2.4.43 ABI 和本地安装包，不提交原版二进制。
- 本批只完成 I2S；不能视为 Saleae 或 Sigrok analyzer catalog 已全部接入。

## 对应提交

- `port: add saleae and sigrok i2s`
