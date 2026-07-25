# 外部解码生态唯一新建入口

## 决策

- 新增协议和协议修复只进入 Saleae Native 或 Sigrok Native。
- Rust 不实现协议状态机；只负责 capture 数据传输、sidecar 生命周期、FFI/IPC 和统一结果模型。
- `LegacyRustDecoder` 只保留给旧 `.sal`、旧 session metadata 和既有调用的迁移兼容，外部生态覆盖稳定后可删除。

## 用户可见行为

- 顶部工具栏和右侧 Analyzers 面板的 library 只显示 `Saleae Native` 与 `Sigrok Native (PXView)`。
- Async Serial、I2C、SPI 的 `Decoder Library` 不再允许新选 Legacy Rust。
- 已导入或恢复的 Legacy Rust analyzer 不会损坏；设置页会显示 disabled 的 `Legacy Rust (compatibility only)`，用户可将它迁移到 Saleae Native 或 Sigrok Native。
- 仅由旧 Rust 占位提供的 Manchester 不再出现在新建 catalog；后续应通过 Saleae 或 Sigrok 生态接入。

## 代码落点

- `src/lib/analyzers.ts`
  - catalog 移除 `legacy_rust` group。
  - 新建后端 options 只返回外部 native backend。
  - 兼容标签明确标记为 `compatibility only`。
- `src/components/AnalyzerSettingsDialog.tsx`
  - 旧 analyzer 保留 disabled 的当前后端 option，可迁移但不可重新选择。
- `tests/analyzer-backends.test.ts`
  - 锁定外部生态唯一新建入口，并验证旧 metadata 仍可恢复。

## 边界

- 本次不删除 Rust enum、旧 decoder 代码或序列化字段，以免破坏历史 capture。
- `decodeUartFrames` 等旧兼容 API 暂时保留；新 UI 与新协议不得调用它们作为默认路径。
- 后续删除条件是 Saleae Native / Sigrok Native 已覆盖现有用户 capture，且 metadata migration 已完成。

## 验证

```sh
node --test tests/analyzer-backends.test.ts
pnpm build
cargo test --workspace --no-fail-fast
```

## 对应提交

- `refactor: retire legacy rust analyzer creation`
