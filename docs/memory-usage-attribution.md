# 内存差异归因：pxlogic vs Saleae

> **本文经历两轮更正，本文件为终版。**
> 初版错误地断言"Saleae 默认落盘"（已作废）；二版把差异归因于"环形缓冲丢历史"（对用户的实测不成立）。
> 用户提供实测数据后，找到了**真正匹配数字的原因：按字节对齐的位填充浪费**。
> 更正过程见 §5。

---

## 0. 用户实测（本次分析的基准）

同样 **5 s、SPI + INT 共 5 个通道**，多次尝试：

| | 占用 |
| --- | --- |
| Saleae | **~80 MB** |
| pxlogic | **~120 MB** |

比值 **1.5×**。这个量级与"内存上限 / 环形缓冲"无关 ——
5 s × 5 通道远没到任何上限，**两个工具都不会触发丢弃或停止**。

---

## 1. 真正的原因：5 bit 被填充成 1 字节

### 1.1 两侧的存储粒度

**Saleae**：不按整字节对齐。5 个通道实测对应约 **0.625 B/样本 = 5 bit/样本**，
即它把启用通道按位打包。

> **说明**：Saleae 的具体打包方式我是**从比值反推的**，没有直接验证其存储格式。
> **能确定的是**：它没有把 5 个通道向上取整到整字节 —— 这是从你的 80/120 比值直接得出的。

**pxlogic**：`unitsize` 只取整字节（`crates/pxlogic-core/src/capture.rs:293`）：

| 通道数 | unitsize |
| --- | --- |
| 1–8 | **1 B/样本** |
| 9–16 | 2 B/样本 |
| 17–32 | 4 B/样本 |

**而且用的是设备总通道数，不是启用数**（`rusb_backend.rs:526`）：

```rust
let unitsize = unitsize_for_channel_count(channel_count)?;   // ← 总通道数
```

**所以 5 个通道仍按 1 字节/样本存，只有 5 bit 有效 → 37.5% 是填充浪费。**

### 1.2 比值对上了

| | 每样本字节 | 相对 |
| --- | --- | --- |
| Saleae（5 bit 打包） | 0.625 | 1.0 |
| pxlogic（1 字节） | 1.000 | **1.60** |

**实测比值 120 / 80 = 1.50；位填充理论比值 1.000 / 0.625 = 1.60。** ✓

**这个比值与绝对数值、采样率、设备型号都无关** —— 只取决于"5 个通道 vs 整字节对齐"。
用户多次实测都在同一量级，正好说明原因就是它。

### 1.3 反推绝对量（自洽）

若设备总通道数 ≤ 8（unitsize = 1）：

- pxlogic 120 MB ⇒ **约 1.2 亿样本** ⇒ 5 s 约 **24 MHz**
- Saleae 80 MB ⇒ 0.667 B/样本 ≈ **5.3 bit/样本** ⇒ 正是 5 个通道

两者自洽。

---

## 2. 这也解释了"提示 1~2 GB"

pxlogic 默认 `CaptureMode::Buffer`（`capture.rs:371`）：

```rust
CaptureMode::Buffer => sample_count_from_duration(sample_rate_hz, duration_ms, ...)
```

**它在采集前就把整段采集的大小算出来** —— `样本数 = 时长 × 采样率`，再乘 `unitsize` 分配。
所以它能**预告**"这次要 1~2 GB"：

| 场景 | 样本数 | unitsize | 预估 |
| --- | --- | --- | --- |
| 5 s × 5 ch @ 24 MHz | 120 M | 1 B | **120 MB** ← 用户的实测值 |
| 10 s × 32 ch @ 25 MHz | 250 M | 4 B | **1 GB** |
| 20 s × 32 ch @ 25 MHz | 500 M | 4 B | **2 GB** |

**"1~2 GB"不是实际占用，而是长采集的预分配估算。** 两者同一个公式，只是输入不同。

> **注意：32 通道时没有填充浪费** —— 32 bit 正好 = 4 字节。
> 所以 32 通道那 1~2 GB 是**数据的真实大小**，不是浪费；那一档要降只能靠压缩或稀疏表示。

---

## 3. 关于 Looping 模式（与本次实测无关，仅列证据）

官方文档（[Capture Modes](https://www.saleae.com/support/logic-software/capturing-data/capture-modes)）原文：

> **Looping Mode** — "continuous recording into a **RAM buffer**, the size of which can be set by the user.
> Once the RAM buffer is filled, **old data is deleted while new data arrives**, and the capture can
> continue indefinitely in a continuous loop. When the capture ends, the data can be trimmed down to a
> certain length via the *Trim data after stopping* setting, keeping the most recent data."

代码侧：`src/app/utils/defaults.ts:50` 有 **`MEMORY_BUFFER_TRIM_PRCT = 0.1`**（缓冲满时裁 10%）。

**但请以你的实机观察为准** —— 我只有文档和常量，没有跑过实机。
也可能你用的是 **Timer 模式**（固定时长，到点即停），那与 Looping 是两种不同模式。

**关键：这个问题不影响 §0 的结论。**
5 s × 5 通道的采集量远低于任何内存上限，**两个工具都不可能在这里触发丢弃或停止**，
所以 80 vs 120 只能来自**表示方式**，也就是 §1 的位填充。

---

## 4. 结论与建议

### 4.1 结论

**pxlogic 多出的约 50%，是"按整字节对齐"的填充浪费，不是缓冲策略问题。**

### 4.2 建议（按收益）

| # | 做法 | 预期 |
| --- | --- | --- |
| **1** | **`unitsize` 按"实际启用通道数"取整，而非总通道数**（现在 5 通道仍按 1 B；总通道 16 时更糟，按 2 B） | 直接省掉填充浪费；**16 通道设备只开 5 通道时省约 69%** |
| **2** | **真正的位打包**（不再向上取整到 1/2/4 字节） | 达到 Saleae 的 0.625 B/样本，**5 通道场景约省 37.5%** |
| **3** | 让稀疏表示成为主表示（pxlogic 已有 `SparseCaptureData`） | 对**大部分空闲**的总线是数量级下降；但对密集时钟反而更差，应按活跃度自适应 |
| **4** | 合并 `transitions` 与 `edges`（稀疏路径下两者都是 `Vec<u64>`） | 省一份 `edges × 8 B` |
| **5** | 给 analyzer 缓存加 LRU 预算（`analyzer_bytes` 目前无上限） | 防第二个失控项 |

**第 1 条最值得先做**：改动小、收益明确，且是纯粹的浪费修正 ——
**不改变任何行为，只是不再为没用到的位分配内存。**

> ⚠️ 第 1 条要注意：`unitsize` 同时决定**磁盘格式与位序约定**
> （`capture.rs:633/695` 也用它），改动会影响已保存采集的兼容性。
> **需要先确认格式版本策略。**

---

## 5. 更正记录（两轮）

| 轮次 | 我的说法 | 为何错 |
| --- | --- | --- |
| 初版 | "Saleae 用 `SerializeOnThread` + `SetDiscardData` 落盘并丢弃内存副本" | 只看**符号存在**就推断"采集时启用"。实际 `startSerialization` 唯一调用点条件是 `operation === 'save'`（`DataCollectionManager.ts:166`），`SetDiscardData` 用于裁剪时丢弃区间外数据（`AnalyzersStore.ts:280`） |
| 二版 | "Saleae 用环形缓冲丢历史换内存有界" | 方向不算错，但**解释不了用户的实测**：5 s × 5 通道远低于上限，不涉及丢弃。真正原因是**位填充** |
| **终版** | **按整字节对齐的填充浪费（实测 1.5× 对理论 1.6×）** | — |

**教训（两次同一个毛病）：先看到一个机制，就急着把它当成原因。**
初版把"能做什么"当成"默认在做什么"；二版把"某种模式的行为"当成"本次场景的原因"。
**应该先拿实际数字去反推，而不是先选定机制再解释。**
用户给出的 80 / 120 这个比值，才是唯一能证伪的锚点 —— 而它直接指向了位填充。
