# annotation-overlay-verify

在**真实 Chrome** 中挂载应用实际的 `WaveformAnnotationsOverlay`，用合成数据断言
DOM、图标像素与交互。`node --test` 覆盖不到的问题都在这里暴露：样式缺失、
canvas 没绘制、标题溢出、拖动没提交。

## 运行

```sh
tools/annotation-overlay-verify/run.sh
```

需要 Chrome（可用 `CHROME_BIN` 覆盖）与 `python3`。脚本会：

1. 用 vite 打包真实的覆盖层组件；
2. 在 `127.0.0.1:8802` 提供静态页面；
3. 用 `--dump-dom` 抓取断言结果（页面在 load 前同步完成）；
4. 额外输出 `annotations.png` 供人工查看。

## 断言内容

| 类别 | 检查 |
| --- | --- |
| 结构 | 每个标注一个元素；拥挤标题收起但图形保留；图形不越出视口；不同通道落在不同行 |
| 绘制 | 每个图标 canvas 都有非透明像素；颜色取自标注颜色；不同颜色互不串色 |
| 样式 | 覆盖层绝对定位、`pointer-events: none`、层级高于波形；图形本身可点击；标题在图标右侧 |
| 悬停 | tooltip 同时含标题、通道/采样位置与备注；移出后消失 |
| 交互 | 点击选中；双击/Enter 打开编辑器；Delete 删除；Escape 取消选中 |
| 拖动 | 100 px / 1000 采样视口移动 100 个采样，且只提交一次 |
| 只读 | 采集进行中隐藏编辑按钮，并忽略 Delete 与拖动 |
| 边界 | 选中且靠近右边界时标题翻转到左侧 |
| 编辑器 | 模态与 `aria-modal`；标题预填并自动聚焦；保存时裁剪空白；空标题与越界采样点被拒并报错；删除/关闭/Escape 各自回调 |

## 已知取舍

- **指针捕获是桩**：脚本化的 `pointerdown` 没有真实 pointer id，真实
  `setPointerCapture` 会抛错。工具替换了这三个方法，其余拖动路径
  （阈值、换算、提交）不变。
- 这里只验证覆盖层本身，不启动 Tauri 后端，也不读取真实采集。
