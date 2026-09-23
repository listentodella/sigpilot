# 标记（marker）导致渲染卡顿：根因分析与优化方案

针对"Saleae 为 SWD / CAN / SPI / I2C clock 等波形提供的特殊标记，
在 pxlogic 渲染时经常导致卡顿"这一现象。

---

## 0. 结论

**根因是分层错位：pxlogic 把标记抽稀（decimation）放在了最下游的 JS，
而 Saleae 放在最上游的原生后端。**

后果是**每一个标记都要走完整条链路**（插件 → C++ → 序列化 → 管道 → Rust 反序列化
→ 排序 → Tauri IPC → JS 索引 → 再排序 → 抽稀到 ≤300），
而 SPI/I2C/SWD/CAN 这几个协议的插件**每个 bit / 每个时钟边沿就产出一个标记**
（已从插件源码确认），于是标记数量随"时钟密度 × 采集时长"线性膨胀。

**Saleae 的做法（已用 IDA 反编译确认）**：把抽稀预算**和视口一起塞进渲染请求**发给后端，
后端在**产出响应之前**就抽稀完，前端从不接触全量标记。

**优化方向明确且高收益**：把抽稀下沉到 sidecar（甚至 C API），
让管道、Rust、JS 都不再接触被丢弃的那 99%+。

> ⚠️ **但必须说明**：本次**未能用现有夹具复现卡顿的量级**——
> 合成夹具每个窗口只产出 **776 个标记**（实测），远不足以触发。
> 因此下面的数量级推断是**结构性的**，需要先补一个"密集时钟夹具"来实测确认。
> 见 §4。

---

## 1. 根因证据链

### 1.1 为什么偏偏是这几个协议：插件每个 bit 就产一个标记

`saleae-standalone/analyzers/spi-analyzer/src/SpiAnalyzer.cpp:326`：

```cpp
// save the results:
U32 count = mArrowLocations.size();
for( U32 i = 0; i < count; i++ )
    mResults->AddMarker( mArrowLocations[ i ], mArrowMarker, mSettings->mClockChannel );
```

`mArrowLocations` 每个 bit 追加一项，最后**整批**作为标记发出，落在**时钟通道**上。
I2C（每个 SCL 边沿）、SWD、CAN（每个 bit）同理。

**所以标记数 ≈ 时钟 bit 数**。一个 1 MHz SPI 时钟采 1 秒 = 1M bit ≈ **1M 个标记**。

### 1.2 pxlogic 链路上没有任何一处设限

**(a) sidecar 全量序列化** —— `native/saleae-analyzer-sidecar/src/standalone_main.cpp:1052`：

```cpp
const auto marker_count = sr_session_marker_count(session);
markers.get_ref<json::array_t&>().reserve(marker_count);
for(size_t index = 0; index < marker_count; ++index)   // ← 全量，无上限
{
    sr_marker_view marker{};
    if(sr_session_marker(session, index, &marker) != 0) continue;
    ...
    markers.push_back(...);
}
```

**(b) Rust 全部收下、可能还要排序** ——
`crates/pxlogic-core/src/decoder_backend.rs`：
`into_decoder_output` 解析全部标记，`attach_protocol_markers` / `normalize_protocol_markers`
做线性扫描与**排序**，然后：

```rust
if let Some(first) = frames.first_mut() {
    first.markers = markers;      // ← 全部挂在第一帧上
}
```

**(c) 前端重建索引并再排序一次** —— `src/lib/analyzerTrackWindows.ts:397`：

```ts
function analyzerTrackMarkerIndex(frames: DecodedFrame[]) {
  ...
  frames.forEach((frame) => {
    frame.protocol_markers?.forEach((marker) => { ... protocolByChannel ... });
  });
  protocolByChannel.forEach((markers, channel) => {
    protocolByChannel.set(channel, sortAndDeduplicateMarkers(markers));   // ← O(M log M)
  });
}
```

结果缓存在 `LOCAL_ANALYZER_TRACK_MARKER_INDEX_CACHE`（以 **frames 数组身份**为键的 WeakMap）。

**(d) 最后才抽稀到 ≤300** —— `src/lib/analyzerMarkers.ts`：

```ts
export const ANALYZER_MARKER_MINIMUM_GAP_PX = 13;
export const ANALYZER_MARKER_MAXIMUM_RESULTS = 300;
```

**即：为了显示 ≤300 个标记，全量 M 个标记要走完整条链路，并被排序两次。**

### 1.3 对照 Saleae：预算随渲染请求下发（IDA 反编译）

对 `libgraph_server_shared.dylib` 反编译 `sub_10420B4`（渲染请求反序列化），
得到**同一个请求结构体**里同时包含视口与 LOD 预算：

```
sub_10421AC(a1 + 32, "/widthPx",                         a2);
sub_14B1E4 (a1 + 40, "/leftEdgeTime",                    a2);
sub_10424FC(a1 + 56, "/secondsPerPx",                    a2);
sub_104289C(a1 + 64, "/maximumMarkerResults",            a2);   // ← 标记数上限
sub_F6EA0  (a1 + 68, "/minimumMarkerGap",                a2);   // ← 标记最小间距
sub_1042BEC(a1 + 72, "/maxMultiBubbleStrings",           a2);
sub_1042F3C(a1 + 76, "/maxPixelsBetweenMergeableFrames", a2);
```

另有状态串 `MaximumMarkerResultsExceeded`（`InitFunc_324`）与
`Saleae::Graph::AnalyzerNode::MarkerAddedOnChannel(const Channel&)`。

**关键点**：`/minimumMarkerGap` 要配合视口（`widthPx` + `secondsPerPx`）才能换算成
"最小间距样本数"。Saleae 把两者**一起**下发，所以后端能独立完成抽稀。
**前端从不接触全量标记。**

### 1.4 pxlogic 的 sidecar 请求**结构上做不到**抽稀

`standalone_main.cpp:1391` 的请求字段只有：

```
"start_sample"
"end_sample"
```

**没有 `widthPx`、没有 `secondsPerPx`、没有 `minimumMarkerGap`、没有 `maximumMarkerResults`。**
即使 sidecar 想抽稀，它也算不出最小间距样本数。

---

## 2. 成本模型

设某窗口内某通道的标记数为 `M`，则每条链路的代价：

| 阶段 | 代价 | 备注 |
| --- | --- | --- |
| 插件产出 | O(bit 数) | 不可避免（插件本体是 MIT 官方代码） |
| sidecar 序列化 | **O(M)** | 全量，无上限 |
| 管道传输 | **O(M × ~16–40 B)** | 1M 标记 ≈ 16–40 MB |
| Rust 反序列化 | **O(M)** | **实测 ~39 ns/标记**（776 个 = 0.03 ms） |
| Rust 排序 | **O(M log M)** | 仅在乱序时触发 |
| Tauri IPC | **O(M × 字节)** | |
| JS 建索引 + 排序 | **O(M log M)**，缓存未命中时**每帧一次** | WeakMap 以 frames 数组身份为键 |
| JS 抽稀 | O(log M + 可见数) | 二分 + 扫描，**这部分是好的** |

**前端那一段（抽稀）写得没问题**——二分查找 + 提前 `break` + 上限 300。
问题在于**它前面已经付掉了全部 M 的代价**。

---

## 3. 优化方案（按收益排序）

### O1. 把抽稀下沉到 sidecar —— **最高收益，建议优先**

在 sidecar 请求里补上 Saleae 已有的那三个字段，镜像其原生协议：

```
minimum_marker_gap   ← 由前端视口换算，或直接传 width_px + seconds_per_px
maximum_marker_results
width_px / seconds_per_px
```

sidecar 在**序列化之前**用与前端相同的规则抽稀（优先级标记放行 + 最小间距 + 上限）。
预期把每条链路的 M 降到 **≤300**。

**为什么这是对的**：Saleae 就是这么做的（§1.3），而且 sidecar 本来就持有全部标记，
抽稀不增加任何数据搬运，只是**少序列化**。

### O2. 在 C API 上加"范围 + 间距"查询 —— 彻底不做无用功

现在的 C ABI 只有按索引遍历（`sr_session_marker_count` + `sr_session_marker(i)`），
**没有范围查询**。Saleae 原生侧有对应能力（`AnalyzerResults::GetMarkersInRange`）。

建议新增：

```c
int sr_session_markers_in_range(
    sr_session* session,
    uint32_t channel_index,
    uint64_t start_sample,
    uint64_t end_sample,
    uint64_t min_gap_samples,
    size_t max_results,
    /* out */ size_t* out_count);
int sr_session_marker_in_range_at(sr_session*, size_t index, sr_marker_view* out);
```

配合 O1，sidecar 连遍历都不必全做。

### O3. 修正前端缓存的命中条件 —— 待确认，可能才是"每帧"的来源

`analyzerTrackMarkerIndex` 的缓存以 **frames 数组身份**为键。
若每个 IPC 响应都产生新数组，而渲染频率高于响应频率，缓存能命中；
**但若每次渲染拿到的是新数组，就会每帧重建 O(M) + O(M log M)。**

这一条**必须先确认**（见 §4 的验证项 V3），因为它决定卡顿是"偶发一次"还是"每帧"。

### O4. 修正"跨步边沿"导致的抽稀前提被破坏 —— 正确性问题

`crates/pxlogic-graph/src/lib.rs:4831`：

```rust
let stride = count.div_ceil(MAX_COARSE_EDGE_MARKERS).max(1);   // MAX_COARSE_EDGE_MARKERS = 400
```

tile 的 `rising_edges` / `falling_edges` 会被**跨步抽样到 ≤400 条**。
于是前端 `visibleAnalyzerMarkerSamples` 里的

```ts
const previousGap = index > 0 ? sample - edgeSamples[index - 1] : ...;
```

比较的是**抽样后的邻居**，不是真实邻居。当 `stride > 1` 时，
"最小间距"判断的前提已经不成立——既可能误放行，也可能误丢弃。

**这与卡顿无关（≤400 条扫描很便宜），但会让标记显示不正确。**
建议：要么把真实邻居间距随边沿一起传出，要么在 stride > 1 时改用后端抽稀结果。

> 顺带说明：**tile 边沿被限制在 ≤400，所以"边沿路径"不是卡顿来源。**
> 我最初怀疑 `visibleAnalyzerMarkerSamples` 扫描百万边沿，**这一条已被排除**。

### O5. 补齐标记数量的可观测性 —— 已做一半

已在 `decoder_backend.rs` 的 `into_decoder_output` 加了计时事件：

```
stage=marker_deserialize markers=<M> frames=<F>
```

建议再补：**每通道**标记数、以及**抽稀后**的数量，
这样"抽稀比"直接可读（例如 `markers=1000000 after_decimation=154`）。

---

## 4. 验证计划（必须先做，否则数量级是推断）

本次**未能复现卡顿**：合成夹具（2.5M 样本 × 32ch × I2C+SPI）每窗口只产出
**776 个标记**，反序列化 0.03 ms——完全不足以触发问题。
原因是该夹具的 I2C/SPI 流量是稀疏合成的，**没有密集时钟**。

| # | 验证项 | 方法 | 为什么重要 |
| --- | --- | --- | --- |
| **V1** | 密集时钟下的真实标记数 | 造一个 1 MHz SPI 时钟、8 bit/字节、持续 0.1–1 s 的夹具，跑自测读 `markers=` | **决定问题是否存在及其量级** |
| **V2** | 抽稀前后对比 | 实现 O1 后对比 `markers` 与管道字节数 | 验证收益 |
| **V3** | 前端索引缓存命中率 | 在 `analyzerTrackMarkerIndex` 缓存未命中分支加计数，拖动时观察 | 决定是"偶发"还是"每帧" |
| **V4** | Rust 排序是否被触发 | 观察 `normalize_protocol_markers` 是否走排序分支 | O(M log M) 是否真实发生 |
| **V5** | 真机拖动 | `pnpm tauri dev`，用密集时钟采集拖动 | 端到端确认 |

**V1 是门槛项**：如果密集夹具下 M 也只有几千，那问题不在标记，需要重新定位。

---

## 5. 顺带确认：本机 HLA 的时间类型用法（回答了上一轮的开放问题）

`~/work/qst-sensor-decoders`（真实 HLA，4 个传感器解码器）对
`start_time` / `end_time` 的用法：

```python
# qst_common.py:140-141
start_time: Any
end_time: Any
# :182-183, :198, :212 —— 只赋值
self.start_time = start_time
self.end_time = end_time
# :259 —— 只传递
return Emission(transaction, self.start_time, self.end_time)
```

**类型标注为 `Any`，只做存储与透传，没有任何算术、比较或格式化。**

→ **`SaleaeTime` 可以用任意不透明对象鸭子类型替代**，
上一轮遗留的"最大剩余风险"在真实 HLA 上得到验证。
（该 HLA 也不产出标记，所以与本次卡顿无关。）

---

## 6. 一句话总结

**别在下游抽稀。** 把 `/minimumMarkerGap` + `/maximumMarkerResults`
（连同视口）像 Saleae 一样下发到 sidecar，在标记跨出进程之前就丢掉那 99%+；
前端现有的抽稀逻辑写得是对的，只是它前面白付了全部成本。
**但在动手前，先造一个密集时钟夹具把量级测出来。**
