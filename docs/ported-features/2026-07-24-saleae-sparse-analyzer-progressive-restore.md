# Saleae `.sal` Sparse Analyzer 渐进恢复

## 功能范围

- 修复长 `.sal` 导入后 analyzer 配置存在，但波形气泡与右侧 Data Table 长时间为空的问题。
- Sparse native analyzer 按当前可见区间解码，不再为每次 render request 批量扫描整段 capture。
- Fit Capture 时在协议数据的完整 processed interval 内均匀选择连续片段，使聚合气泡覆盖首段到末段真实协议数据。
- 右侧 Analyzers/Data Table 与波形气泡复用同一套有界分析结果；导入后自动开始分析，不要求用户先打开面板或手动 Restart Analyzer。
- 窗口帧使用全局 sample index 作为稳定 ID，Data Table、气泡点击和跳转保持同一帧身份。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/rapidDataStore/RapidDataStore.ts`
  - `loadSession()` 在 DigitalStore ready 后调用 `analyzersStore.startAnalysis()`。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzersStore.ts`
  - `startAnalysis()` 对所有已恢复 analyzer 启动 Graph 分析。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzerManager.tsx`
  - `processedInterval`、`framesAnalyzed`、`analysisDone` 和 `gapsExistInAnalyzedData` 的渐进状态。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/GraphClient/GraphData.ts`
  - `AnalyzerRenderRequestData` 的可见区 render request、marker/bubble 数量和像素聚合限制。
- `localhost:9222`
  - 使用原版 Logic 2.4.43 打开的 `analyzer-restore.sal` 对照 analyzer 自动启动、通道行和 bubbles 行为。

## 根因

`assets/demo-spi.sal` 的 capture 长度约 499 亿 sample，SPI Clock 有 1,058,008 个 transition。旧实现虽然以 sparse transition 保存波形，但每个 analyzer render request 仍把全部 transition 一次性传给 batch sidecar。Sigrok Native 单次超过数分钟，前端在完成前拿不到任何 frame，所以表现为配置已恢复但气泡和 Data Table 都为空。

## 本地落点

- `crates/pxlogic-graph/src/lib.rs`
  - `sparse_native_analysis_windows()` 按 UART input、I2C SCL、SPI Clock 建立边沿索引窗口。
  - 深度缩放保留完整可见边沿及上下文；Fit Capture 最多均匀选择 16 个连续片段。
  - SPI 片段扩展到相邻 CS assertion/deassertion，避免从 transaction 中间截断。
  - `slice_sparse_capture()` 计算窗口起点电平、偏移 transition，并保留 `u64` 全局 sample。
  - Native window cache、稳定 frame ID、错误片段隔离和 previous/next result 上下文。
- `src-tauri/src/main.rs`
  - `decode_analyzer_frames` 对 sparse capture 使用有界全视图分析，立即向右侧 Data Table 返回结果。
- `src/App.tsx`
  - 移除 Analyzers 面板可见性前置条件，恢复原版 load 后自动 `startAnalysis` 语义。
  - 首批结果尚未返回时显示 `Analyzing...`。
- `crates/pxlogic-graph/Cargo.toml`
  - 测试接入 `pxlogic-file`，直接使用 GraphServer 转换的真实 `.sal` fixture。

## 用户可见行为

- 导入带 analyzer 的 `.sal` 后，波形气泡约一秒内出现。
- 不打开右侧栏也会开始恢复 analyzer data；打开 Analyzers 后 Data Table 已包含结果。
- 重新添加或切换 Saleae Native/Sigrok Native 都能产生气泡和表格行。
- Fit Capture 的结果分布跟随真实协议 processed interval，不会伪造到没有数据的 capture 尾部。
- 放大到局部后自动换成当前区间的连续细节解码。

## 验证方式

```sh
cargo test -p pxlogic-graph
cargo test --workspace
pnpm build

PXLOGIC_SALEAE_MANIFEST=/path/to/demo-spi-manifest.json \
PXLOGIC_SALEAE_SIDECAR="$PWD/target/native/saleae-analyzer-sidecar/pxlogic-saleae-analyzer-sidecar" \
PXLOGIC_SALEAE_RUNTIME_ROOT="$PWD/target/native/saleae-runtime-2.4.43" \
PXLOGIC_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/pxlogic-sigrok-sidecar" \
PXLOGIC_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders" \
  cargo test -p pxlogic-graph \
  imported_saleae_capture_restores_native_bubbles_and_table_frames -- --ignored
```

真实 `assets/demo-spi.sal` 双后端测试在约 1.1 秒内完成，并断言：

- Saleae Native 与 Sigrok Native 都返回非空 Data Table frames。
- 两个后端都返回非空 MOSI/MISO bubbles。
- bubbles 覆盖第一段与最后一段真实 SPI protocol data。
- planner 从 100,000 个可见 clock edges 中选择少于 25,000 个连续上下文边沿。

## 已知差距 / 后续任务

- Data Table 当前优先返回覆盖 processed interval 的有界结果集；原版后台会继续分析直至 `analysisDone`。后续可把 sidecar 改成长驻 streaming worker，逐步补齐完整表格而不反复启动进程。
- I2C/UART 使用固定边沿上下文；SPI 已额外按 CS 边界对齐。超长无 STOP 的 I2C transaction 可在后续增加 START/STOP 边界定位。
- 对应 Git 提交：本文所在的 `fix: restore sparse sal analyzer results` 提交。
