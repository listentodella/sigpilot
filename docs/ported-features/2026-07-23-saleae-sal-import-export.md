# Saleae `.sal` 稀疏导入

## 功能范围

使用 Logic 2.4.43 原版 GraphServer 打开 `.sal`，再由原版 `ExportNode` 导出公开 Saleae digital binary；Rust 只解析公开格式并保存 transition index，不展开为逐采样数组。

这里的“export”是 GraphServer 内部的 `.sal -> public digital binary` 转换，不是 PXLogic UI 的另存为 `.sal`。

## 原版参考路径

- Logic 2.4.43 runtime：`libgraph_server_shared.dylib`、`libAnalyzer.dylib`、`pythonlibs`。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source`
  - Graph session、DigitalStore、ExportNode 请求结构参考。
- 原版 Graph actions：`GraphInit`、`AddNode`、`StartDeserialization`、`ConnectApi`、`ExportData`、`DeleteGraphData`。

## 本地落点

- `native/saleae-graph-sidecar/src/main.cpp`
  - 隔离加载 GraphServer，解压 `.sal`，建立 DigitalStore，并导出 digital binary 和 `manifest.json`。
- `crates/pxlogic-file/src/lib.rs`
  - `open_saleae_transition_manifest` 解析 44-byte Saleae binary header 与 `double` transition time。
- `crates/pxlogic-core/src/models.rs`
  - `SparseCaptureData` / `SparseDigitalChannel`。
- `crates/pxlogic-graph/src/lib.rs`
  - `DigitalGraph::from_sparse_capture` 和 `u64` edge index。
- `src-tauri/src/main.rs`
  - `open_capture` 对 `.sal` 的 sidecar 调用、临时目录清理和 session 替换。
- `src/App.tsx`
  - 打开文件过滤器包含 `.sal`。

## 复用方式

- 直接调用原版 GraphServer 和 DigitalStore/ExportNode，不重写 `.sal` 私有序列化格式。
- Rust 仅解析 Saleae 已公开的 digital binary 格式，并把时间转换为 sample index。
- Graph sidecar 为 one-shot 进程；Logic 2.4.43 在 ExportNode 完成后可能仍持有私有 mutex，因此不调用 `DestroyGraphServer`/`dlclose`，由进程退出回收。

## 用户可见行为

- 文件对话框可选择 `.sal`。
- 打开后直接显示原始数字波形和超过 `u32::MAX` 的时间范围。
- 约 400 秒、125 MHz 的示例捕获不会生成约 50 GB 的 sample buffer。

## 验证方式

```sh
native/saleae-graph-sidecar/build.sh
native/saleae-graph-sidecar/verify.sh

OUT="$(mktemp -d)"
target/native/saleae-graph-sidecar/pxlogic-saleae-graph-sidecar \
  --runtime-root "/path/to/Saleae Logic.app/Contents/Resources/macos-arm64" \
  --convert-sal assets/demo-spi.sal "$OUT"

PXLOGIC_SALEAE_MANIFEST="$OUT/manifest.json" \
  cargo test -p pxlogic-file -- --ignored opens_native_saleae_graphserver_export
```

`assets/demo-spi.sal` 实测导出 6 个数字通道，采样率 125 MHz，`sample_count=49,940,179,616`。

## 已知差距 / 后续任务

- 仅导入数字通道；analog/waveform channel 尚未接入。
- `.sal` session 的 save/trim/range measurement 仍需原生 sparse 实现，不能退回 packed `Vec<u8>`。
- 当前不会生成新的 `.sal` 文件。
- 当前工作树尚未创建独立 Git commit。
