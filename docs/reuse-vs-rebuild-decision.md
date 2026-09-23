# 能否直接用 Saleae 的前端 / graph 核心 / analyzer 核心？

针对"既然已有 Saleae 前端代码、graph 与 analyzer 核心库，是否可以直接使用而非重复造轮"。

---

## 0. 结论：三层三个答案

| 层 | 能直接用吗 | 现状 |
| --- | --- | --- |
| **analyzer 解码器**（26 个插件） | ✅ **已经在用** | MIT 插件，**协议状态机就是 Saleae 自己的代码** |
| **analyzer 解码核心**（`libAnalyzer.dylib`） | ⚠️ **闭源，但已用 MIT 源重实现** | 符号级完整（108/108），**但行为保真度不完整** |
| **graph 核心** | ⚠️ **能"用"但不能"嵌"** —— 只能作为**进程**被 hook | bridge 已做到，且拿到**完整原生管线** |
| **前端** | ❌ **不能** | **21.2% 的 import 是悬空的**（1,557 处 / 766 个缺失模块），**构建不起来**；且是闭源版权代码 |

> **⚠️ 更正**：本文初版把前两行合并成"analyzer 核心已经在用"，**这是错的**。
> 26 个 MIT 插件只是**协议状态机**，它们需要 `libAnalyzer.dylib` 提供的
> **帧引擎、边沿导航、位工具**（共 108 个符号）才能解码。
> pxlogic 用 SDK 的 MIT `testlib` 源码重实现了这些符号（**符号覆盖 108/108**），
> 所以没有链接依赖——**但保真度不完整**：
> `serial` 的 auto-baud 失效、`GetTriggerSample()` 恒为 2、
> 两套兼容层对同一 API 返回不同值。
> **详见 [`decode-core-identification.md`](decode-core-identification.md)。**

**三个关键洞察：**

1. **你不需要恢复的前端源码来"用 Saleae 的前端"——直接跑 Logic 2 就行。**
   bridge 正是这么做的（`--useExistingGraph`）。恢复源码的价值是**参考**
   （理解行为、提取常量、移植逻辑），**不是"可用的前端"**。

2. **解码性能不存在"不如"的问题。** 你跑的就是它的插件，
   所以解码这一层的性能**就是 Saleae 的性能**。差异只可能出现在图/渲染层。

3. **扩展 API 不开放"数据如何到达"。** 仓库文档原话：
   > The extension API opens **how data is interpreted, measured, and driven from
   > outside once it has arrived**. It does not open **how data arrives**.
   > There is no device, transport, importer, trigger, or UI extension point at any layer.

   → **任何"纯扩展"路线都拿不到硬件通路**，这就是必须 hook 的原因，也是 bridge 存在的理由。

---

## 1. 逐层证据

### 1.1 前端：不可用（硬事实）

跑仓库自带的校验脚本：

```
$ node scripts/verify-recovery.cjs
Recovery verified: 1951 source files, 3,200 source-map entries,
and runnable macOS arm64 resources are present.
```

**但"文件在"不等于"能构建"。** 逐条解析全部相对 import：

```
scanned 1323 files, 7352 relative imports
dangling: 1557  (21.2% of relative imports)
distinct missing modules: 766
```

缺失的是**核心模块**，不是边角：

| 缺失根 | 悬空引用数 |
| --- | --- |
| `src/app/services` | 491 |
| `src/design-system/images` | 184 |
| `src/app/apis` | 174 |
| `src/app/features` | 158 |
| `src/app/notifications` | 96 |
| `src/shared/types` | 87 |
| `src/uikit` | 40 |

`src/app/services/graphTypes/**` 整个目录缺失（此前已确认）——
**恰恰是图协议的类型定义**。

**除构建问题外还有两个不可绕过的点：**

- **版权**：这是从 Saleae 发布包**反解**出来的私有前端代码。
  与 MIT 的 SDK 不同，**发布它没有授权依据**。
- **不可维护**：没有上游、没有更新、没有支持。
  每次 Logic 升级都要重新反解一遍。

### 1.2 graph 核心：闭源，但可以"跑"

`libgraph_server_shared.dylib` 是**闭源 Mach-O**，无法作为库链接、无法修改。
但 `native-live-injection-prototype.md` 记录了 hook
`LogicDeviceNode::OnDataBuffer` 之后能拿到的**完整原生管线**：

```
Demo acquisition configuration
  -> hooked raw buffer            ← 只改这一处
  -> DisaggregatorNode
  -> DigitalCreatorNode
  -> DigitalStore
  -> native renderer, analyzers, measurements, save/export
```

**也就是说：hook 一处，Saleae 的渲染器、分析器、测量、保存/导出全部归你使用。**
这就是"直接用 graph 核心"的最强形式，而 **bridge 已经实现了它**。

代价是：闭源部分**不能改**。你要接受它的行为、它的性能、它的 bug。

### 1.3 analyzer 核心：已经是你的了

| 组件 | 状态 |
| --- | --- |
| 26 个官方 analyzer 插件 | **MIT 源码**，已编译进 pxlogic |
| SDK 公开头文件 + testlib | **MIT 源码** |
| 闭源 `libAnalyzer` 二进制 | **不需要**（`libsaleae_compat` 只依赖 `libc++`/`libSystem`） |

**所以"重复造轮"在解码这一层根本不存在。** 你用的是同一份代码。

---

## 2. 那"性能不一定更强"这个担心成立吗？

**分两层看，结论不同：**

| 层 | 与 Saleae 相比 | 依据 |
| --- | --- | --- |
| **解码** | **完全相同** | 同一份插件代码。冷解码 66.24 ms 是**插件自身的计算**，换谁调它都是这个数 |
| **图 / 渲染** | **未知** | pxlogic 单帧实测 0.76–4.9 ms；Saleae 的**没测过**，没有基准可比 |

**所以担心只在第二层成立，而且它是"未知"而不是"更差"。**

**更值得注意的是：自研路径带来了可修复性。**
以本会话刚做完的 marker 分析为例——那个卡顿的根因是
**pxlogic 把标记抽稀放在了最下游的 JS，而 Saleae 放在最上游的原生后端**
（IDA 反编译确认 Saleae 把 `/minimumMarkerGap` + `/maximumMarkerResults`
和视口一起塞进渲染请求）。

**这个 bug 只有在你自己拥有图/渲染层时才可能被修。**
走 bridge 路线的话，它根本无法被触及——那是闭源行为。

---

## 3. 所以真正的问题是什么

**不是"能不能直接用"，而是"你想做哪个产品"。**

你手上其实有**两个不同的产品**：

| | **bridge**（直接用 Saleae 全栈） | **pxlogic**（自研） |
| --- | --- | --- |
| 前端 | Saleae 的（成熟，有 HLA 生态） | 自己的 |
| 图核心 | Saleae 闭源（hook 进去） | 自己的 |
| **解码核心** | **Saleae 插件（MIT）** | **Saleae 插件（MIT）** ← 同一份 |
| 硬件 | pxlogic | pxlogic |
| 工作量 | **已完成** | 大 |
| 能改吗 | ❌ 闭源部分不能 | ✅ 全都能 |
| 品牌 / 路线图 | 受制于人 | 自主 |

**决策规则：**

- **目标只是"让 pxlogic 硬件跑在最好的软件上"** → **用 bridge，已经做完了。**
  不要再往 pxlogic 的图/渲染层投入——那是重复劳动，
  而且注定要追一个闭源实现。

- **目标是"做一个自己的逻辑分析仪软件"** → **必须自研前端与图**，
  因为 Saleae 的这两层你**用不了**（前端构建不起来 + 版权；图闭源不可定制）。
  此时"性能不一定更强"是**必须接受的成本，不是可以绕过的理由**——
  你没有替代选项。

**没有第三条"既用 Saleae 的图、又自己定制"的路。** 闭源 + 未公开协议决定了这一点。

---

## 4. 推荐：当前 pxlogic 的路线其实是对的，只是要说清边界

pxlogic 现在的做法，本质是一条**分层取舍**路线：

| 层 | 策略 | 理由 |
| --- | --- | --- |
| 解码 | **直接用 Saleae 的（MIT）** | 没有理由重写 |
| 图 / 渲染 | **自己写，但把闭源实现当"参照实现"对标** | 这是唯一能定制的层 |
| 前端 | **自己写** | Saleae 的用不了 |
| HLA | 兼容其**格式与 API**，运行时自实现 | 格式已经是你的（脚手架就写着 `from saleae.analyzers import ...`） |

**"把闭源实现当参照"已经被证明有效**，本会话就有两个实例：

1. **LOD 常量**：pxlogic 的 `MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES = 30.0` 与
   Saleae 的 `maxPixelsBetweenMergeableFrames = 30` 已经一致（值抄对了）。
2. **marker 抽稀位置**：通过 IDA 反编译发现 Saleae 把预算**随渲染请求下发**，
   而 pxlogic 放在了 JS —— 这是**靠对标发现的可优化点**，
   走 bridge 路线永远发现不了，因为那是闭源行为。

**换句话说：对标不是为了抄代码，而是为了不重复踩坑。**
这条路线的成本是"要自己写"，收益是"能改、能测、能优化"。

---

## 5. 一句话

**"直接用"这三个字，每一层都已经有答案了：解码核心你早就在用，
图核心 bridge 已经在用（hook 进完整原生管线），前端则根本用不了。**

**所以问题不是技术可行性，而是产品定位：**
**要"pxlogic 硬件的 Logic 2"就用 bridge；要"自己的软件"就必须自研那两层。**
**别做第三种选择——半自研半依赖闭源，两边的代价都要付，两边的收益都拿不到。**
