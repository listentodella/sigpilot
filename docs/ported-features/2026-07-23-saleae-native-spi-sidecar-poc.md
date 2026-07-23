# Saleae Native SPI sidecar PoC

## 功能范围

- 在独立进程中加载 Logic 2.4.43 原版 `libspi_analyzer.so`，不把 analyzer plugin `dlopen` 到 Tauri 主进程。
- 将 PXLogic packed capture 转换为 Saleae `AnalyzerChannelData` 边沿流。
- 搬运 SPI analyzer 的原生设置、Frame/FrameV2、bubble text、tabular text 和 marker 输出。
- 将结果转换为统一 `DecoderOutput`，并提供 Rust `SaleaeNativeDecoder` adapter。
- 只从本机 Logic 安装目录或安装 ZIP 的临时提取目录发现二进制；仓库不保存 Saleae dylib/plugin。

## 原版与公开源码参考

- Logic 2.4.43 macOS arm64：
  - `Contents/Resources/macos-arm64/libAnalyzer.dylib`
  - `Contents/Resources/macos-arm64/Analyzers/libspi_analyzer.so`
- Analyzer SDK 固定提交：`16a9ebff783614691781a8cd69d733abc8c8c722`。
- `spi-analyzer` 参考提交：`d613beda4ff3cc7417390cb9afb6ab715ddd65f7`，该提交之后到 2.4.43 插件构建日期之间 `src/` 无变化。
- 直接复用 SDK test harness：
  - `AnalyzerStubs.cpp`
  - `HelperStubs.cpp`
  - `MockChannelData.cpp`
  - `MockSimulatedChannelDescriptor.cpp`
  - `SettingsStubs.cpp`
  - `StreamHelpers.cpp`
- 对照 Saleae `spi-analyzer`：
  - `SpiAnalyzer::AdvanceToActiveEnableEdgeWithCorrectClockPolarity`
  - `SpiAnalyzer::WouldAdvancingTheClockToggleEnable`
  - `SpiAnalyzer::GetWord`
  - `SpiAnalyzerResults::GenerateBubbleText`
  - `SpiAnalyzerResults::GenerateFrameTabularText`

## ABI 与版本固定

- Logic 2.4.43 runtime SHA-256：
  - `libAnalyzer.dylib`: `d7d517b59cf5f165ff4d71e04104794b4c459a96c6309a9ffc6e856b7b25c912`
  - `libspi_analyzer.so`: `366dfc0b312385f5e608245a9493c33194ed81723a785cc10248fe70593c1ce3`
- sidecar 在 probe/decode 前校验这两个 hash；不匹配时拒绝解码。
- SDK test harness 被编译为 `@rpath/libAnalyzer.dylib` shim，使原版插件继续使用其原始 C++ ABI。
- Logic ZIP 继承的 macOS quarantine 会阻止第三方进程加载 plugin；`verify.sh` 使用 `ditto --norsrc` 创建临时副本，不修改原始 ZIP 或安装包。

## 本地落点

- `native/saleae-analyzer-sidecar/build.sh`
  - 固定 SDK 和 nlohmann/json 版本，使用 Xcode clang 构建 shim 与 sidecar。
- `native/saleae-analyzer-sidecar/src/result_capture.cpp`
  - 捕获 legacy Frame、FrameV2 typed fields、marker 和原版显示文本。
  - 合并同一个 SPI word 同时写出的 Frame 与 FrameV2，保留 `enable/result/disable/error` row。
- `native/saleae-analyzer-sidecar/src/main.cpp`
  - runtime 发现、hash probe、plugin 动态加载、设置映射、边沿输入与 JSON CLI。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - `SaleaeNativeDecoder` 进程 adapter。
  - 只扫描 MOSI/MISO/CLK/CS 所需通道的 transition，避免为未使用通道生成边沿数组。
- `native/saleae-analyzer-sidecar/verify.sh`
  - 一次完成构建、临时 runtime 准备、原生 fixture 和 Rust adapter 验证。

## 输出一致性

- 原版 FrameV2 `mosi` / `miso` byte array 映射为 typed `DecoderFieldValue::Bytes`。
- 原版 Hex bubble 候选保持顺序，例如 `0xA5`、`0x3C`。
- 原版 tabular text 保持为 `MOSI: 0xA5;  MISO: 0x3C`。
- Clock 有效采样边沿保持为 `up_arrow/down_arrow` marker。
- CS 事件保持为 `enable/disable` row，不伪造数据值。

## 验证

执行：

```bash
native/saleae-analyzer-sidecar/verify.sh /Volumes/tp7100s/Downloads/Logic-2.4.43-macos-arm64.zip
```

结果：

- runtime/plugin hash 与 Logic 2.4.43 完全匹配，`GetAnalyzerName()` 返回 `SPI`。
- SPI Mode 0/1/2/3 MSB-first 全部匹配。
- SPI Mode 0 LSB-first 匹配。
- CS 中断未完成 word 后重新开始的 fixture 匹配，只输出后续完整 `0x5A / 0xC3`。
- Rust `SaleaeNativeDecoder` adapter 能反序列化原版 bubble、FrameV2 fields 和 channel values。

## 已知限制 / 后续任务

- 当前仅支持 macOS arm64、Logic 2.4.43 和 SPI batch decode。
- sidecar 输入目前是完整 capture 的边沿数组，尚未实现增量 streaming/chunk continuation。
- `GraphSession` 默认 backend 尚未切换；需要 Saleae Native 与 Sigrok Native 都通过相同 fixtures 后再做选择策略。
- 下一目标是 Sigrok Native SPI sidecar，复用同一个 fixture 和 `DecoderOutput` 做差分与性能对比。

## 对应 Git 提交

- 尚未提交。
