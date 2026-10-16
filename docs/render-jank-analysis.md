# 渲染抖动与闪现：系统性分析

> 用户报告（2026-09-24）：缩放时渲染动画多数情况下不流畅；解码气泡聚集/分散时、
> 尤其是缩放让其他段落波形同时进入同一窗口时，出现明显闪现，疑似瞬间黑屏（像整体重绘）。
> 本文给出术语、现象分类、成因假设、可量化指标与验证方式，以及需要补充的信息。

---

## 0. 先回答"有没有日志锚点"

**有两个，但缺最关键的一个。**

| 锚点 | 位置 | 记录什么 | 开关 |
| --- | --- | --- | --- |
| **绘制路径探针** | `src/lib/waveformDrawProbe.ts` | **走了 6 条绘制路径中的哪一条**、栅格放大倍数 `stretch`、`samplesPerPixel` | 仅 DEV，`window.__PXLOGIC_DRAW__.{summary,recent,reset}()` |
| **解码耗时锚点** | `src/lib/analyzerPerformance.ts` | `stage` + `elapsed_ms`（`console.debug`） | `localStorage["pxlogic:analyzer-timing"] = "1"` |
| **帧节拍（本次新增）** | `src/lib/framePacingProbe.ts` | 帧间隔 p50/p95/p99/max、回调耗时、**掉帧比例**、长任务 | `localStorage["pxlogic:frame-timing"] = "1"`，`window.__PXLOGIC_FRAMES__` |

**缺口就是帧节拍**：前两个能回答"走了哪条路 / 花了多久"，但**回答不了"帧有没有按时出"**。
一个手势可以每帧都走像素精确路径，却因为每帧要处理的样本数不同而卡顿 ——
**没有帧间隔，这类问题只能靠形容词描述**，也就无法判断某次改动到底有没有改善。

---

## 1. 术语对照（前端/浏览器渲染领域）

| 中文描述 | 专业术语 | 含义 |
| --- | --- | --- |
| 不流畅、一顿一顿 | **Jank** | 帧未能按刷新周期产出，帧间隔 > 帧预算 |
| 掉帧 | **Dropped frame / Missed frame** | 某一帧超预算，用户看到的是上一帧 |
| 一帧很慢 | **Long frame / Long task** | 主线程被占用 > 50ms（Long Task API 的定义） |
| 帧预算 | **Frame budget** | 60Hz → 16.7ms；120Hz → **8.3ms** |
| 交互到下一帧 | **INP** (Interaction to Next Paint) | Core Web Vital，衡量输入响应性 |
| 整体重绘、像黑屏 | **Full repaint / Clear-then-draw flicker** | 先清空再重画，若中间被呈现就是空帧 |
| 闪现一下 | **Visual pop / Flicker** | 相邻两帧内容差异过大（保真度突变） |
| 笔画忽粗忽细、发糊 | **Raster magnification / Stretch blur** | 低分辨率栅格被放大后绘制 |
| 布局反复重算 | **Layout thrashing / Forced synchronous layout** | 读写布局属性交替，触发同步重排 |
| 图层失效 | **Compositing invalidation** | 合成层被标记为脏，需要重新合成 |
| 瓦片失效 | **Tile invalidation / Cache miss** | 缓存栅格不再覆盖当前视口 |
| 双缓冲 | **Double buffering** | 避免"清空-重画"被看到的常规手段 |

**关键区分：**
- **Jank（时间维度）** = 帧来晚了 → 表现为"不流畅"
- **Pop/Flicker（内容维度）** = 帧按时到了，但内容和上一帧差太多 → 表现为"闪现"
- **黑屏** = 某一帧几乎没有内容，而背景是近黑色 → 观感上等同空帧

**用户的描述里同时包含这两类**，必须分开量测，否则会互相掩盖。

---

## 2. 现象分类

| # | 用户描述 | 归类 | 可能机制 |
| --- | --- | --- | --- |
| A | 缩放时"多数情况不流畅顺滑" | **Jank** | 帧成本随缩放档位剧烈变化；同步主线程渲染；气泡 DOM 重排 |
| B | 气泡聚集/分散时"明显闪现" | **Pop / Flicker** | 气泡是 **DOM**，与 canvas 是两套渲染；聚集态切换导致节点增删 |
| C | 缩放让其他段落波形进入同一窗口时"疑似瞬间黑屏" | **Clear-then-draw 观感** | 绘制路径降级到"只有边沿"的分支，背景近黑 → 看起来像黑屏 |
| D | "相当于整体重新绘制" | **Full repaint** | 瓦片/视口栅格缓存未命中，全部重画 |

---

## 3. 成因假设（基于代码，非推测）

### 3.1 ★ 绘制路径的降级链会在缩放中反复切换（对应 A + C + D）

`WaveformCanvas.tsx:1631 drawCachedWaveLayer` 在 6 条路径间选择，
其中"视口比瓦片更细"时的降级顺序是（`1653`–`1725`）：

| 顺序 | 路径 | 代价 / 观感 |
| --- | --- | --- |
| 1 | `viewport-raster` | worker 按**当前缩放**渲染，像素精确 ← 理想 |
| 2 | `stale-tile-raster` / `stale-viewport-raster` | 复用旧栅格，**被放大 → 笔画变粗/发糊** |
| 3 | `view-space-render` | **主线程同步渲染**（`renderWaveLayer`, `1715`）→ 长任务、掉帧 |
| 4 | `exact-segments` | **只有边沿线段，没有波形主体** |

**每次在这些路径之间切换，屏幕上就是一次保真度突变** —— 这正是"闪现"。
而路径选择取决于**运行时状态**（瓦片粒度、worker 栅格是否恰好覆盖当前视口、缓存是否还在），
所以**缩放过程中会在 1↔2↔3 之间反复跳**，看起来既不流畅又在闪。

`waveformDrawProbe.ts:3-8` 的注释本身就是这个意思：

> *"`drawCachedWaveLayer` picks between **six ways** of putting pixels on screen...
> Reasoning about which branch a gesture takes from the source is how you end up fixing the wrong one"*

### 3.2 ★ 近黑背景把"低内容帧"放大成"黑屏"（对应 C）

`WaveformCanvas.tsx:1462`：

```ts
ctx.fillStyle = "#101013";     // 近黑
ctx.fillRect(0, 0, width, height);
```

清空 + 填底 + 绘制**在同一个同步任务里**（`1461`–`1488`，无 await），
**所以不存在"清空后被呈现"的空帧** —— 这点是排查过的、没问题的。

**但当降级到 `exact-segments`（只有边沿）时，画面内容极少，在 `#101013` 上几乎全黑**
→ 观感就是"瞬间窗口黑屏"。**不是真的空帧，是内容太少**。

`1706-1709` 的注释说明这一类问题**历史上出现过并且被修过一次**：

> *"...so the graph is never blank while a worker render is in flight:
> drawing nothing here is what made a zoom look like it had **erased the trace**
> and forced the user to nudge the viewport until it came back."*

**也就是说"看起来被擦掉"是已知复发型问题**，现在的降级链是当时的对策。
**用户这次报告的现象很可能是同一类问题在另一个分支上重现。**

### 3.3 气泡是 DOM，与 canvas 是两套渲染（对应 B）

`AnalyzerBubblesOverlay.tsx:359-362` 的注释：

> *"Bubbles are always drawn as **DOM**. Logic has a single rendering path for them,
> and the **canvas preview this replaced was the reason the text sat left-aligned
> while the viewport moved and snapped to centred once it stopped: the preview and
> the DOM disagreed about alignment**."*

**所以同一屏内容由两套系统产出**：气泡（DOM/React）+ 标记（canvas）。
缩放让"其他段落波形进入同一窗口"时：
- 气泡**聚集/分散** → React 节点增删 → **布局 + 绘制**
- 标记 canvas 同时 `clearRect` 重画（`348`）
- 波形 canvas 同时重画

**三件事挤在同一帧** → 长帧（A）；**DOM 与 canvas 若差一帧** → 闪现（B）。

**另外注意**：`339-342` 里 `canvas.width = pixelWidth` 会**重置 canvas**。
这次核对下来它与绘制在**同一个 rAF 内**（`329` 起），**当前是安全的**；
但这是脆弱结构 —— 任何把绘制拆到另一个 rAF/异步步骤的改动都会立刻变成黑屏。

### 3.4 同步主线程渲染（对应 A）

`1715 renderWaveLayer(canvas, tile, ...)` 是**主线程同步**渲染，注释自陈 *"correct, but synchronous"*。
样本数大、缩放细时，这是**一个长任务**，必然掉帧。**这是"不流畅"最直接的解释。**

---

## 4. 可量化指标

### 4.1 时间维度（判断 A）

| 指标 | 定义 | 健康值 |
| --- | --- | --- |
| **帧间隔 p50** | 帧与帧的时间差中位数 | ≈ 帧预算（16.7 / 8.3 ms） |
| **帧间隔 p95 / p99** | 尾部延迟 | p95 < 2× 预算 |
| **掉帧比例** | 帧间隔 > 1.5× 预算的占比 | **< 5%** |
| **最长帧间隔** | 最严重的一次停顿 | < 50 ms |
| **长任务数 / 最长长任务** | 主线程 > 50ms 的块 | 0 |
| **rAF 回调耗时 p95** | 每帧自身工作量 | < 预算的 50% |

### 4.2 内容维度（判断 B / C / D）

| 指标 | 定义 | 健康值 |
| --- | --- | --- |
| **绘制路径切换频率** | 每秒路径变化次数（现有探针可算） | 手势期间**接近 0** |
| **`exact-segments` 占比** | 只有边沿的帧占比 | 手势期间**接近 0** |
| **`stale-*` 占比** | 复用旧栅格的帧占比 | 手势期间 < 20% |
| **`stretch` 最大值** | 栅格放大倍数 | 手势期间 ≤ 1.5 |
| **`view-space-render` 占比** | 同步主线程渲染的帧占比 | 手势期间 < 10% |
| **每帧气泡节点增删数** | React 提交时的 DOM 变更 | 平稳（不随缩放剧烈波动） |

**判据组合：**
- **路径频繁切换 + 帧间隔正常** → 问题在**内容保真度**（Pop/Flicker），不是性能
- **帧间隔差 + 路径稳定** → 问题在**帧成本**（Jank），要削每帧工作量
- **两者都差** → 降级链在"用低质量换时间"，但换得不够，两头都输

---

## 5. 验证方式

### 5.1 用现有 + 新增锚点（最快，不用装工具）

```js
// 一次性打开开关，然后刷新
localStorage.setItem("pxlogic:frame-timing", "1");
localStorage.setItem("pxlogic:analyzer-timing", "1");

// 刷新后，开始录制
__PXLOGIC_FRAMES__.reset();
__PXLOGIC_FRAMES__.start(60);   // 120Hz 屏传 120

// —— 手动做一次缩放/平移手势 ——

__PXLOGIC_FRAMES__.stop();
__PXLOGIC_FRAMES__.summary();
// → frames / intervalP50 / p95 / p99 / intervalMax
//   / workP95 / workMax / missedFrameRatio / longTasks / longTaskMaxMs

__PXLOGIC_DRAW__.summary();
// → 每条路径的 count / share / maxStretch  ← 看 exact-segments 与 stale-* 占比
__PXLOGIC_DRAW__.recent();      // 逐帧路径序列 ← 看切换有多频繁
```

**先跑这一组，就能把"闪现"从形容词变成两个数字**：
`exact-segments` 的 share，以及 `intervalMax`。

### 5.2 Chrome/Electron DevTools Performance（看根因）

1. 打开 Performance 面板，开始录制
2. 做**一次**缩放手势（不要连续滚很多格），停止
3. 看三处：
   - **Frames 轨道**：红色/长条帧的数量与位置 → 对应 A
   - **Main 轨道**：`renderWaveLayer`、React `commit`、`Layout` 的宽度 → 定位长任务
   - **Screenshots 轨道**：**逐帧缩略图** ← **这一条最直接地验证"黑屏/闪现"**，
     能肉眼看到哪一帧是空的

### 5.3 React DevTools Profiler（看气泡）

录制一次缩放，看 `AnalyzerBubblesOverlay` 的提交次数与耗时，
以及每次提交**新增/删除的 DOM 节点数** → 对应 B。

### 5.4 对比基线

**同一手势、同一采集**，在以下两种状态下各测一次：
- 有解码气泡（分析器已解码）
- 无解码气泡（没有分析器）

若差异显著 → B 是主因；若无差异 → 主因在 3.1/3.4。

---

## 6. 需要你补充的信息

**按重要性排序：**

1. **平台与刷新率**：Electron 版本、屏幕刷新率（60 / 120Hz）、`devicePixelRatio`、
   窗口尺寸 —— **帧预算和 `stretch` 都依赖这些**。
2. **复现时的采集规模**：采样率、通道数、总样本数；以及缩放**前后**大致看到多少样本。
   （决定 `view-space-render` 一帧要处理多少数据）
3. **时机**：抖动是在**采集进行中**还是**采集停止后**？两者走的视口归一化不同
   （`normalizeLiveCaptureViewport` vs `normalizeCaptureViewport`）。
4. **是否开了后台解码**（`backendDriven`）：这条路径下滚轮会把意图发给后端再回来
   （`WaveformCanvas.tsx:789 dispatchSessionViewIntent`），**往返延迟本身就可能造成抖动**。
5. **是否有解码气泡**：哪些分析器、气泡密度大概多少。
6. **上面 §5.1 的两段输出**（`__PXLOGIC_FRAMES__.summary()` 与 `__PXLOGIC_DRAW__.summary()`），
   以及**一次 Performance 录制的 Screenshots 轨道截图**。
7. **"黑屏"持续多久**：一帧（~16ms，几乎看不见）还是明显可感知（>100ms）？
   **这决定了是"内容太少"还是"真的空帧"**，是本次定位最关键的一个分叉。

---

## 7. 初步结论与建议的修复方向（待数据确认后再动手）

| 假设 | 若成立，修法 | 风险 |
| --- | --- | --- |
| 降级链频繁切换（3.1） | 缩放期间**锁定一条路径**，宁可短暂降质也不切换；或让 worker 视口栅格**提前一拍**产出 | 中 |
| `exact-segments` 太"空"（3.2） | 该分支下**保留上一次的波形主体**做底，只在其上补边沿（即不要清到只剩边沿） | 低 |
| 气泡 DOM 与 canvas 不同步（3.3） | 气泡的增删**与波形绘制放在同一帧**提交；或把气泡也移入同一 canvas | 中 |
| 同步主线程渲染（3.4） | 扩大 worker 栅格的覆盖范围，减少落到 `view-space-render` 的次数 | 中 |

**我倾向先做"3.2 的底图保留"** —— 它是纯增量、风险最低，而且直接对应"像被擦掉/黑屏"的观感，
与 `1706-1709` 注释里描述的历史问题同源。

**但在拿到 §6.7（黑屏持续多久）之前，我不建议动手** ——
"内容太少"和"真的空帧"是两种完全不同的成因，修法也不同。

---

# 实测记录（2026-09-24）：已复现"闪现"的机制

**方法**：用 Playwright 驱动系统 Chrome 打开 Vite dev server（`127.0.0.1:1420`），
加载 demo 设备 → 采集 → 停止 → 滚轮缩放，用探针记录逐帧数据。
（**限制**：测的是 Chrome，不是 Tauri 的 WKWebView；且尚未成功加载解码分析器，
所以"气泡"那一半还没复现。见文末。）

## 结论：**不是 Jank，是内容保真度问题** —— 与 §4.2 的判据完全吻合

| 场景 | 帧间隔 p50 / p99 | **掉帧比例** | 回调耗时 max |
| --- | --- | --- | --- |
| 采集中·空闲 3s | 16.7 / 16.8 ms | **0** | 1.4 ms |
| 采集中·滚轮缩放 | 16.7 / 16.8 ms | **0** | 27.8 ms |
| **停止后·滚轮放大** | 16.7 / 16.8 ms | **0** | 13.1 ms |
| 停止后·滚轮缩小 | 16.7 / 16.8 ms | **0** | 4.8 ms |

**帧节拍完全健康，长任务 0** —— 所以"不流畅"不能用掉帧解释。

## ★ 逐帧绘制路径：一个严格 4 帧周期的"变糊帧"

停止采集后滚轮放大 10 格的逐帧序列（`__PXLOGIC_DRAW__.recent()`）：

```
  0 tile-raster            stretch=1.000
  1 stale-tile-raster      stretch=1.414   <-- 切换
  2 viewport-raster        stretch=1.000   <-- 切换
  3 viewport-raster        stretch=1.000
  4 viewport-raster        stretch=1.000
  5 stale-viewport-raster  stretch=1.414   <-- 切换   ← 每 4 帧一次
  6 viewport-raster        stretch=1.000   <-- 切换
  7 viewport-raster        stretch=1.000
  8 viewport-raster        stretch=1.000
  9 stale-viewport-raster  stretch=1.414   <-- 切换
 10 viewport-raster        stretch=1.000   <-- 切换
 ...（规律重复到第 40 帧）
```

**20 次路径切换 / 41 帧；`stretch` 在 1.000 与 1.414 之间来回跳。**

- **`stretch = 1.414 = √2` 正好是滚轮每格的缩放比** —— 所以"上一档栅格"恒差 √2 倍
- 每 4 帧有 1 帧用**放大 41% 的旧栅格**绘制 → **笔画粗 41%、边缘发糊**
- 60Hz 下这是**每 ~67ms 一次的规律性闪烁** → **肉眼可感知的"闪现"** ✓

**这就解释了"像整体重新绘制"**：不是整体重绘，是**保真度在 1.000 ↔ 1.414 之间周期性跳变**。

## 根因：worker 栅格的生产延迟 ≥ 滚轮改变视口的间隔

`src/lib/waveLayerWorker.ts:226-233`：

```ts
if (sameViewportWorkerRequest(state.viewportActive, request)) return;
if (state.viewportActive) {
  // Latest-only: a zoom gesture produces a new viewport every frame and every
  // earlier one is already obsolete by the time it could be rendered.
  state.viewportQueued = request;     // ← 排队等当前这个完成
  return;
}
startViewportWorkerRequest(state, request);
```

**"Latest-only" 策略下同一时刻只有一个栅格在飞。** 一档栅格从请求到可用约需 2–3 帧，
而滚轮约每 4 帧改一次视口 → **每一档视口首次绘制时都拿不到自己的栅格，只能拿上一档放大**。

**周期之所以严格是 4 帧**，就是因为"生产延迟"与"消费间隔"在这个 demo 上正好形成固定相位差。

## 修复方向（按收益/风险）

| # | 做法 | 预期 | 风险 |
| --- | --- | --- | --- |
| **1** | **stale 帧不要放大**：`blitAnyCachedRaster` 改用 `stretch=1` 的**裁切**方式（只画重叠区，边缘用精确边沿补），而不是缩放整张栅格 | **stretch 恒定 1.0 → 闪烁消失**；代价是边缘可能短暂缺一点 | 低 |
| **2** | **保留相邻档栅格**，选**放大倍数最小**的那张（现在固定选"上一档"） | stretch 从 1.414 降到接近 1.0 | 低 |
| **3** | **预测性预请求**：滚轮是离散的（每格 √2），在当前帧就预取下一档 | 栅格在需要时已就绪 | 中 |
| **4** | **缩短往返**：把 viewport raster 的提交提前到本帧 rAF 之前 | 减少 stale 帧数 | 中 |

**推荐 1 + 2**：都是低风险、纯画质修正，且**不改变任何交互逻辑**。
第 1 条尤其对症 —— 它把"变糊"换成"短暂缺边缘"，后者在密集波形上几乎不可见。

## 尚未复现 / 下一步

1. **解码气泡那一半还没复现** —— 自动点"Add Analyzer"没有生效（`decodeRows: 0`）。
   需要手动或换一种选择方式，之后重测"气泡聚集/分散"场景。
2. **测的是 Chrome，不是 Tauri 的 WKWebView**。帧节拍与绘制路径由 JS 决定，
   结论应可迁移，但 WKWebView 的合成/绘制成本不同，**最终需在 Tauri 里复测确认**。
3. **用户报告的"几帧可感知的闪现"**与实测的"每 4 帧一次 stretch 跳变"在时间尺度上吻合
   （4 帧 ≈ 67ms，属于"非常短但可感知"），**支持"内容保真度跳变"而非"真空帧"**。

---

# 与 Saleae 的对比，以及据此更新的方案（2026-09-24）

## 1. 先补齐 pxlogic 侧的最后一环：门槛在哪

`src/lib/waveformTileCoverage.ts:94`：

```ts
export function rasterServesViewport(sourceStart, sourceSamples, sourceWidthPx,
                                     viewportStart, viewportSamples, canvasWidthPx) {
  if (!rasterCoversViewport(...)) return false;
  const magnification = rasterMagnification(sourceSamples, sourceWidthPx, viewportSamples, canvasWidthPx);
  if (!(magnification > 0)) return false;
  return magnification <= 1.05;          // ★ 关键门槛
}
```

**`viewport-raster` 只在 `magnification ≤ 1.05` 时被接受** —— 也就是**栅格必须至少和视口一样细**。

**于是 4 帧周期的成因完全闭合：**

| 帧 | 视口 | 缓存的 viewport raster | magnification | 走哪条路 |
| --- | --- | --- | --- | --- |
| N | V | 为 V 渲染 | 1.00 | `viewport-raster` ✓ |
| N+1 | V/√2（放大一格） | 仍是 V 的 → 比视口**粗** √2 | **1.414 > 1.05 → 拒绝** | **`stale-viewport-raster`，放大 1.414** ✗ |
| N+2 | V/√2 | 新栅格到达（为 V/√2 渲染） | 1.00 | `viewport-raster` ✓ |
| N+3 | V/2（再放大一格） | 仍是 V/√2 的 | **1.414 → 拒绝** | **stale** ✗ |

**结论：`stretch` 恒为 √2 不是巧合 —— 滚轮每格正好把视口变细 √2，而缓存的栅格永远差一档。**

## 2. Saleae 怎么处理这个问题

### 2.1 它的视图状态**住在渲染器里**，不在前端

`RenderingManager.ts` 暴露的是**意图消息**，而不是"渲染某个视口的栅格"：

| 消息 | 语义 |
| --- | --- |
| `SetRenderViewState` | 设置视图状态 |
| `AnimateViewStateZoom` / `ZoomAbsolute` | 缩放（相对/绝对） |
| `AnimateViewStatePanPixels` / `PanDecay` / `PanIndefinite` | 平移 / 惯性 / 持续 |
| `AnimateViewStateToTime` / `ToRange` | 到时间点 / 区间 |
| **`AnimateViewStateCancel`** | **显式取消** |
| `RenderingManager::Interpolation` / `EaseOut` | **插值在渲染器内部做** |

**关键：这套 API 里没有"为某个视口请求一张栅格"这种概念。** 视图状态是渲染器的**一个属性**，
渲染器**每帧按当前 scale 直接画**。

### 2.2 直接操作用的是 `duration: 0`，不是另一条路径

```ts
public async move({ leftEdgeTime }) {
  await this.animateToTime({ destinationTime: leftEdgeTime, destinationPosition: 'Left', duration: 0.0 });
}
public async horizontalPanPixels({ deltaPixels }) {
  await this.animatePanPixels({ deltaPixels, duration: 0 });      // ← 立即
}
```

**所以"立即"和"动画"是同一个消息的两种 `duration`**，不是两套渲染路径。
`AnimateViewStateCancel` 负责打断进行中的插值。

### 2.3 根本差异

| | **Saleae** | **pxlogic** |
| --- | --- | --- |
| 视图状态持有者 | **原生渲染器** | 前端 JS |
| 渲染粒度 | **每帧按当前 scale 直接画** | **为某个视口异步生产一张栅格** |
| 栅格是否绑定视口 | **不绑定** —— 没有"视口栅格"概念 | **绑定** —— 视口一变就过期 |
| 视口变化快于渲染时 | 渲染器插值追赶，**不存在"放大旧图"** | **放大旧栅格**（`stretch > 1`）→ 变糊/闪烁 |
| 取消机制 | `AnimateViewStateCancel` | `viewportQueued` latest-only 排队 |

**一句话：Saleae 的架构里不存在 `stretch` 这个东西**，所以它不需要"对抗"这个问题；
pxlogic 的 `stretch` 是"栅格绑定视口 + 异步生产"这个架构选择的必然产物。

## 3. 更新后的方案

### 3.1 先排除一个看起来对、其实无效的改法

**放宽 `magnification <= 1.05` 这个门槛是错的。**
放宽到 1.414 只会让**同一条路径**接受那张被放大 √2 的栅格 —— 路径名从 `stale-*` 变成 `viewport-raster`，
**画面照样糊 41%**，只是探针看不出来了。**治的是指标，不是问题。**

### 3.2 方案 A（主）：让 worker 栅格**超采样一档** —— 对齐 Saleae 的"总是够细"

Saleae 的渲染器永远按当前 scale 画，所以"细度永远匹配"。
pxlogic 拿不到这个保证（栅格必然滞后），**但可以用多画一点像素把同样的保证买回来**：

> 请求 viewport raster 时，按**比当前视口细一档（×1/√2 的 samples-per-pixel）**渲染。

于是视口再放大一格时，已有栅格的 `magnification` 仍是 **1.0 ≤ 1.05** → **继续走 `viewport-raster`，stretch 恒 1.0**。

- **收益**：**stretch 恒定 1.0，4 帧周期的糊帧消失** —— 直接消除用户看到的那几帧闪现
- **代价**：**栅格宽度 ×√2 ≈ 填充成本 +41%**（不是 ×2 —— 见下面的核算）
- **改动量**：小 —— 只在请求处把 samples-per-pixel 除以 √2，并在 `blitLayerRaster` 里按真实比例裁切
- **风险**：中 —— 需要确认 worker 的填充成本上升后仍在预算内（见 §3.4）

**成本核算**（`src/lib/waveLayerWorker.ts:283-291`）：

```ts
const overscan = Math.max(64, Math.ceil(viewportSamples * 0.5));      // 两侧各 50%
const renderSamples = renderEnd - renderStart;                        // ≈ 2 × viewportSamples
const rasterWidth = Math.max(1, Math.round((target.width * renderSamples) / viewportSamples));
```

栅格是 `rasterWidth × target.height`，而 **`target.height` 由通道数决定、与缩放无关**。
把分辨率提高 √2 只让 **`rasterWidth` ×√2**，所以**像素总数只涨 √2 ≈ 1.41×，不是 2×**。
（我先前写的"像素 ×2"是错的 —— 只有水平一维随 samples-per-pixel 变化。）

### 3.3 方案 D（辅）：滚轮离散，可以**预取下一档**

滚轮每格固定 √2，是**可预测**的。在当前帧就把下一档的栅格请求发出去，
放大发生时栅格已经就绪，进一步压缩"完全没有可用栅格"的窗口。

**与 A 互补**：A 保证"已有的够用"，D 保证"新的来得更快"。

### 3.4 一个必须先量测的前提

**方案 A 会让 worker 的每帧填充量翻倍。** 实测里 `workMax` 在"采集进行中 + 缩放"时已经到过 **27.8ms**
（超过 16.7ms 的一帧预算，只是没导致掉帧）。**超采样可能把它推得更高，反而制造 Jank。**

**所以动手前必须先测**：把 `viewSamples` 除以 √2 后，重跑同一套自动化脚本，
看 `__PXLOGIC_PACING__.summary()` 的 `workMax` / `missedFrameRatio` 是否恶化。

**若恶化，退到方案 C。**

### 3.5 方案 C（备）：stale 帧**不放大**，只裁切

`blitAnyCachedRaster` 改为按 `stretch = 1` **裁切**（只画重叠区），边缘交给已有的 `drawExactWaveSegments` 补。

- **收益**：stretch 恒 1.0，闪烁消失
- **代价**：栅格比视口粗时，它覆盖的样本范围比视口小 → **边缘会短暂缺一段**（靠精确边沿补，密集波形上几乎看不出）
- **改动量**：小
- **风险**：低

### 3.6 不推荐：把渲染搬进原生渲染器（完全照抄 Saleae）

那才是"真正"对齐 Saleae 的做法（视图状态 + 渲染都进原生层），
但等于重写渲染架构，**与本次问题不成比例**。**方案 A 是用像素换保证，性价比更高。**

## 4. 建议的执行顺序

1. **先测方案 A 的成本**（把 `viewSamples` 除以 √2，重跑自动化脚本看 `workMax`）
2. **成本可接受 → 上 A**（+ D 作为后续优化）
3. **成本恶化 → 上 C**（低风险兜底）
4. **两者都用同一套脚本前后对比 `stretch` 分布** —— 目标：**`stretch > 1.05` 的帧占比从 ~29% 降到 0**

**验证口径（可量化，不靠感觉）：**
- `__PXLOGIC_DRAW__.summary()` 里 `stale-*` 的 `share` → 应降到 0
- `maxStretch` → 应恒为 1.0
- `__PXLOGIC_PACING__.summary()` 的 `missedFrameRatio` → 不应上升

---

# 方案 A 实现与实测（2026-09-24）

## 实现

`src/lib/waveLayerWorker.ts` `requestViewportRaster`：请求视口栅格时把宽度乘 √2，
使栅格**比视口细一档**。栅格立刻绘制时 `magnification = 0.707`，
再放大一格后仍是 `1.000`，**仍 ≤ 1.05 门槛，继续走 `viewport-raster`**。

## 实测结果

| 指标 | 基线 | **方案 A（√2）** | 方案 A（×2，试验） |
| --- | --- | --- | --- |
| `stale-*` 合计 share | **31.5%** | **18.7%** | 12.9% |
| `viewport-raster` 立即 stretch | 1.000 | **0.707** ✓ 证明超采样生效 | 0.500 |
| **`stale` maxStretch** | **1.414** | **1.414（未变）** ✗ | **1.414（未变）** ✗ |
| `workMax`（采集+缩放） | 13.1 ms | **12.2 ms** ✓ 未恶化 | 12.4 ms |
| `missedFrameRatio` | 0 | **0** ✓ | 0 |

**§3.4 的成本疑问已解答：+41% 填充没有造成 Jank。** `workMax` 反而略降（噪声范围内）。

## ★ 但方案 A **不足以消除闪烁** —— 且加大超采样也到不了零

`stale` 的 share 从 31.5% 降到 18.7%（√2）、12.9%（×2），**但 `maxStretch` 始终是 1.414**。

**原因是个跑步机**：栅格从请求到可用需要若干帧，而用户滚轮是持续的。
**超采样只能买到固定的"格数"余量**（√2 买 1 格、2 买 2 格），
**手势快过那个余量时，降级照旧发生**。加大超采样只是把频率压低，**永远追不上**。

**结论：A 是有效的减频措施，不是根治。**

## ★ 修正：方案 C 按原描述实现是**错的**

原方案 C 说"stale 帧只裁切不放大"。核对 `blitLayerRaster`（`WaveformCanvas.tsx:1524`）后发现它**按样本范围映射**：

```ts
const sourceW = ((visibleEnd - visibleStart) / sourceSamples) * sourceWidth;
const destinationWidth = ((visibleEnd - visibleStart) / viewportSamples) * canvas.width;
```

放大倍数就隐含在 `destinationWidth / sourceW` 里。
**改成 1:1 裁切（`destinationWidth = sourceW`）不会只"缺边缘"—— 它会让栅格水平方向比它该占的区域窄，
整段波形横向错位。** 那比模糊更糟。**方案 C 作废。**

## ★ 替代方案 E（更接近 Saleae 的做法，建议改用它）

**核心观察**：降级链的顺序是

```
1. viewport-raster      （magnification ≤ 1.05，像素精确）
2. 请求新的栅格（异步）
3. blitAnyCachedRaster  （stale，被放大 1.414 ← 模糊就来自这里）
4. view-space-render    （主线程同步渲染，magnification = 1，正确）
```

**第 3 步排在正确但较慢的第 4 步之前。** 只要缓存里还能翻出任何一张重叠的栅格，
第 3 步就会命中，**第 4 步永远不会执行** —— 于是画面选择了"放大的近似"而不是"稍慢但正确"。

**方案 E：当唯一可用的栅格需要放大 > 1.05 时，不要用它，直接落到第 4 步的同步渲染。**

这**正是 Saleae 的取舍**：它的渲染器每帧按当前 scale 直接画，**没有"显示放大的近似"这个选项**，
代价是那一帧可能变慢（可能掉帧）。**Saleae 用 jank 换正确性；pxlogic 现在是拿正确性换 jank。**

**风险**：第 4 步是同步主线程渲染。当前 `workMax` 12–13ms，尚有余量，
但需实测确认换成方案 E 后 `missedFrameRatio` 不会上升。

**验证口径**：`stale-*` share → 0、`maxStretch` → 1.0、`missedFrameRatio` 不上升。
若 `missedFrameRatio` 上升，则说明同步渲染太贵，**退回"A 减频 + 接受残余闪烁"**，
或考虑把第 4 步也搬进 worker（但那需要 worker 能返回"当前视口"的栅格，即回到延迟问题）。

---

# 方案 E 实现与实测：**闪烁已消除**（2026-09-24）

## 实现

1. `src/lib/waveformTileCoverage.ts`：把重复两处的 `1.05` 抽成导出的
   **`RASTER_SCALE_TOLERANCE`**，让三处判断不会再各自漂移。
2. `src/components/WaveformCanvas.tsx`：新增 `rasterIsNearViewportScale()`，
   在 **`blitAnyCachedRaster` 的两个候选（viewport 缓存、tile 缓存）各自 blit 之前**加门槛。

**门槛必须在 blit 之前** —— `blitAnyCachedRaster` 是**边判断边画**的
（它接收 `ctx`/`canvas`），画完再拒绝的话像素已经在画布上了。

**效果**：唯一可用的栅格若需要放大超过容差，**两张缓存都会被跳过**，
直接落到降级链第 4 步 `view-space-render` —— 同步、按当前 scale 渲染、正确。

## 实测（同一套脚本）

### 放大方向（会产生模糊的方向）

| 指标 | 基线 | 方案 A | **方案 A + E** |
| --- | --- | --- | --- |
| **`stale-*` share** | 31.5% | 18.7% | **0%** ✓✓ |
| **`maxStretch`** | **1.414** | 1.414 | **1.000** ✓✓ |
| 路径构成 | viewport 65.8% / **stale 28.9%** / tile 2.6% | viewport 78% / **stale 15.6%** | **viewport 78.8% / view-space 18.2% / tile 3.0%** |
| `workMax` | 13.1 ms | 12.2 ms | **10.3 ms** ✓ 更低 |
| `missedFrameRatio` | 0 | 0 | **0** ✓ |

**逐帧序列的 `stretch` 范围从 `1.000..1.414` 变成 `0.707..1.000`** —— **一个放大帧都没有了**：

```
 15 view-space-render      stretch=1.000   ← 原先是 stale @ 1.414
 16 viewport-raster        stretch=0.707
 17 viewport-raster        stretch=0.707
 18 viewport-raster        stretch=0.707
 19 viewport-raster        stretch=1.000
 20 viewport-raster        stretch=1.000
 21 viewport-raster        stretch=1.000
 22 view-space-render      stretch=1.000   ← 原先是 stale @ 1.414
```

`0.707` 是栅格比视口**细**（缩小绘制，清晰），`1.000` 是像素精确。
**两者都不会让笔画变粗** —— **变糊的机制被彻底消除。**

### 缩小方向

残余的 `stale-viewport-raster` 是 **`stretch = 0.354`**（远小于 1），
即栅格比视口**细得多**，绘制时是缩小 —— **清晰，无害**。方向性的模糊只在放大时发生。

## 结论

- **方案 A**：有效减频（31.5% → 18.7%），成本可忽略，**但到不了零**
- **方案 E**：**把"放大的近似"这个选项从降级链里去掉**，`stale` 归零、`stretch` 上界降到 1.000
- **两者叠加**：既减少了降级次数，又让残余降级不再可见
- **成本没有恶化，反而更好**（`workMax` 13.1 → 10.3 ms）——
  说明同步的 `view-space-render` 在这套数据上并不比"放大 blit + 精确边沿"更贵

**这正是 Saleae 的取舍被搬了过来**：宁可那一帧慢一点（甚至掉帧），
也不给用户看一张尺度不对的图。实测表明在这套负载下**连慢都没变慢**。

## 验证

- `npx tsc --noEmit` → **0 errors**
- 前端 **153 passed / 0 failed**（更新了 `wave-layer-worker.test.ts` 里断言栅格宽度的用例，
  改为显式断言 √2 超采样）
- `npm run build` → 成功
- `cargo test --workspace` → **200 passed / 0 failed**

## 仍未覆盖

1. **解码气泡场景没复现** —— 自动化里点 "Add Analyzer" 后选菜单没生效，`decodeRows: 0`。
   "气泡聚集/分散"那一半仍未实测。
2. **测的是 Chrome，不是 Tauri 的 WKWebView** —— JS 层结论应可迁移，但合成成本不同，
   **需在 Tauri 里复测**。
