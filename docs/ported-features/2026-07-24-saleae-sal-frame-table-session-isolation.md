# Saleae `.sal` Frame/Table 对齐与新 Session 隔离

## 功能范围

- 修复导入 `.sal` 后 Saleae Native SPI 偶发产生超长错误气泡的问题。
- 波形气泡只显示与当前 analyzer 通道角色匹配的数据 frame；Error、Enable、Disable 等控制 frame 不再伪装成 MOSI/MISO 数据。
- Data Table 恢复 Logic 2 的 `Type / Start / Duration / 动态数据列` 结构；SPI 自动显示独立 MOSI、MISO 列。
- 当前 viewport 解码出的 track frame 合并回 Data Table，使气泡、跳转和表格使用同一全局 frame ID。
- 底栏 `+` 创建全新默认 session，不继承导入文件的通道名称；tab 右键 `Duplicate Session Setup` 显式复制设备设置、通道名称、布局和 analyzer 配置。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzers/AnalyzerManager.tsx`
  - `dataColumnsSeen`、FrameV2 数据列和 analyzer database generation 状态。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/dataTable/DataTableUIState.ts`
  - 默认 `Type / Start / Duration` 列以及按 frame data key 动态创建列。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/dataTable/DataView.tsx`
  - 动态列发现、行/列渲染、固定表头和横向滚动结构。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/Bubbles.tsx`
  - analyzer track 的 role-specific bubble 与 Data Table frame 身份关系。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/features/SessionPlaceholder/ConnectedSessionPlaceholder.tsx`
  - 新 tab 与 source session 的设备配置复制规则。

## 根因

Logic 2 SPI 插件在 sparse 分析窗口从 transaction 中部开始时，会先产生一个 `Error` frame。该 legacy frame 的 `data1/data2` 保存内部错误定位数据，数值可能接近全局 sample index。旧 sidecar 对所有 legacy frame 都无条件生成 MOSI/MISO `channel_values`，因此 `0x10463E804` 一类内部值被误绘制成跨越很长区间的数据气泡。

同时，旧 Data Table 只保留 `DecodedFrame.label` 并固定显示一个 `Data` 列；虽然 frame 内已有 MOSI/MISO channel values，右栏仍丢失了第二个方向的数据。

## 本地落点

- `native/saleae-analyzer-sidecar/src/main.cpp`
  - 只把具有十六进制 result text 且数值符合 `bits_per_transfer` 的 legacy frame 转成 SPI channel values。
- `crates/pxlogic-core/src/decode.rs`、`crates/pxlogic-core/src/decoder_backend.rs`
  - `DecodedFrame` 增加 `frame_type`，保留 native output 的 row/type。
- `crates/pxlogic-graph/src/lib.rs`
  - bubble/track frame 必须匹配 channel + role；无 channel value 的控制 frame 只留在表格。
  - 真实 `demo-spi.sal` 回归验证 8-bit 范围、MOSI/MISO 同帧和气泡文本。
- `src/lib/api.ts`、`src/lib/analyzers.ts`
  - 前端 frame contract 增加 Type；按全局 frame ID 合并 viewport MOSI/MISO track frame。
- `src/App.tsx`、`src/styles.css`
  - Data Table 动态协议列、sticky header、横向滚动和 TSV copy。
  - `+` 使用 fresh defaults；tab 右键提供显式 setup duplicate。

## 复用方式

- 复用 Logic 2 FrameV2 的“默认列 + 数据 key 动态列”模型，当前 channel role 作为稳定数据 key。
- 复用原版 bubble 只属于其 analyzer channel row 的规则，控制 frame 不再向所有轨道广播。
- 保留原版 source-session 配置复制能力，但改成显式右键命令，避免导入 `.sal` 后普通 `+` 意外继承文件通道名。

## 用户可见行为

- 导入 8-bit SPI `.sal` 后不再出现 9 位以上十六进制长气泡；Error frame 仍可在 Data Table 中查看。
- SPI Data Table 同一行显示 MOSI 与 MISO，搜索和复制同时覆盖两列。
- 当前视口气泡可在表格中找到相同 frame；点击/双击仍使用同一 sample interval 跳转。
- 普通新 session 使用 D0、D1 等默认名称；只有 `Duplicate Session Setup` 会保留自定义名称和 analyzer setup。

## 验证方式

```sh
native/saleae-analyzer-sidecar/build.sh
native/saleae-analyzer-sidecar/verify.sh /Volumes/tp7100s/Downloads/Logic-2.4.43-macos-arm64.zip
cargo test --workspace
cargo check --workspace
pnpm build
```

真实 `assets/demo-spi.sal` 双后端回归额外断言：

- 恢复设置为 Saleae Native SPI、8-bit、MOSI D5、MISO D0。
- 每个数据 frame 同时包含 MOSI/MISO，值不超过 `0xFF`。
- Saleae Error frame 的 channel values 为空，不能进入任一 bubble track。
- 所有 SPI bubble 文本均为两位十六进制值。

浏览器交互回归确认动态表头为 `Type / Start / Duration / MOSI / MISO`，普通 `+` 与右键 duplicate 的通道名行为相互隔离。

## 已知差距 / 后续任务

- 当前动态数据列以 decoder channel role 为 key；原版 FrameV2 还支持任意 HLA 字段、列显隐、列宽持久化和自定义搜索排除，这些可在 HLA 数据契约接入时继续扩展。
- 长 `.sal` 的 Data Table 仍是有界渐进结果集，不是 Logic 2 持久 FrameDB 的完整后台索引。
- 对应 Git 提交：本文所在的 `fix: align sal bubbles and protocol table columns` 提交。
