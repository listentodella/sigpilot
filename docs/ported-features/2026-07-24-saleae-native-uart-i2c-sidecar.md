# Saleae Native Async Serial / I2C sidecar

## 目标

- 将 Logic 2.4.43 原版 Async Serial 与 I2C analyzer 接入现有 Saleae Native sidecar。
- 与 SPI 共用 packed/sparse transition 输入，不展开长 `.sal` 捕获。
- `.sal` 中的 Serial/I2C 配置恢复后继续使用 Saleae Native，不再自动改用 Sigrok 重算。
- Rust 仅负责 native sidecar 请求、进程隔离和结果反序列化，不新增协议解码状态机。

## 复用来源

- Logic 2.4.43 macOS arm64 原版插件：
  - `libserial_analyzer.so`
  - `libi2c_analyzer.so`
  - `libspi_analyzer.so`
- Saleae AnalyzerSDK commit `16a9ebff783614691781a8cd69d733abc8c8c722` 的 test harness。
- Saleae 官方 `serial-analyzer` 源码 commit `066b5e5fc55cce69fba169994f06b2f6bec0ea0c`：
  - `SerialAnalyzerSettings`
  - `SerialAnalyzer::WorkerThread`
  - `SerialAnalyzerResults::GenerateBubbleText`
- Saleae 官方 `i2c-analyzer` 源码 commit `b7122ca13cf1b5b6b1287d9dd3f51994cabd861f`：
  - `I2cAnalyzerSettings`
  - `I2cAnalyzer::GetByte`
  - `I2cAnalyzerResults::GenerateBubbleText`

## 实现

- `native/saleae-analyzer-sidecar/src/main.cpp`
  - 按 `decoder.protocol` 加载 Serial/I2C/SPI 原版插件。
  - 直接按原插件的 setting interface 标题设置通道、波特率、数据位、停止位、校验、bit order 和 SPI 参数。
  - 保留原版多级 bubble text、FrameV2 typed fields、start/stop row、ACK、marker 与 tabular text。
  - probe 同时校验三个插件和 `libAnalyzer.dylib` 的 Logic 2.4.43 SHA-256。
- `native/saleae-analyzer-sidecar/src/result_capture.cpp`
  - 合并同一事件的 legacy Frame 与 FrameV2，避免 Serial/I2C 结果重复。
- `native/saleae-analyzer-sidecar/src/sdk_compat.cpp`
  - 补齐 Serial 插件依赖的 `GetOnesCount`、`IsEven`、`IsOdd`、`Diff32` ABI 符号。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - 两套 native backend 共用中性的 `NativeSidecarRequest`；只传 analyzer 使用通道的 transition。
  - Saleae Native 开放 UART/I2C/SPI packed 与 sparse decode。
- `crates/pxlogic-file/src/lib.rs`
  - Logic `.sal` 的 Serial/I2C/SPI analyzer 默认恢复为 Saleae Native。
- `src/lib/analyzers.ts`
  - Saleae Native catalog 和 Decoder Library 下拉开放 Async Serial、I2C、SPI。

## ABI 固定

- `libAnalyzer.dylib`: `d7d517b59cf5f165ff4d71e04104794b4c459a96c6309a9ffc6e856b7b25c912`
- `libserial_analyzer.so`: `d4bda764fc99ff552962f615f8bcbbf320f6015a2ab788155af4cbb190569117`
- `libi2c_analyzer.so`: `e3467f6e8183e57d324798e99cc8d680b2411e3fef11aeae42a52ae8e74781f9`
- `libspi_analyzer.so`: `366dfc0b312385f5e608245a9493c33194ed81723a785cc10248fe70593c1ce3`

## 验证

```sh
native/saleae-analyzer-sidecar/verify.sh \
  /Volumes/tp7100s/Downloads/Logic-2.4.43-macos-arm64.zip

cargo test --workspace --no-fail-fast
pnpm build
```

通过结果：

- Async Serial 8N1 fixture 解出 `0xA5`，原版 data bubble 与 bit marker 保留。
- I2C fixture 解出 write address `0x50` 与 data `0xA5`，start/stop、ACK 与 SCL marker 保留。
- SPI Mode 0-3、MSB/LSB 和 CS partial-word 六组 fixture 继续通过。
- Saleae Serial/SPI sparse fixture 在 490 亿 sample 范围内保留 `u64` 索引。
- workspace tests 与前端 production build 通过。

## 边界与后续

- Logic 2.4.43 安装包实际包含 25 个 analyzer plugin；本批只完成 Async Serial、I2C、SPI，不能视为 Saleae catalog 全量完成。
- 下一批应继续接 CAN、I2S、SWD、JTAG 等真实插件，并为每个协议建立 waveform fixture 后再开放 UI。
- `LegacyRust` 仅保留迁移期兼容；不再新增 Rust decoder，双生态覆盖完成后应从 catalog 移除并最终删除。
