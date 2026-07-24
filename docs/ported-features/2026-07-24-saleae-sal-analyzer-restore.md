# Saleae `.sal` Analyzer 会话恢复

## 功能范围

- 导入 Logic 2 `.sal` 时同时恢复 session 名称、Notes、通道名称和 low-level analyzer 配置。
- 当前可运行恢复 Async Serial、I2C、SPI；导入后主图立即按已保存配置重新分析波形并显示 analyzer bubbles，无需用户再次选择解码器。
- 不把旧 decoded frame 缓存在 PXLogic 会话中。与 Logic 2 一致，加载 DigitalStore 后重新运行 analyzer。
- 未接入的 analyzer 类型仍保留为不可运行占位及原始 Saleae JSON，避免再次导出时静默丢失配置。
- 再次导出 `.sal` 时保留 analyzer 名称、颜色、显示进制、Data Table/Terminal 开关和原始扩展字段。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/saveLoadCapture/thunks.tsx`
  - `.sal` 解包、`meta.json` 迁移与 session load 顺序。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/rapidDataStore/RapidDataStore.ts`
  - `loadSession()` 先反序列化 DigitalStore，等待通道 `hasData`，再执行 `analyzersStore.startAnalysis()`。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/rapidDataStore/SessionStore.ts`
  - `initAnalyzers()` / `migrateAnalyzers()` 从 persisted `data.analyzers` 恢复 LLA 与通道行关系。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzersStore.ts`
  - `migrateAnalyzers()`、`restoreFromPersistedData()` 和 `startAnalysis()`。
- Logic 2.4.43 `libgraph_server_shared.dylib`
  - 原版 DigitalStore 反序列化、序列化和 `.sal` Graph 数据读取。

## 本地落点

- `native/saleae-graph-sidecar/src/main.cpp`
  - 从 `meta.json -> data` 搬出 `analyzers`、`captureNotes`、session 名称及 `rowsSettings` 通道标签。
  - 导出时生成 Logic 兼容的 SPI/I2C/Async Serial setting arrays；若 analyzer 来自 `.sal`，按 setting title 合并新值并保留未知字段。
- `crates/pxlogic-file/src/lib.rs`
  - `SaleaeSessionMetadata` / `SaleaeAnalyzerMetadata` 会话模型。
  - 将 Saleae setting array 归一化为 PXLogic `AnalyzerDecodeSettings`，同时无损保留原始 JSON。
- `crates/pxlogic-core/src/decode.rs`
  - UART 配置补齐 data bits、1/1.5/2 stop bits、parity 和 bit order。
- `crates/pxlogic-core/src/decoder_backend.rs`
  - 将完整 UART 配置传给 PXView/libsigrokdecode sidecar。
- `src-tauri/src/main.rs`、`src/lib/api.ts`
  - `.sal` open result 携带 session metadata；`.sal` export 接收当前 UI analyzer state。
- `src/lib/analyzers.ts`、`src/App.tsx`
  - 重建 `UiAnalyzerInstance`、保存原始 metadata，并由现有 analyzer render pipeline 自动重新解码。
- `src/components/AnalyzerSettingsDialog.tsx`
  - Async Serial 面板可查看和编辑从 `.sal` 恢复的完整 framing 参数。

## 复用方式

- 沿用原版“持久化 analyzer 配置，不持久化 decoded frame；波形 ready 后 start analysis”的状态规则。
- 原始 `data.analyzers` 结构不改写后直接跨 sidecar 边界保留；仅为当前可执行后端额外建立规范化 settings。
- Logic 输出 setting 的 `title`、`type`、options 和 value 结构按原版 `.sal` 实例与恢复源码生成，未支持字段采用 merge 而非覆盖。

## 用户可见行为

- 打开带 SPI/I2C/Async Serial analyzer 的 `.sal` 后，Analyzer 右栏已经存在相同名称、颜色、通道和协议参数。
- 波形区自动出现对应 analyzer bubbles；用户不需要重新 Add Analyzer 或重新指定通道。
- session 名称、Notes 和自定义数字通道名同步恢复。
- 保存为新 `.sal` 后，Logic 2 可再次恢复这些 analyzer 设置。

## 验证方式

```sh
cargo test -p pxlogic-file
native/saleae-graph-sidecar/verify-sal-roundtrip.sh
cargo test --workspace
pnpm build
```

覆盖内容：

- Rust fixture 验证 SPI、I2C 与完整 UART framing 字段归一化。
- native round-trip 验证 SPI/I2C/UART setting arrays、名称、颜色、显示进制、Data Table/Terminal 开关和 Notes。
- `assets/demo-spi.sal` 实测恢复 MOSI D5、MISO D0、Clock D3、Enable D4、8-bit MSB-first Mode 0。
- 8 通道 analyzer fixture 已由 Logic 2.4.43（CDP 9222）实际打开，并自动显示四条 `SPI [restored]` analyzer rows，证明原版 `migrateAnalyzers()` 成功执行。

## 已知差距 / 后续任务

- 当前可执行恢复范围为 Async Serial、I2C、SPI；其他 LLA 会保留配置占位，但尚不能运行。
- HLA、analyzer trigger、Data Table 自定义 column 和 Terminal 历史内容尚未迁移。
- Saleae Native 当前只接入 SPI；Async Serial/I2C 使用 PXView/libsigrokdecode 重算。
- Logic 2 UI 的设备模型最多 16 个数字通道，因此 32 通道 round-trip 由 GraphServer/PXLogic 验证，Logic UI 兼容测试使用 8 通道 fixture。
- 对应 Git 提交：本文所在的 `port: restore analyzers from Logic 2 sal sessions` 提交。
