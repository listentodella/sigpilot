# 协议标识 Demo

无需硬件或 Tauri，展示 SigPilot 当前支持的全部 **12 种协议标识**。
使用应用实际的 `src/lib/analyzerMarkerDrawing.ts`，不是另一套 SVG 仿制图。

## 启动

在项目根目录执行：

```sh
pnpm demo:markers
```

浏览器访问 **http://127.0.0.1:1421/**。默认端口被占用时，可以使用
`pnpm demo:markers --port 1422`。不要直接双击 `index.html`，页面需要 Vite 编译 TypeScript。

## 展示内容

- 4 条合成数字波形，覆盖全部 12 种标识。
- 每个标识的 **1× 实际大小**和 **4× 放大**图鉴；点击卡片或波形上的标识查看说明。
- 波形时间缩放、平移、视图复位；标识默认保持实际大小，也可选择演示放大。
- 深色 / 浅色主题、图鉴普通标识的通道颜色调整。
- 选中标识对应的 SigPilot 数据与 Saleae SDK 调用示例。
- “导出 PNG”保存当前视口的波形图（不是采集文件）。

**这是可视化 fixture，不是有效的 I3C / SPI / SWD 事务，也不执行协议解码。**
类型文字、选中光圈、2× / 4× 放大是 Demo 辅助显示，不是应用的新能力。
图鉴颜色只影响图鉴和详情预览；波形颜色来自对应通道的主题颜色。

| SigPilot `kind` | Saleae SDK | 外观 |
| --- | --- | --- |
| `dot` | `Dot` | 采样圆点 |
| `error_dot` | `ErrorDot` | 错误圆点 |
| `square` | `Square` | 小方块 |
| `error_square` | `ErrorSquare` | 错误方块 |
| `up_arrow` | `UpArrow` | 上升沿箭头 |
| `down_arrow` | `DownArrow` | 下降沿箭头 |
| `x` | `X` | 普通叉号 |
| `error_x` | `ErrorX` | 错误叉号 |
| `start` | `Start` | 开始圆点 |
| `stop` | `Stop` | 结束方块 |
| `one` | `One` | 方框内数字 1 |
| `zero` | `Zero` | 方框内数字 0 |

颜色、字体和尺寸来自当前 SigPilot 绘制实现，不宣称与 Saleae SVG 像素完全一致。

## 使用示例

### Saleae 兼容的 C++ 解码器

下面的片段依次输出 12 种标识。同一通道按采样编号递增添加，采样位置必须落在实际捕获范围内。

```cpp
using Type = AnalyzerResults::MarkerType;
const Type types[] = {
    AnalyzerResults::Dot, AnalyzerResults::ErrorDot,
    AnalyzerResults::Square, AnalyzerResults::ErrorSquare,
    AnalyzerResults::UpArrow, AnalyzerResults::DownArrow,
    AnalyzerResults::X, AnalyzerResults::ErrorX,
    AnalyzerResults::Start, AnalyzerResults::Stop,
    AnalyzerResults::One, AnalyzerResults::Zero,
};

// results 是 AnalyzerResults 派生实例，channel 是目标 Channel。
for (U64 i = 0; i < 12; ++i)
    results.AddMarker(100 + i * 100, types[i], channel);
results.CommitResults();
```

真实解码器应在识别到对应事件时添加，而不是无条件在时钟上铺满这些类型。

### SigPilot 渲染数据

标识位于通道的 `AnalyzerTrackWindow.protocol_markers`。
通道编号属于 track，单个标识只有采样位置和类型：

```ts
import type { AnalyzerProtocolMarker } from "../../src/lib/api";

const kinds: AnalyzerProtocolMarker["kind"][] = [
  "dot", "error_dot", "square", "error_square",
  "up_arrow", "down_arrow", "x", "error_x",
  "start", "stop", "one", "zero",
];
const protocol_markers: AnalyzerProtocolMarker[] = kinds.map((kind, index) => ({
  sample: 100 + index * 100,
  kind,
}));
// 放入对应通道的 track；这段代码不是新的应用数据注入 API。
```

普通 `X` 不等于错误：SWD 可用它表示 turnaround。I3C 解码器也可能借用
`One/Zero` 表示 IBI 接受/拒绝，而不是线上的比特值。本页详情说明了这些区别。
当前仍是这 12 种固定类型，尚未添加 I3C 专用图标、自定义文本或时间区间标注。

## 检查和构建

```sh
node --test tests/analyzer-marker-demo.test.ts tests/analyzer-marker-drawing.test.ts tests/analyzer-markers.test.ts
pnpm exec tsc --noEmit
pnpm exec tsc --project tools/analyzer-markers-demo/tsconfig.json --noEmit
pnpm exec vite build --config tools/analyzer-markers-demo/vite.config.ts
```

构建结果在此目录的 `dist/`。可使用
`pnpm exec vite preview --config tools/analyzer-markers-demo/vite.config.ts --port 1421`
预览构建后的页面。
