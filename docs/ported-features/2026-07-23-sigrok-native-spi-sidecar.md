# Sigrok Native SPI sidecar

## 功能范围

在 Tauri 进程外托管 PXView 的 `libsigrokdecode` fork 和原生 `spi_c` decoder，通过统一 `DecoderOutput` 返回 SPI frames、channel values、annotations 与 diagnostics。

## 原版参考路径

- `pxview-fork/PXView/pv/data/decoderstack.cpp`
- `pxview-fork/libsigrokdecode/session.c`
- `pxview-fork/libsigrokdecode/instance.c`
- `pxview-fork/libsigrokdecode/c_decoder_api.c`
- `pxview-fork/libsigrokdecode/c_decoders/spi_c.c`
- `pxview-fork/libsigrokdecode/tests/decoder_test.c`

## 本地落点

- `native/sigrok-analyzer-sidecar/CMakeLists.txt`
  - 直接构建 PXView libsigrokdecode 源码和 `spi_c` module。
- `native/sigrok-analyzer-sidecar/src/main.c`
  - request/channel/options mapping、annotation/binary collector 和 `DecoderOutput` JSON。
- `native/sigrok-analyzer-sidecar/build.sh`
- `native/sigrok-analyzer-sidecar/verify.sh`
- `crates/pxlogic-core/src/decoder_backend.rs`
  - `SigrokNativeDecoder` 进程 adapter 与 workspace 自动发现。

## 复用方式

- 协议状态机直接使用 PXView `spi_c.c`，没有在 Rust 中重写 SPI。
- sidecar 复用 libsigrokdecode 的 channel mapping、samplerate metadata、output callback 和 C decoder lifecycle。
- GPL 代码保持在独立 sidecar executable 边界，并保留 `native/sigrok-analyzer-sidecar/LICENSE`。

## 用户可见行为

- Analyzer 可选择 `Sigrok Native (PXView)` SPI backend。
- 支持 CPOL 0/1、CPHA 0/1、MSB/LSB-first、CS polarity、1-64 bit word size（当前 UI 主要使用 8 bit）。
- 输出继续进入现有 analyzer bubble、Data Table 和 channel role track。

## 验证方式

```sh
native/sigrok-analyzer-sidecar/verify.sh

PXLOGIC_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/pxlogic-sigrok-sidecar" \
PXLOGIC_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders" \
  cargo test -p pxlogic-core sigrok_native_sidecar -- --ignored
```

Mode 0-3、LSB-first、CS partial-word fixtures 全部通过；稀疏 490 亿 sample fixture 也通过。

## 已知差距 / 后续任务

- 当前 catalog 只构建 `spi_c`，还未暴露 PXView 全部 C/Python decoder。
- Python decoder stack 暂未接入 transition-indexed sparse runtime。
- backend availability 还没有独立 Tauri probe 面板。
- 当前工作树尚未创建独立 Git commit。
