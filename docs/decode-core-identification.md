# 解码核心：`libAnalyzer.dylib` —— 以及 pxlogic 复现实现的保真度

本文更正 `reuse-vs-rebuild-decision.md` 中"analyzer 核心已经是你自己的了"这一说法。
**该说法不完整。**

---

## 1. 你说得对：解码核心是一个独立的闭源库

**解码核心 = `libAnalyzer.dylib`。**

两份副本：

| 位置 | 大小 | 用途 |
| --- | --- | --- |
| `saleae-priv/resources/macos-arm64/libAnalyzer.dylib` | 1,585,504 B | Logic 2 随应用分发 |
| `vendor/saleae-standalone/sdk/AnalyzerSDK/lib_arm64/libAnalyzer.dylib` | 570,736 B | 公开 SDK 构建 |

（另在 `lib_arm64/` 下还有 Windows 的 `Analyzer.dll` 与 Linux 的 `libAnalyzer.so`。）

### 证据：插件导入的正是这 108 个符号

以 SPI 插件为例：

```
$ otool -L libspi_analyzer.so
	@rpath/libsaleae_compat.dylib      ← pxlogic 的兼容层
	/usr/lib/libc++.1.dylib
	/usr/lib/libSystem.B.dylib

$ nm -u libspi_analyzer.so | wc -l
179            ← 其中 108 个是 Saleae SDK 符号，其余是 libc++/libSystem
```

这 108 个符号**就是解码核心**：

| 类 | 提供的服务 |
| --- | --- |
| `AnalyzerResults::*` | **帧 / 包 / 事务引擎**（`AddFrame` `AddFrameV2` `CommitResults` `CommitPacketAndStartNewPacket` `GetFramesContainedInPacket` `AddChannelBubblesWillAppearOn` …） |
| `AnalyzerChannelData::*` | **采样/边沿导航**（`AdvanceToNextEdge` `GetSampleOfNextEdge` `WouldAdvancingCauseTransition` …）——真正"读波形"的那一层 |
| `AnalyzerHelpers::*` | 位/数值工具（`GetNumberString` `GetTimeString` `ConvertToSignedNumber` `GetOnesCount` …） |
| `DataBuilder` / `BitExtractor` | 位级装配与提取原语 |
| `Analyzer::*` | 基类服务（`GetSampleRate` `GetTriggerSample` `ReportProgress` `CheckIfThreadShouldExit` …） |
| `SimpleArchive` / `ClockGenerator` | 序列化 / 仿真 |

**插件只是"协议状态机"，离开这些服务无法工作。** 所以 26 个 MIT 插件 ≠ 解码核心。

### 符号覆盖：pxlogic 是**完整**的

| | 插件导入 | `libsaleae_compat` 提供 | `libAnalyzer` 提供 |
| --- | --- | --- | --- |
| Saleae SDK 符号 | **108** | **108** | **108** |

**两者提供的集合完全相同。** 所以 pxlogic **没有链接依赖**闭源库——
它用 SDK 的 `testlib` 源码 + 自己的兼容层**重实现**了这 108 个符号。

---

## 2. 我上一轮错在哪

我说"analyzer 核心已经是你自己的了"，依据是：① 插件是 MIT；② `libsaleae_compat` 不链接 `libAnalyzer`。

**②是对的，①也不假，但结论错了**，因为漏了一个区分：

| | 是什么 | 授权 | pxlogic 的状态 |
| --- | --- | --- | --- |
| **协议解码器**（26 个插件） | 每种协议的状态机 | **MIT** | ✅ 直接用，无需重写 |
| **解码核心运行时**（`libAnalyzer`） | 帧引擎、边沿导航、位工具 | **闭源** | ⚠️ **用 MIT testlib 重实现，但保真度不完整** |

**"符号齐全"不等于"行为等价"。** 我验证了前者，没验证后者——而后者才是关键。

---

## 3. 复现实现的实际保真度：已确认的桩

pxlogic 的兼容层有两处，**都**把部分 API 留成了桩：

- `native/saleae-analyzer-sidecar/src/sdk_compat.cpp`（64 行）
- `vendor/saleae-standalone/runtime/cpp/compat_extensions.cpp`（293 行 / 23 个函数）

### 3.1 桩清单

| API | pxlogic 的实现 | 受影响的分析器 |
| --- | --- | --- |
| `AnalyzerChannelData::TrackMinimumPulseWidth()` | **空实现**（`sdk_compat.cpp:57`、`compat_extensions.cpp:130`） | `serial`、`modbus` |
| `AnalyzerChannelData::GetMinimumPulseWidthSoFar()` | **`UINT64_MAX`**（`sdk_compat.cpp:61`）/ **`0`**（`compat_extensions.cpp:134`） | `serial`、`modbus` |
| `AnalyzerChannelData::GetNumberOfTransitionsToAbsPositionMinimumWidth()` | **忽略 `minimum_width`**，退化为 `AdvanceToAbsPosition`（`compat_extensions.cpp:139`） | 同上 |
| `Analyzer::GetTriggerSample()` | **硬编码 `return 2`**（`testlib/AnalyzerStubs.cpp:37`），**全仓库无任何地方覆盖或设置** | 大量：`can` `biss` `atmel-swi` `dmx-512` `async-rgb-led` … |
| `Analyzer2::SetupResults()` | **空实现**（`AnalyzerStubs.cpp:32`） | 同上 |

**SDK 头文件自己写明**（`AnalyzerChannelData.h:28`）：

> `//minimum pulse tracking.  The serial analyzer uses this for auto-baud`

→ **`serial-analyzer` 的自动波特率（auto-baud）在 pxlogic 里是失效的。**
`modbus` 同样依赖这两个 API。

→ **`GetTriggerSample()` 恒为 2**，意味着凡是用它来定位输出的分析器，
结果位置都不对（不是崩溃，是静默错误——更难发现）。

### 3.2 附带发现：两套兼容层互相不一致

同一个 API 在两处返回**不同的值**：

```
GetMinimumPulseWidthSoFar()
  sdk_compat.cpp            → std::numeric_limits<U64>::max()
  compat_extensions.cpp     → 0
```

两者都不正确（正确值应是"目前为止观测到的最短脉冲宽度"），
但**取值不同**说明这两层不是协同设计的。
（链接时谁生效取决于符号解析顺序，这本身也是隐患。）

---

## 4. 这让"复用 vs 自研"的结论更精确

原来的三分法要改成**四分法**：

| 层 | 授权 | 状态 | 你有选择吗 |
| --- | --- | --- | --- |
| **协议解码器**（26 插件） | MIT | ✅ 直接用 | 没有理由重写 |
| **解码核心运行时** | **闭源** | ⚠️ **已用 MIT 源重实现，保真度不完整** | **有** ← 新增的第三类 |
| **graph 核心** | 闭源 | 只能作为进程 hook | 只能 hook |
| **前端** | 私有（反解） | ❌ 21.2% 悬空 import，不可构建 | 必须自研 |

**解码核心是唯一"闭源但可以用 MIT 源重实现"的层**，因此它是一个**真实的工程选择**，
而不是"已经解决了"：

| 方案 | 收益 | 代价 |
| --- | --- | --- |
| **(a) 继续重实现** | 授权干净（纯 MIT）；可控可改 | **必须自己补齐并维护保真度**，且 SDK 升级要跟 |
| **(b) 链接 `libAnalyzer.dylib`** | 保真度 100%，零维护 | 闭源依赖；与"不依赖闭源"的既有原则冲突；分发授权未明 |
| **(c) 先枚举缺口，只补真正影响到的** | 最小工作量 | 需要先做一次系统性的缺口盘点 |

---

## 5. 建议：先做缺口盘点（方案 c）

**缺口是可枚举的**——本文已经列出一部分。建议按以下顺序推进：

1. **系统盘点**：把 `libAnalyzer` 导出的 1232 个符号与 pxlogic 兼容层的实现逐一对照，
   标出三类：**真实现 / 桩 / 缺失**。只看插件**实际导入**的 108 个，范围很小。
2. **按影响排序**：对每个桩，检查有多少插件调用它（本文 §3.1 已给出方法）。
   优先修**被多个插件调用**的（如 `GetTriggerSample`）。
3. **补实现 + 加测试**：例如
   - `GetTriggerSample` → 从 sidecar 请求里带真实触发样本传入
   - `TrackMinimumPulseWidth` / `GetMinimumPulseWidthSoFar` → 基于已有的稀疏边沿索引实现
     （`DigitalChannelIndex.edges` 已经能算最短脉冲宽度）
   - `GetNumberOfTransitionsToAbsPositionMinimumWidth` → 不要忽略 `minimum_width`
4. **消除两套兼容层的重复定义**：`sdk_compat.cpp` 与 `compat_extensions.cpp`
   定义了同一批符号，应合并为一处，避免取值不一致与链接顺序依赖。
5. **加保真度回归**：用 SDK 的 `testlib` 里已有的 analyzer 单元测试作基线
   （`TestHarnessVerification.cpp` / `TrivialAnalyzer.cpp` 就是为此存在的）。

---

## 6. 一句话

**你说得对：解码核心是 `libAnalyzer.dylib`，一个独立闭源库。**
pxlogic 用 MIT 的 testlib 源码把它**符号级完整地重实现**了（108/108），
所以没有链接依赖——**但行为保真度是不完整的**：
`serial` 的 auto-baud 失效、`GetTriggerSample` 恒为 2、
以及两套兼容层对同一 API 返回不同值。

**这属于"闭源但可重实现"的第三类，是一个真实的工程选择，不是已解决的问题。**
