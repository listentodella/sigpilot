# Saleae / Sigrok Native LIN

## 功能范围

- Saleae Native 直接加载 Logic 2.4.43 原版 LIN analyzer。
- Sigrok Native 直接构建 PXView 的 `uart_c` 与 `lin_c` decoder，并使用原生 decoder stacking。
- 两套后端支持 packed PXLogic capture、稀疏 `.sal` transition capture 和 64 位 sample index。
- 导入带 LIN analyzer 的 `.sal` 时自动恢复输入通道、LIN 版本和 bit rate，并使用 Saleae Native 重新解码。
- 导出 `.sal` 时按原版 LIN setting interface 写回 analyzer metadata。

## 复用来源

- Logic 2.4.43 macOS arm64：
  - `liblin_analyzer.so`，SHA-256 `ce565e316ba9bdfc3d2d15bff609deedef6ef276e3b187a0ed150c4389e1bccc`。
  - 原版 `Serial`、`LIN Version`、`Bit Rate (Bits/s)` setting interface、tooltip 与版本选项。
  - 原版 LIN FrameV2 输出与气泡标签。
- Saleae Analyzer SDK commit `16a9ebff783614691781a8cd69d733abc8c8c722` test harness。
- PXView `libsigrokdecode/c_decoders/uart_c.c` 与 `lin_c.c`：
  - 直接复用 UART lower decoder、LIN 状态机、checksum 和 annotation 输出。
- `.app-data` 中 Logic 2.4.43 persisted analyzer metadata 和 analyzer 恢复流程。

## 本地落点

- `native/saleae-analyzer-sidecar/`
  - 校验并加载原版 LIN 插件，将 FrameV2 归一化为 backend-neutral frame/channel values。
- `native/sigrok-analyzer-sidecar/`
  - 构建 PXView `lin_c`，以原生 `uart_c -> lin_c` stacking 运行并过滤各 decoder source 的 annotation。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - 仅验证通用 sidecar 请求、packed/sparse bridge 和结果归一化，不包含 LIN 状态机。
- `crates/pxlogic-file/src/lib.rs`
  - 将 `.sal` 原版 LIN settings 恢复为通用 `NativeDecodeSettings`。
- `native/saleae-graph-sidecar/`
  - 按原版 setting schema 写回 LIN analyzer，并进行创建、重导入 round-trip。
- `src/lib/analyzers.ts`、`src/components/AnalyzerSettingsDialog.tsx`
  - 增加 Saleae/Sigrok LIN catalog、输入通道、bit rate 与 LIN version 设置。
- `testdata/decoders/lin-conformance-v1.json`
  - LIN 2.x 的 Break、Sync `0x55`、ID `0x12`、Data `A5 5A` 和 enhanced checksum `0x6D` 跨后端 fixture。

## 架构边界

- 没有新增 Rust LIN decoder、UART lower decoder、checksum 或协议状态机。
- Rust 只负责 transition/configuration 传输、sidecar 生命周期和统一结果归一化。
- 新协议只进入 Saleae Native 或 Sigrok Native；`LegacyRust` 仅用于迁移兼容，不再扩展，并在两套外部生态覆盖成熟后弃用。

## 用户可见行为

- Saleae Native 与 Sigrok Native 分组都提供 LIN，Legacy Rust 不提供 LIN。
- 设置包含 Serial、Bit Rate 和 LIN Version 1.x/2.x。
- 解码气泡和 Data Table 可显示 Break、Sync、Identifier、Data 与 Checksum。
- `.sal` 保存的 Saleae LIN analyzer 无需手动重选 decoder 即可恢复；再次导出仍保留原版设置结构。

## 验证

```sh
cargo test --workspace --no-fail-fast
pnpm build
native/saleae-analyzer-sidecar/verify.sh \
  /Volumes/tp7100s/Downloads/Logic-2.4.43-macos-arm64.zip
native/sigrok-analyzer-sidecar/verify.sh
native/saleae-graph-sidecar/verify-sal-roundtrip.sh
```

- Saleae 与 Sigrok 均解出 `00 55 12 A5 5A 6D`，其中首个 `00` 表示 Break condition。
- 两套 native backend 均覆盖 packed 和 490 亿 sample 偏移的 sparse fixture。
- `.sal` 单测与真实 Graph runtime round-trip 覆盖 Serial、LIN Version 和 Bit Rate。

## 已知边界

- 当前 fixture 覆盖 LIN 2.x enhanced checksum；还需真实硬件 capture 补充 LIN 1.x/classic checksum 与错误帧回归。
- Saleae LIN 插件依赖固定 Logic 2.4.43 ABI 和用户本地安装包，不提交原版二进制。
- 当前是批量 sidecar 解码；持续增量 streaming decoder lifecycle 尚未接入。

## 对应提交

- `port: add saleae and sigrok native lin`
