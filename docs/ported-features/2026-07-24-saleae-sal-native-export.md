# Saleae Logic 2 `.sal` 原生导出

## 功能范围

- PXLogic packed capture 和 `.sal` sparse capture 都可从顶部 `SAL` 按钮导出 Logic 2 capture。
- 保留 1-32 个物理数字通道、初始电平、采样率、总 sample count 与 `u64` transition index。
- 生成的每个最终 DigitalStore 都经过 Logic 2.4.43 原版 `DigitalStore` 反序列化和重新序列化。
- 生成 Logic 2 v16 `meta.json`，复用原版 v16 -> v22 升级链路，而不是伪造当前版本的完整 session state。
- `.sal` 回读支持无边沿的恒高/恒低通道，不会因原版 `ExportNode` 的空 processed interval 丢失通道。

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/saveLoadCapture/thunks.tsx`
  - `StartSerialization`、等待 `SerializationComplete`、写 `meta.json`、最后压缩目录的保存顺序。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/saveLoadCapture/utils.tsx`
  - `./digital-N.bin` 文件命名。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/saveLoadCapture/versions/upgrade.ts`
  - v16 `binData` channel identity 与原版升级入口。
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/GraphClient/GraphActions.ts`
  - `StartDeserialization` / `StartSerialization` action 类型。
- Logic 2.4.43 `libgraph_server_shared.dylib`
  - 原版 `DigitalStore`、Graph state 与 serializer 实际运行时。

## 本地落点

- `crates/pxlogic-file/src/lib.rs`
  - packed capture 单次扫描后流式写每通道 transition 文件。
  - sparse capture 直接写 little-endian `u64` transition，不展开 samples。
  - `pxlogic.saleae-export.v1` 中间 manifest 与 packed/sparse 回归测试。
- `native/saleae-graph-sidecar/src/main.cpp`
  - private seed DigitalStore、Saleae RLE、GraphServer 校验/序列化、v16 metadata 和 ZIP 打包。
  - 逐通道累积 32 个 node 的 Graph state，兼容 GraphServer 分帧状态更新。
  - 恒定通道 public binary fallback，修复 `.sal` 回读。
- `native/saleae-graph-sidecar/verify-sal-roundtrip.sh`
  - 32 通道与 490 亿 sample 的自动 create -> convert -> transition equality 验证。
- `src-tauri/src/main.rs`
  - packed/sparse session 选择、临时 manifest、sidecar 启动、原子移动输出文件与错误返回。
- `crates/pxlogic-core/src/models.rs`、`src/lib/api.ts`、`src/App.tsx`
  - `Sal` export format、Tauri API 和顶部 `SAL` 文件对话框入口。

## 复用方式

- 保存状态机直接沿用原版 `StartDeserialization -> StartSerialization -> SerializationComplete -> meta.json -> zip` 顺序。
- 最终 store 由原版 GraphServer serializer 写出；PXLogic 只生成 GraphServer 可读取的 transition seed。
- RLE seed 使用安装包中 DigitalStore v1 的字段布局和可变长 run 编码。实测 record 在新块开始时会回到通道全局初始电平，因此只在信号已回到初始电平时分块；跨越很久的单个脉冲保持在同一 record 中。
- 原版 serializer 会把完全没有边沿的通道压缩成零 processed interval。回读时复用 `meta.json` 捕获时长和 store 头部初始电平生成公开 Saleae constant binary，其 transition 数为零。

## 用户可见行为

- 捕获完成后点击顶部 `SAL`，选择路径即可生成 `.sal`。
- 从原版 `.sal` 导入的 sparse session 也可再次导出 `.sal`，不会分配与 sample count 成比例的内存。
- Logic 2.4.43 实际打开生成文件后，窗口标题变为 `Logic 2 [PXLogic - Demo] [roundtrip]`。
- 32 通道归档包含 `digital-0.bin` 到 `digital-31.bin` 和根目录 `meta.json`。

## 验证方式

```sh
native/saleae-graph-sidecar/verify.sh
native/saleae-graph-sidecar/verify-sal-roundtrip.sh
cargo test --workspace
pnpm build
```

自动 round-trip 覆盖：

- D0-D31，偶数通道各两个边沿，奇数通道恒高且零边沿。
- `sample_count=49,000,000,001`，边沿 `[100, 4,294,967,300, 49,000,000,000]`。
- GraphServer 回读后的 sample rate、sample count、初始电平和每个 transition 完全一致。
- `assets/demo-spi.sal` 仍可导入，保持 125 MHz 和超过 `u32::MAX` 的 sample index。
- 生成的一通道 fixture 已通过正在运行的 Logic 2.4.43（9222）实际打开，而非只验证 ZIP 或 GraphServer。

## 已知差距 / 后续任务

- 当前 `.sal` 只覆盖 legacy digital channel；analog、MSO waveform、trigger store、analyzer 配置、measurement 和 notes 尚未写入。
- packed capture 导出需要线性扫描一次样本；当前 Tauri 命令尚未向 UI 报告导出进度。
- Logic runtime 与 Graph sidecar 目前只在 macOS arm64 / Logic 2.4.43 上固定验证。
- 对应 Git 提交：本文所在的 `port: add Logic 2 sal export` 提交。
