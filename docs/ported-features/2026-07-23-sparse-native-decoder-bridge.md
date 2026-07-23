# Saleae / Sigrok 稀疏原生解码桥

## 功能范围

将 `.sal` 经 Saleae GraphServer 导出的 transition index 直接交给 Saleae Native SPI 和 Sigrok Native SPI decoder，避免把长捕获展开成逐采样 buffer。

本目标最初只覆盖 SPI batch decode。UART/I2C sparse decode 后续已由 `2026-07-23-sigrok-native-uart-i2c-catalog.md` 接通；HLA 与原生 decoder streaming 仍按现有能力矩阵处理。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source`
  - Graph capture/session 的原生 backend 选择与 analyzer result 消费方式。
- `pxview-fork/libsigrokdecode/session.c`
  - `srd_session_send` 的 sample range 语义和 decoder 生命周期。
- `pxview-fork/libsigrokdecode/instance.c`
  - C decoder wait 条件、边沿匹配和 sample number 推进规则。
- `pxview-fork/libsigrokdecode/c_decoder_api.c`
  - C decoder `c_wait` / `c_pin` API。
- `pxview-fork/libsigrokdecode/c_decoders/spi_c.c`
  - PXView SPI C decoder 的状态机、CPOL/CPHA、CS、bit order 和 binary output。

## 本地落点

- `crates/pxlogic-core/src/models.rs`
  - `SparseCaptureData` / `SparseDigitalChannel` transition 模型。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - `DecoderBackend::decode_sparse` 契约。
  - packed 与 sparse 输入共享 `pxlogic.decoder.spi.v1` 请求格式。
  - Saleae Native / Sigrok Native adapter 的 sparse request 构造和自动发现。
- `crates/pxlogic-graph/src/lib.rs`
  - `.sal` session 在显式 Native backend 下优先解码 sparse capture。
  - live capture 在 batch sidecar 尚未完成时继续使用 Graph indexed fallback。
- `native/saleae-analyzer-sidecar/src/main.cpp`
  - 继续直接把 transition index 交给原版 Saleae Analyzer SDK `MockChannelData`。
- `native/sigrok-analyzer-sidecar/src/main.c`
  - 将 PXView `spi_c` C decoder 的 runtime wait/pin 输入替换为 transition index 查询，不分配 sample-count 大小的 channel buffer。
- `native/sigrok-analyzer-sidecar/verify.sh`
  - 新增约 490 亿 sample 的稀疏大索引回归测试。

## 复用方式

- Saleae：复用原版 `libspi_analyzer.so`、Analyzer SDK 的 `AnalyzerChannelData` 访问和 Result output，不复制或重写 Saleae SPI 状态机。
- Sigrok：复用 PXView 的 `libsigrokdecode` C API 和 `spi_c.c` 状态机，只替换输入 runtime 的 sample lookup，使 `c_wait` 直接定位下一个匹配 transition。
- Rust：只做 backend-neutral request、结果转换和 session/cache 路由；没有新增协议状态机。

## 用户可见行为

- 打开长 `.sal` 后选择 Saleae Native 或 Sigrok Native SPI，可以直接在原始 sample index 上生成 decode frame。
- 大捕获不会因为 `sample_count` 被展开成几十 GB 的 packed buffer。
- Native backend 未配置或 live capture 尚未完成时，继续显示现有 Graph indexed Legacy Rust 结果。
- Saleae sidecar/runtime 在 workspace build、标准 Logic 2 安装目录和 `HOME/Downloads` 中自动发现；`PXLOGIC_SALEAE_*` 环境变量优先。

## 验证方式

```sh
native/sigrok-analyzer-sidecar/verify.sh

PXLOGIC_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/pxlogic-sigrok-sidecar" \
PXLOGIC_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders" \
cargo test -p pxlogic-core sigrok_native_sidecar -- --ignored

PXLOGIC_SALEAE_SIDECAR="$PWD/target/native/saleae-analyzer-sidecar/pxlogic-saleae-analyzer-sidecar" \
PXLOGIC_SALEAE_RUNTIME_ROOT="$PWD/target/native/saleae-runtime-2.4.43" \
cargo test -p pxlogic-core saleae_native_sidecar -- --ignored

cargo test -p pxlogic-core -p pxlogic-graph -p pxlogic-file
```

验证结果：

- Sigrok SPI fixtures：Mode 0-3、LSB-first、CS partial word 全部通过。
- Saleae SPI fixtures：同上全部通过。
- Saleae `.sal` GraphServer 导出：`assets/demo-spi.sal` 输出 6 个数字通道，`sample_count=49,940,179,616`。
- 稀疏大索引 fixture：首个 frame sample `49,000,000,010`，sidecar 未分配按 sample count 线性增长的 buffer。

## 已知差距 / 后续任务

- 当前 sidecar availability 只探测 SPI；需要逐步加入 Saleae analyzer plugin 数据库和 PXView C decoder catalog。
- Sigrok sparse runtime 目前针对 transition-indexed C decoder 输入，尚未对 Python decoder stack 提供同等 sparse API。
- `.sal` 仍以原始文件路径为主要保存来源，trim/save/export 需要后续定义不展开长 capture 的策略。
- native backend 默认仍由 analyzer 选择显式指定，`Auto` 保持兼容 fallback，待多个协议均有原生实现后再改变默认策略。
- 当前工作树尚未创建独立 Git commit；提交时应将本文件与对应 sidecar/Rust 变更作为一个功能提交。
