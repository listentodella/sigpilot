# Saleae / Sigrok Native CAN and CAN-FD

## 功能范围

- Saleae Native 直接加载 Logic 2.4.43 原版 CAN analyzer。
- Sigrok Native 直接构建 PXView 的 `can_c` 与 `can_fd_c` decoder。
- 两套后端支持 packed PXLogic capture、稀疏 `.sal` transition capture 和 64 位 sample index。
- 导入带 CAN analyzer 的 `.sal` 时自动恢复原通道、bit rate 和 inversion 配置，并使用 Saleae Native 重新解码。
- 前端提供 CAN/CAN-FD 设置、波形气泡和 Identifier/DLC/Data/CRC/ACK 自适应 Data Table 字段。

## 复用来源

- Logic 2.4.43 macOS arm64：
  - `libcan_analyzer.so`，SHA-256 `ec1fcaa48d25930c43fe315e1c30917a475d01e7b85ad81d71e674ad81d1e251`。
  - 原版 `CAN`、`Bit Rate (Bits/s)`、`Inverted (CAN High)` setting interface。
  - 原版 FrameV2 的 Identifier、DLC、Data、CRC、ACK 输出。
- Saleae Analyzer SDK commit `16a9ebff783614691781a8cd69d733abc8c8c722` test harness。
- PXView `libsigrokdecode/c_decoders/can_c.c` 与 `can_fd_c.c`：
  - CAN/CAN-FD 状态机、采样点、stuff bit、CRC 和 annotation 输出。
- `.app-data` 中 Logic 2.4.43 的 CAN analyzer 设置与 Data Table 展示语义。

## 本地落点

- `native/saleae-analyzer-sidecar/`
  - 校验并加载原版 CAN 插件，将 FrameV2 归一化为 backend-neutral frame/channel values。
- `native/sigrok-analyzer-sidecar/`
  - 构建 PXView `can_c`/`can_fd_c`，映射 bitrate/sample point/channel，并按 annotation class 归一化输出。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - 仅扩展通用 sidecar capability discovery 和 packed/sparse integration tests。
- `crates/pxlogic-file/src/lib.rs`
  - 将 `.sal` 原版 CAN settings 恢复为通用 `NativeDecodeSettings`。
- `src/lib/analyzers.ts`、`src/components/AnalyzerSettingsDialog.tsx`
  - 增加两套 backend catalog、原版 CAN 设置项、CAN-FD 参数与结果通道绑定。
- `testdata/decoders/can-conformance-v1.json`
  - 标准 CAN ID `0x123`、payload `A5 5A` 的跨后端 transition fixture。

## 架构边界

- 没有新增 Rust CAN/CAN-FD decoder、协议状态机或 mock waveform generator。
- Rust 只负责 transition/configuration 传输、sidecar 调用和统一结果归一化。
- 后续协议只进入 Saleae Native 或 Sigrok Native；`LegacyRust` 不再扩展，并在两套外部生态覆盖成熟后从 catalog 移除和删除。

## 用户可见行为

- Saleae Native 分组提供 CAN，Sigrok Native 分组提供 CAN 与 CAN-FD。
- CAN 设置包含输入通道、bit rate、Sigrok sample point 和 `Inverted (CAN High)`。
- CAN-FD 设置包含输入通道、nominal bit rate、fast bit rate 和 sample point。
- 解码气泡绑定 CAN 输入通道；Data Table 从 native `channel_values` 自动生成 Identifier、DLC、Data、CRC、ACK 列。
- `.sal` 保存的 Saleae CAN analyzer 无需手动重选 decoder 即可恢复。

## 验证

```sh
cargo test --workspace --no-fail-fast
pnpm build
native/saleae-analyzer-sidecar/verify.sh \
  /Volumes/tp7100s/Downloads/Logic-2.4.43-macos-arm64.zip
native/sigrok-analyzer-sidecar/verify.sh
```

- Saleae 原版 CAN 插件解出 ID `0x123`、DLC `2`、Data `A5 5A`、CRC `0x495C`、ACK。
- PXView `can_c` 和 `can_fd_c` 对同一 fixture 解出一致字段。
- 两套 native backend 均覆盖 packed 和 490 亿 sample 偏移的 sparse fixture。
- `.sal` 单测覆盖原版空标题 inversion bool 的恢复。

## 已知边界

- 当前可信 fixture 是经典 CAN 帧。`can_fd_c` 已验证兼容该输入，但仍需可信的真实 CAN-FD/BRS fixture 才能声明完整 FD 帧一致性。
- Saleae CAN 插件依赖固定 Logic 2.4.43 ABI 和用户本地安装包，不提交原版二进制。
- 当前是批量 sidecar 解码；持续增量 streaming decoder lifecycle 尚未接入。

## 对应提交

- `port: add saleae can and sigrok can-fd`
