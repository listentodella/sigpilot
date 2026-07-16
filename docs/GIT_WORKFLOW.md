# Git 管理约定

## 仓库边界

主仓库只管理 PXLogic Studio 的可运行代码和已经明确搬入的小型资源：

- React / Tauri 前端
- Rust crates
- Tauri 命令层
- 项目配置
- 搬运记录文档

以下目录作为本地参考或调试产物保留，不进入主仓库历史：

- `.app-data/`
- `pxview-fork/`
- `debug-captures/`
- `node_modules/`
- `target/`
- `dist/`

## 搬运一个功能的流程

1. 在 Saleae 恢复源码中定位原版实现。
2. 记录原版参考路径。
3. 将功能搬入当前 React/Tauri 状态模型。
4. 执行构建或浏览器验证。
5. 新增 `docs/ported-features/YYYY-MM-DD-功能名.md`。
6. 更新 `docs/PORTING_LOG.md` 索引。
7. 提交 Git：

```bash
git add .
git commit -m "port: 功能名"
```

## 建议提交粒度

- 一个用户可见功能一个提交。
- 若功能较大，先提交可运行骨架，再提交具体交互细节。
- 文档必须和对应功能在同一提交或紧随其后的文档提交中出现。

