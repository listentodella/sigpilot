# Sigrok Native UART/I2C 与两级 Analyzer catalog

## 目标

- 不再扩张自有 Rust 协议实现，把 Async Serial、I2C、SPI 的主路径迁移到 PXView/libsigrokdecode。
- 顶部工具栏与右侧 Analyzers 面板明确区分 Saleae Native、Sigrok Native 和 Compatibility 来源。
- packed 捕获与 `.sal` sparse transition 捕获使用同一 native decoder，不把长捕获展开为逐采样数组。

## 复用来源

- `pxview-fork/libsigrokdecode/c_decoders/uart_c.c`
- `pxview-fork/libsigrokdecode/c_decoders/i2c_c.c`
- `pxview-fork/libsigrokdecode/c_decoders/spi_c.c`
- `pxview-fork/libsigrokdecode/session.c`
- `pxview-fork/libsigrokdecode/c_decoder_api.c`

UART/I2C 状态机、wait 条件、采样点、annotation 和 binary output 均直接来自 PXView C decoder。PXLogic 只提供 transition-indexed `srd_decoder_runtime`、通道/参数映射和统一 `DecoderOutput` 适配。

## 本地落点

- `native/sigrok-analyzer-sidecar/CMakeLists.txt`
  - 同时构建 `uart_c`、`i2c_c`、`spi_c` module。
- `native/sigrok-analyzer-sidecar/src/main.c`
  - 按 `decoder.protocol` 分派 decoder，映射 UART/I2C/SPI channels/options，并归一化 binary/annotation 输出。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - `SigrokSidecarRequest` 支持三种协议；packed/sparse 输入只提取 decoder 使用的通道。
- `src/components/AnalyzerLibraryMenu.tsx`
  - 顶部和右侧共用“来源 -> 协议”两栏菜单。
- `src/lib/analyzers.ts`
  - Async Serial/I2C 默认优先 Sigrok Native，Legacy Rust 保留为 Compatibility fallback。

## 用户可见行为

- Saleae Native 当前显示 SPI。
- Sigrok Native (PXView) 显示 Async Serial、I2C、SPI。
- Compatibility 保留原有协议，便于旧 capture 与迁移期回退。
- Analyzer Settings 可在支持的 backend 之间切换；从通道右键新增 Async Serial 时默认使用 Sigrok Native。

## 验证

```sh
native/sigrok-analyzer-sidecar/verify.sh

PXLOGIC_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/pxlogic-sigrok-sidecar" \
PXLOGIC_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders" \
  cargo test -p pxlogic-core decoder_backend::tests::sigrok -- --include-ignored

pnpm build
```

覆盖结果：

- UART 8N1 RX `0xA5`：packed 与 sparse 通过。
- I2C write address `0x50` + data `0xA5`：packed 与 sparse 通过。
- SPI Mode 0-3、MSB/LSB、CS partial-word：继续通过。
- UART/I2C/SPI 的 490 亿 sample transition index：全部保留 `u64` 并通过。
- Playwright 验证顶部菜单来源切换、Sigrok 三协议列表和 I2C backend 配置。

## 后续

- 当前接入的是 PXView 三个 native C decoder；完整 Python decoder catalog、stacked decoder 和 streaming lifecycle 仍需后续目标。
- Saleae Native 目前仍只接通 SPI。
- Logic 2 `.sal` 原生序列化导出与回读已在 `2026-07-24-saleae-sal-native-export.md` 完成。
