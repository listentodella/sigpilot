# 解码与渲染性能归因（2026-09-22）

按计划"先归因、再移植"跑了一次性能自测。**结论推翻了我原先的三条移植建议中的两条，
并否证了第三条。** 本文记录证据与修正后的计划。

## 0. 方法

```sh
export PXLOGIC_SALEAE_SIDECAR="$PWD/target/native/saleae-analyzer-sidecar/pxlogic-saleae-analyzer-sidecar"
export PXLOGIC_SALEAE_RUNTIME_ROOT="$PWD/target/native/saleae-analyzer-sidecar/runtime"
cargo run --release -p pxlogic-graph --bin pxlogic-perf-self-test -- \
  --scenario 2.5m-i2c-spi --warmups 1 --iterations 10 \
  --output /tmp/pxlogic-perf-2.5m-i2c-spi.json
```

场景：2.5M 样本 × 32 通道 × I2C+SPI 两个分析器，产出 **32,915 帧**，
稀疏转移索引 **315,184 条边**。git `54ad441`，release 构建。

## 1. 头条数字（p50 / p95）

| 指标 | p50 | p95 |
| --- | --- | --- |
| `decoder_core_path_ms`（**冷启动全量解码**） | **66.08 ms** | 67.39 ms |
| `complete_decode_ms`（后台解码到完成，含 16 ms 轮询节拍） | 69.29 ms | 72.41 ms |
| `first_decoded_result_ms`（首个结果出现） | **7.76 ms** | 8.59 ms |
| `final_graph_frame_ms`（解码完成后的帧转换） | **0.76 ms** | 1.05 ms |

> `decoder_core_path_ms` 的定义来自 `docs/performance-self-test.md`：
> *"a synchronous full GraphSession native decoder path after cache reset"* ——
> 即**整个采集的一次冷解码**，不是每帧成本。

## 2. 解码时间花在哪：95% 在 sidecar 进程内

p50，按阶段降序（占 66.08 ms 的比例）：

| 阶段 | p50 | 占比 |
| --- | --- | --- |
| `core.graph.saleae_full_batch_decode` | 66.08 | 100% |
| `core.decoder.saleae.batch_decode_total` | 62.98 | 95% |
| **`core.decoder.saleae.persistent_batch_sidecar_execute`** | **62.72** | **95%** |
| `core.decoder.saleae.persistent_response_read` | 54.32 | 82% |
| `core.decoder.saleae.persistent_batch_response_convert` | 5.04 | 7.6% |
| `core.decoder.saleae.persistent_request_write` | 3.35 | 5% |
| `core.graph.saleae_full_batch_frame_conversion` | 2.66 | 4% |
| **`core.decoder.saleae.batch_request_json_encode`** | **0.251** | **0.38%** |
| **`core.decoder.saleae.persistent_batch_response_json_parse`** | **0.021** | **0.03%** |

**JSON 编解码合计 0.273 ms / 66.08 ms = 0.41%。**

- `sidecar_execute` 与 `response_read` 高度重叠（62.72 vs 54.32）：父进程大部分时间在
  **等 sidecar 产出**，不是在搬运。
- 单帧成本：32,915 帧 / 62.72 ms ≈ **1.9 µs/帧**。

## 2.5 单次成本（补测：给报告加了调用次数后）

初版报告只有总耗时，无法区分"跑得多"和"单次贵"。补上 `stage.*.count` 与
`stage.*.mean_ms` 后（见 `docs/performance-self-test.md`），画面变了：

| 阶段 | **mean/call** | count | total |
| --- | --- | --- | --- |
| `core.graph.saleae_full_batch_decode` | 69.61 | **1** | 69.61 |
| `core.decoder.saleae.persistent_batch_sidecar_execute` | **66.24** | **1** | 66.24 |
| `user.graph.saleae_batch_window_decode` | 7.88 | 1 | 7.88 |
| `user.graph.saleae_background_async_step` | 7.69 | 3 | 23.08 |
| **`user.graph.graph_frame_total`** | **4.87** | **2** | 9.75 |
| **`user.graph.analyzer_render`** | **4.47** | **2** | 8.94 |
| `user.decoder.saleae.persistent_response_read` | 1.04 | **17** | 17.66 |
| `user.decoder.saleae.batch_decode_total` | 1.01 | **14** | 14.16 |
| `user.decoder.saleae.persistent_batch_sidecar_execute` | **1.00** | **14** | 13.95 |
| **`user.graph.waveform_tile`** | **0.43** | 2 | 0.87 |
| `user.decoder.saleae.batch_request_json_encode` | 0.008 | 14 | 0.11 |
| `user.decoder.saleae.persistent_batch_response_json_parse` | 0.008 | 14 | 0.12 |

### 这张表修正了三个判断

**① 66 ms 是"冷启动一次"，不是每帧。**
`persistent_batch_sidecar_execute` 的 **count = 1**。而**稳态增量解码**
（`user.decoder.saleae.*`，count = 14）单次只要 **~1.0 ms**。

| 路径 | 单次 | 次数 |
| --- | --- | --- |
| 冷启动全量解码 | **66.24 ms** | 1 |
| 稳态窗口增量解码 | **~1.00 ms** | 14 |

→ 解码**不是**交互卡顿的来源。冷启动 66 ms 影响的是"刚打开时"，
不是拖动时。

**② `analyzer_render` 是 4.47 ms/次 × 2，不是 8 ms/次。**
初版把 7.95 ms 的总量误读成单次成本。真实值 **4.47 ms/次**，
而它占 `graph_frame_total` 的 **92%**（4.47 / 4.87）。

**③ 单帧后端成本 ≈ 4.87 ms。**
组成：`analyzer_render` 4.47 + `waveform_tile` 0.43 + 其余。

**在 60 fps（16.67 ms）预算下占 29%**，本身不构成卡顿；
但它叠加 Tauri IPC + React + Canvas（**均未测量**）后可能超出预算。

### 顺带验证

`total / count == mean` 对全部 33 个阶段逐一核对通过（无一例外），
说明新加的计数与既有总计来自同一组事件、同一套 key。

## 3. 三条原建议的复核结果

### ① "移植 Saleae 的 RLE 数字数据表示" —— **已经等价实现了**

原判断：pxlogic 用定长 packed bin，Saleae 用游程，逻辑信号多为恒定，RLE 应大幅省成本。

实际情况：pxlogic 的 `DigitalChannelIndex` 就是**稀疏转移索引**
（`edges: Vec<u64>`，即"发生跳变的样本号"列表），且 `summarize_indexed_bin`
**完全基于索引**：

```rust
fn summarize_indexed_bin(index: &DigitalChannelIndex, x: u32, start: u64, end: u64) -> WaveformBin {
    let first_edge = index.first_edge_after(start);
    let edge_end = index.edge_count_at_or_before(end.saturating_sub(1));
    ...
}
```

即每 bin 是 O(log E) 而不是 O(样本数)。**这与 RLE 在"稀疏信号近乎零成本"上的性质等价。**

而且 tile 路径本来就不是瓶颈：`user.graph.waveform_tile` = **0.72 ms**。

→ **不需要移植。** 剩下的差异只是**传给前端的线格式**（定长 16 B/bin vs 游程），
而 `PACKED_DIGITAL_BIN_BYTES = 16` × 最多 `pixels` 个 bin 是有界的（约 43 KB/通道），
不在关键路径上。

### ② "换掉 JSON IPC（二进制/共享内存）" —— **否证**

JSON 编解码合计 **0.41%**。换掉它最多省 0.27 ms / 66 ms。

→ **不要动。** 这正是"先测量再优化"要避免的那类改动。

### ③ "移植 Saleae 的 LOD / 聚合策略常量" —— **已经是同一组数值**

`crates/pxlogic-graph/src/lib.rs` 顶部：

```rust
const MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES: f64 = 30.0;
const MAX_COARSE_EDGE_MARKERS: usize = 400;
```

对照 Saleae 的 `analyzersCommon/manager.ts`：

| Saleae | pxlogic |
| --- | --- |
| `maxPixelsBetweenMergeableFrames = 30` | `MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES = 30.0` |
| `maxMultiBubbleStrings = 400` | `MAX_COARSE_EDGE_MARKERS = 400` |

→ **已经一致，不需要移植。**

### 附带确认：sidecar 的通道数据热路径没有 O(n²)

`sdk_compat.cpp`：

```cpp
bool AnalyzerChannelData::DoMoreTransitionsExistInCurrentData() {
    auto* data = reinterpret_cast<AnalyzerTest::MockChannelData*>(this);
    const auto next = std::upper_bound(data->mTransitions.begin(), data->mTransitions.end(), data->mCurrentSample);
    return next != data->mTransitions.end();
}
```

`std::upper_bound` = 二分查找，**已经是 O(log n)**。原先怀疑的"线性扫描导致 O(n²)"不存在。

## 4. 关键缺口：这份自测**不测渲染路径**

报告自己写得很清楚（`docs/performance-self-test.md`）：

> `ui_visible_result.available = false`
> *"Tauri IPC delivery, React scheduling, and Canvas paint are not observable from this
> Rust command and remain a stage 2 measurement decision. It is not replaced with
> complete_decode_ms."*

所以：

| 层 | 是否被本次自测覆盖 | 实测值 |
| --- | --- | --- |
| Rust 解码（sidecar） | ✅ | 冷解码 66 ms，1.9 µs/帧 |
| Rust 波形 tile | ✅ | 0.72 ms |
| Rust 帧转换 | ✅ | 0.76 ms |
| **Tauri IPC 投递** | ❌ | — |
| **React 调度 / 重渲染** | ❌ | — |
| **Canvas / WebGL 绘制** | ❌ | — |

**"卡顿渲染"落在未测量的那三行里。** 把 Saleae 的代码搬进来不会改善它们——
它们和 Saleae 的实现方式无关，是 pxlogic 自己的前端管线。

## 5. 修正后的计划

**结论仍然是"不要移植"**——RLE 与 LOD 常量已等价存在，JSON 占 0.41%。
但补测把**优先级**改了。

### 已完成

1. **给 stage totals 加调用次数** —— `IterationReport.stage_counts` +
   `stage.<name>.count` / `stage.<name>.mean_ms`，key 由同一个 `stage_key()`
   生成以免两张表漂移；契约写进 `docs/performance-self-test.md`。
   **结果直接改变了优先级**（见 §2.5）。

### 下一步（按新优先级）

2. **`analyzer_render` 单次 4.47 ms，是当前最大的单帧后端成本**（占帧 92%）。
   这是**唯一值得深入的后端热点**。下一步应该把它内部再拆开：
   - 帧查询/过滤（从缓存取可见帧）
   - 气泡聚合（合并相邻帧）
   - 序列化（转成给前端的 payload）
   注意：**它 4.47 ms 是否包含解码，需要在拆分时确认**——
   稳态增量解码只有 ~1.0 ms，若 `analyzer_render` 内含解码，则聚合占 ~3.5 ms。

3. **加 stage-2 渲染测量**（文档自己列为 stage 2，本次仍未覆盖）：
   - Tauri IPC 往返耗时与字节数
   - React 提交耗时（可复用本仓库 `tools/bubble-render-verify` 的
     `flushSync` + `MutationObserver` 手法）
   - Canvas / WebGL 绘制耗时与丢帧计数

4. **暂不动**：解码传输层（JSON 0.41%）、波形 tile（0.43 ms/次）、
   冷启动解码（66 ms 一次性，若"打开慢"是投诉点再单独优化）。

### 判断依据

| 项 | 单次成本 | 是否值得动 |
| --- | --- | --- |
| `analyzer_render` | **4.47 ms** | **值得**（最大单帧项） |
| `waveform_tile` | 0.43 ms | 否 |
| 稳态增量解码 | ~1.00 ms | 否 |
| JSON 编解码 | 0.008 ms | 否（0.41%） |
| 冷启动全量解码 | 66 ms（一次） | 仅当"打开慢"被投诉 |

### 已知的前端渲染线索（来自此前工作，供 stage 2 优先验证）

- 栅格缓存曾在缩放时被放大到 **30×**（`rasterCoversViewport` 只查覆盖不查尺度），
  已修；修后放大阶段放大倍数降到 ~1.2–1.4×。
- 气泡元素重建约 **6.9 µs/元素**，几百个元素时 1–3 ms（已用
  `tools/bubble-render-verify` 测过，当时判定不需要元素复用）。
- 平移跨 tile 边界时有 **1 帧** 显示上一块 tile 的栅格（放大 36.6×），**未修**。

这三条都在"渲染"层，与解码无关，与 Saleae 的代码也无关。

---

## 6. 把 `analyzer_render` 拆开（含并行度实验）

### 6.1 先补两个测量缺口

**(a) `analyzer_render` 是双峰的，均值掩盖了它。**
`render_analyzer` 里本来就有 `analyzer_frames` / `bubble_aggregation` 计时，
但**多分析器的 Saleae 路径根本不经过它**——走的是
`render_saleae_native_analyzers_for_capture`，在四个不同位置各自聚合。
所以真实采集走的那条路的聚合成本此前是**不可见的**。

新增 `render_analyzer_tracks_timed()`（stage 名沿用 `bubble_aggregation`，
两条路自然汇总），替换原生路径的四处调用，并用 `source=` 区分
`full-cache-hit` / `no-windows` / `window-cache-hit` / `batch-finalize`。

**(b) 均值看不出双峰。** 新增 `stage.<name>.call`——**把每次调用的原始耗时池化后
取百分位**，而不是先按 iteration 求均值。

### 6.2 结果：聚合不是瓶颈，窗口解码才是

p50，2.5M×32ch I2C+SPI：

| 阶段 | call p50 | call max | 均值 | 判读 |
| --- | --- | --- | --- | --- |
| **`analyzer_render`** | **0.494** | **8.373** | 3.885 | **双峰**：缓存命中 vs 全量解码 |
| `graph_frame_total` | 0.977 | 8.764 | 4.208 | 同上（外层） |
| **`saleae_batch_window_decode`** | **6.917** | 7.845 | 6.917 | **真正的成本** |
| **`bubble_aggregation`**（新插桩） | **0.040** | 0.430 | 0.100 | **可忽略** |
| `waveform_tile` | 0.294 | 0.480 | 0.303 | 可忽略 |

**`analyzer_render` 的两个分支：**
- **缓存命中帧 ≈ 0.49 ms**
- **需要解码的帧 ≈ 8.37 ms**，其中 `saleae_batch_window_decode` 6.92 ms

**结论：气泡聚合（0.04 ms 典型 / 0.43 ms 最坏）不是瓶颈，占比 <1%。**
8.37 ms 的贵帧几乎全部是窗口解码。

### 6.3 并行度实验：小收益 + 一个必须记住的陷阱

三处 worker 上限**默认都是 4**，而本机有 **10 个 CPU**：

| 常量 | 值 |
| --- | --- |
| `MAX_DEFAULT_PARALLEL_NATIVE_WINDOW_DECODES` | 4 |
| `MAX_DEFAULT_SALEAE_PERSISTENT_WORKERS` | 4 |
| `MAX_DEFAULT_SALEAE_SIDECAR_WORKERS` | 4 |

全部通过环境变量可调，无需改代码。实测（window decode p50）：

| 配置 | 冷解码 | **window decode p50** | window decode max | frame p50 |
| --- | --- | --- | --- | --- |
| 默认 | 65.88 | 6.955 | 7.449 | 0.817 |
| `NATIVE_WINDOW_DECODE_WORKERS=8` | 66.12 | **6.323** | 7.212 | 0.844 |
| 上面 + `SALEAE_WORKERS=8` | 65.84 | **6.251** | **6.543** | 0.971 |
| `NATIVE=10 SALEAE=8` | 66.33 | 6.221 | 6.857 | 0.902 |
| **`SALEAE_WINDOW_BATCH_WORKERS=8`** | 66.00 | **7.275** ✗ | 8.456 ✗ | 1.200 ✗ |
| **三个都 = 8** | **71.57** ✗ | 7.008 | **13.985** ✗✗ | **7.076** ✗✗ |

**两条结论：**

1. **把 `PXLOGIC_NATIVE_WINDOW_DECODE_WORKERS` 从 4 提到 8 有约 10% 收益**
   （6.955 → 6.25 ms），且 max 也下降（7.449 → 6.543）。
   再提到 10 没有额外收益——**说明窗口解码不是并行度受限**，
   剩下 ~6.2 ms 是串行部分（窗口规划 / 归一化 / sidecar 内的串行段）。
2. **⚠️ 三个池子的 worker 数是相乘的，一起调大是灾难。**
   三个都设 8 时：冷解码 +9%，window decode max **翻倍到 13.985 ms**，
   **frame p50 从 0.817 恶化到 7.076 ms（8.7×）**。
   这是超订（10 CPU 上 8×8×8）导致缓存失效、每帧都重解码。
   **不要同时调大这三个变量。**

### 6.4 建议

| 动作 | 收益 | 风险 |
| --- | --- | --- |
| `PXLOGIC_NATIVE_WINDOW_DECODE_WORKERS=8` | ~10%（6.96→6.25 ms） | 低，但需真机确认 |
| 调大 `SALEAE_WINDOW_BATCH_WORKERS` | **负收益** | 高 |
| 三个一起调大 | **严重负收益** | 极高 |

**并行度只值 10%，不值得为它改默认值。** 若要继续优化那 ~6.2 ms，
下一步应拆解 `saleae_batch_window_decode` 内部的**串行**部分
（窗口规划 `sparse_native_analysis_windows`、`normalize_native_decoded_frames`、
以及 sidecar 单次批量请求内的串行解码），而不是继续加 worker。

**注意**：本轮仍未触及 Tauri IPC / React / Canvas 三层（§4），
"卡顿"的最终归属仍待 stage-2 测量。

---

## 7. 双峰比例：把"多少帧走了贵路径"变成可读数字

§6 用 `p50` vs `max` 只能说明"存在两个分支"，说不出**各占多少**、
以及**贵分支是否吃掉了时间**。这两件事才是决定要不要优化的依据。

新增两个指标，**仅对"最慢一次调用 > 自身中位数的 2 倍"的阶段输出**：

| 指标 | 含义 |
| --- | --- |
| `stage.<name>.slow_calls` | 超过"自身中位数 ×2"的调用次数 |
| `stage.<name>.slow_time_share` | 这些慢调用占该阶段总耗时的比例 |

**因此 `stage.<name>.slow_calls` 出现本身就是"该阶段是双峰的"这一信号**，
不出现即不双峰。阈值相对自身中位数，不需要为每个阶段调参。

### 7.1 结果

`analyzer_render`（2.5M×32ch I2C+SPI，20 次调用）：

| 指标 | 值 |
| --- | --- |
| `.call` p50 / p95 / max | 0.573 / 8.122 / 8.242 ms |
| `.slow_calls` | **10 / 20** |
| `.slow_time_share` | **0.950** |

**即：一半的调用走贵路径，而它们吃掉 95% 的时间。**

> ⚠️ **这个 50% 是自测夹具的产物，不是真实拖动的比例。**
> 夹具每次 iteration 固定调用两次（一次缓存命中、一次解码），所以必然是 50/50。
> **该指标的价值在于：对着真实拖动跑时会报出真实比例。**
> 这一步仍然需要真机，自测夹具给不出答案。

### 7.2 读这个指标的两个注意点

**(a) 必须和绝对总耗时一起读。** `slow_time_share` 是个**比例**，
所以一个可忽略的阶段也能报出很高的比例。实测：

| 阶段 | slow_time_share | 绝对量级 | 值得动吗 |
| --- | --- | --- | --- |
| `analyzer_render` | 0.950 | p50 0.57 / max 8.24 ms | **是** |
| `persistent_request_write` | **0.991** | p50 **0.002** ms | 否 |
| `async_request_json_encode` | 0.990 | 极小 | 否 |
| `bubble_aggregation` | 0.700 | p50 **0.040** ms | 否 |

**比例排的是"形状"，`stage.<name>` 排的是"重要性"** —— 两个一起看才有意义。

**(b) 少样本时不会输出。** 少于 4 个样本时"中位数"没有意义，该阶段不会输出
这两个键（有测试覆盖），以免伪造出一个看似测过的结论。

### 7.3 当前的完整结论链

1. 冷启动全量解码 66 ms（一次）；稳态增量解码 ~1.0 ms。
2. JSON 传输占 0.41% —— 否证。
3. RLE 索引与 LOD 常量**已等价存在** —— 不需要移植。
4. 气泡聚合 **0.04 ms** —— 可忽略（§6.2）。
5. 真正的成本是**窗口解码 6.9 ms**，且**不是并行度受限**（加 worker 只值 10%，
   超订反而 8.7× 恶化）。
6. **一半的帧走贵路径，吃掉 95% 的时间** —— 但这 50% 是夹具产物（§7.1）。

**下一步唯一有意义的动作：在真实拖动下取这个比例。**
若真实比例接近 1（几乎每帧都解码）→ 问题在**缓存命中率/窗口策略**；
若接近 0（多数帧命中缓存）→ 单帧成本 0.98 ms 已经很健康，
卡顿在 Tauri IPC / React / Canvas 三层（§4），与后端无关。
