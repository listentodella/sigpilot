# Decoder backend migration baseline

## 功能范围

- 正式停止扩张自有 Rust 协议解码器，将其标记为迁移期 `LegacyRustDecoder`。
- 建立 `Saleae Native / Sigrok Native / Legacy Rust` 统一 backend 契约。
- 新结果模型支持多行 annotation、多个缩放文本候选、typed fields、marker、warning 和 error。
- 新增跨 backend SPI 夹具，覆盖 Mode 0-3、MSB/LSB 和 CS 在采样边沿之间切换的事务边界。

## 原版与生态参考

- Saleae Logic 2.4.43 安装包：
  - `Contents/Resources/macos-arm64/libAnalyzer.dylib`
  - `Contents/Resources/macos-arm64/Analyzers/libspi_analyzer.so`
  - SPI plugin 的 `CreateAnalyzer/DestroyAnalyzer/GetAnalyzerName` 标准入口。
- Saleae Analyzer SDK：
  - `include/Analyzer.h`
  - `include/AnalyzerChannelData.h`
  - `include/AnalyzerResults.h`
  - `testlib/MockChannelData.cpp`
  - `testlib/TestInstance.cpp`
- PXView / libsigrokdecode：
  - `pxview-fork/PXView/pv/data/decoderstack.cpp`
  - `pxview-fork/libsigrokdecode/c_decoders/spi_c.c`
  - `pxview-fork/libsigrokdecode/tests/decoder_test.c`

## 本地落点

- `crates/pxlogic-core/src/decoder_backend.rs`
  - backend kind、能力、隔离方式、富 annotation 结果和 host trait。
  - 旧 Rust decoder 的显式 compatibility adapter。
- `testdata/decoders/spi-conformance-v1.json`
  - backend-neutral 初始电平、通道边沿、SPI 配置和期望字节。
- `crates/pxlogic-core/tests/decoder_fixtures.rs`
  - 校验 fixture schema、四种 SPI mode、LSB 和 CS boundary 覆盖。
- `README.md`
  - 固化 Saleae/sigrok 双生态方向与 GPL sidecar 边界。

## 复用方式

- Saleae：复用公开 Analyzer SDK 的输入/结果抽象，后续 sidecar 直接加载 analyzer plugin，不重写协议状态机。
- sigrok：复用 PXView 已验证的 C decoder 入口、channel mapping、samplerate metadata 和 annotation callback 结构。
- 当前阶段没有复制或链接 GPL 实现；只建立独立 sidecar 所需的稳定宿主契约。

## 用户可见行为

- 本阶段不改变现有 Analyzer UI 和捕获行为。
- 现有 UART/I2C/SPI 仍能使用，但明确属于迁移兼容路径。
- 后续替换 backend 时，气泡、表格和 viewport 聚合不需要再次重写。

## 验证

- `cargo test -p pxlogic-core`
  - 37 个 unit tests 通过。
  - 1 个 decoder fixture contract test 通过。
- SPI fixture 包含：
  - CPOL/CPHA `(0,0) (0,1) (1,0) (1,1)`。
  - MSB first 与 LSB first。
  - CS 释放后重新拉低，未完成 word 不得拼接进下一事务。

## 已知差距 / 后续任务

- `GraphSession` 当前仍直接调用 indexed Rust decoder；只有外部 backend 达到 fixture 等价后才切换默认值。
- 下一目标是 `Saleae Native SPI` sidecar PoC：版本探测、plugin load、settings、边沿输入、Frame/FrameV2 输出和进程隔离。
- 随后接入 `Sigrok Native SPI`，使用同一 fixture 做差分测试和性能基准。
- Saleae plugin 二进制先从用户本机 Logic 安装目录发现，不在仓库中复制。

## 对应 Git 提交

- 尚未提交。
