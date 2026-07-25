# 通道右键菜单运行时一致性

## 本次修正

- 有捕获数据时，通道标签与波形图表的右键菜单都显示并启用 `Delete Data`。
- 空 session 不显示 `Delete Data`，与原版 `trimAllowed` 语义一致。
- 波形图表从右键点击的 sample 裁剪。
- 通道标签没有波形 X 坐标，因此从当前 viewport 左边界裁剪；`Off Screen` 仍保留当前可见区间。

## 原版依据

- 恢复源码：`.app-data/saleae-logic-2.4.43/recovered-ui-source/app/application/compositions/GraphRow/RowContextMenu.tsx`
- Trim API：`.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/useTrimApi.ts`
- View state：`.app-data/saleae-logic-2.4.43/recovered-ui-source/app/hooks/useViewStateApi.ts`
- Logic 2.4.43 的 9222 运行时实测：D0 左侧标签菜单显示可展开的 `Delete Data`，包含 `Before This Point`、`After This Point`、`Off Screen`。

恢复源码表面的 `!isChannelLabel` 条件与实际 2.4.43 运行行为有差异。本次以用户真正接触到的 9222 运行结果为准，并保留纯函数测试，避免后续把标签入口重新退化为占位。

## 解码架构边界

- 本功能不引入任何 Rust Native 协议解码逻辑。
- 新解码能力只允许接入 Saleae Native 或 Sigrok Native。
- Rust 仅负责 capture、sidecar/FFI/IPC 与结果归一化；Legacy Rust 只读取旧 `.sal`/session metadata，待外部生态覆盖稳定后删除。

## 验证

```sh
node --test tests/channel-context-menu.test.ts
pnpm build
cargo test --workspace --no-fail-fast
```
