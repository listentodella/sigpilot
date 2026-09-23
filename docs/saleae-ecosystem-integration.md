# 复用 Saleae 解码/HLA 生态的可行性评估

面向"自研逻辑分析仪软件"的集成评估。所有结论标注了证据来源；
**未验证的部分单独列出**，不做推断性断言。

---

## 0. 结论先行

**可行，而且你已经走了 80%。**

三条核心结论：

1. **低级解码器（LLA）不需要"复用"——你已经用上了 Saleae 的官方插件本体。**
   pxlogic 的 `vendor/saleae-standalone` 编译了 **26 个官方 analyzer 插件**，
   并且**不依赖任何闭源二进制**（已用 `otool -L` 验证：`libsaleae_compat.dylib`
   只链接 `libc++` 与 `libSystem`）。授权链是干净的 **MIT**。

2. **HLA 是真正的缺口，而且缺口很小、很明确。**
   pxlogic 已经会**解析 HLA 清单、有扩展 UI、还会生成 HLA 模板**，
   模板里写的就是 `from saleae.analyzers import HighLevelAnalyzer, AnalyzerFrame`
   —— 也就是说**你的扩展格式已经就是 Saleae 的 HLA 格式**。
   唯一缺的是**执行**：没有任何 Rust crate 嵌入脚本引擎（已 grep 确认）。
   而 HLA 的 API 面**只有约 200 行纯 Python**。

   而且 **HLA 的性能风险已实测排除**：框架开销约 **39 ns/帧**
   （33k 帧 = 1.3 ms，仅占 LLA 解码 66 ms 的 **2%**），
   格式化密集的 HLA 也只有 11.8 ms（18%）。见 §6。

3. **不要走"直接链接官方闭源 SDK"这条路。** 见 §3。

**推荐方案：B2 —— 用 MIT 源码自建 SDK 运行时（LLA，已完成）+ 自实现约 200 行
HLA 兼容层 + 嵌入 CPython（HLA，待做）。** 见 §5。

---

## 1. 接口规范与数据模型

### 1.1 LLA（低级解码器）：C++ SDK，三个入口

插件是动态库，**只导出三个 C 函数**：

```
_CreateAnalyzer
_DestroyAnalyzer
_GetAnalyzerName
```

其余全部通过 C++ 基类继承。核心基类 `Analyzer`（`sdk/AnalyzerSDK/include/Analyzer.h`）：

| 插件必须实现（纯虚） | 宿主提供（插件调用） |
| --- | --- |
| `void WorkerThread()` —— **自己的解码线程** | `GetAnalyzerChannelData(Channel&)` |
| `U32 GenerateSimulationData(...)` | `GetSampleRate()` / `GetTriggerSample()` |
| `U32 GetMinimumSampleRateHz()` | `ReportProgress(sample_number)` |
| `const char* GetAnalyzerName() const` | `UseFrameV2()` |
| `bool NeedsRerun()` | `CheckIfThreadShouldExit()` |

宿主生命周期：`Init(DeviceCollection*, ConditionManager*, ProgressManager*)` →
`StartProcessing()` / **`StartProcessing(U64 starting_sample)`** → `StopWorkerThread()`。

> **对集成最重要的两点**
> 1. `WorkerThread()` 是**插件自己的线程** —— 宿主天然获得线程隔离与并发。
> 2. **`StartProcessing(starting_sample)` 是显式的增量入口** ——
>    正好对应你 `decode_from(settings, start_sample)` 的语义，
>    渐进解码不需要自己发明机制。

### 1.2 数据模型：Frame v1 与 FrameV2

**v1（`AnalyzerResults.h`）** —— 只有 6 个字段：

```cpp
class Frame {
  S64 mStartingSampleInclusive;
  S64 mEndingSampleInclusive;
  U64 mData1;   // 两个通用 64 位载荷字
  U64 mData2;
  U8  mType;    // 协议自定义类型
  U8  mFlags;   // DISPLAY_AS_ERROR_FLAG(1<<7) / DISPLAY_AS_WARNING_FLAG(1<<6)
};
```

**v2** —— 键值包，`#ifdef LOGIC2` 开启：

```cpp
class FrameV2 {
  void AddString(key, value);   void AddDouble(key, value);
  void AddInteger(key, value);  void AddBoolean(key, value);
  void AddByte(key, value);     void AddByteArray(key, data, len);
};
```

**三级层次**：Frame → Packet → Transaction，由插件自己用
`CommitPacketAndStartNewPacket()` / `AddPacketToTransaction(transaction_id, packet_id)` 声明。

**一个被低估的集成缝**：帧的**显示文本由插件自己产生**——
`GenerateBubbleText(frame_index, channel, display_base)`。
宿主不需要理解任何协议语义，直接调用即可拿到显示字符串。
这是最省事的集成点（pxlogic 的 C API 已暴露：`sr_session_generate_bubble_text`）。

### 1.3 输入侧：`AnalyzerChannelData`

**注意：这些方法不是虚函数**，`mData` 是不透明类型：

```cpp
class AnalyzerChannelData {
  U64 GetSampleNumber();  BitState GetBitState();
  U32 Advance(U32 num_samples);                 // 返回期间跳变次数
  U32 AdvanceToAbsPosition(U64 sample_number);
  void AdvanceToNextEdge();
  U64 GetSampleOfNextEdge();
  bool WouldAdvancingCauseTransition(U32);
  void TrackMinimumPulseWidth();  U64 GetMinimumPulseWidthSoFar();
  bool DoMoreTransitionsExistInCurrentData();
protected:
  AnalyzerChannelDataData* mData;   // 不透明
};
```

**这决定了集成方式**：因为非虚且 `mData` 不透明，宿主**无法通过继承提供数据**，
只能**自己实现这些符号**。pxlogic 正是这么做的——
`sdk_compat.cpp` 直接定义 `AnalyzerChannelData::DoMoreTransitionsExistInCurrentData()`
并把自己的 `MockChannelData*` reinterpret 到 `this` 上。

### 1.4 设置模型

`AnalyzerSettings` + 6 种 `AnalyzerSettingInterface*`
（`Bool` / `Channel` / `Integer` / `NumberList` / `Text` / 基类），
由插件在 `SetSettingsFromInterfaces()` / `UpdateInterfacesFromSettings()` 里同步。

### 1.5 HLA：Python，API 面约 200 行

**公开导出**（`saleae/analyzers/__init__.py`，共 2 行）：

```python
from .high_level_analyzer import HighLevelAnalyzer, AnalyzerFrame
from .settings import StringSetting, NumberSetting, ChoicesSetting
```

**`AnalyzerFrame`（5 行）**：

```python
class AnalyzerFrame:
    def __init__(self, type: str, start_time: SaleaeTime, end_time: SaleaeTime, data: dict = None)
    # .type  .start_time  .end_time  .data
```

**`HighLevelAnalyzer`（82 行）** —— 用元类做设置注入：

```python
class HighLevelAnalyzer(metaclass=MetaHighLevelAnalyzer):
    # 设置是"类成员"，靠 inspect.getmembers 反射收集，再设为实例属性
    @classmethod
    def _get_settings(cls): ...            # 反射收集 Setting 实例
    @classmethod
    def _get_settings_serialized(cls): ... # 扁平化成 host 可消费的 dict
    def __new__(cls, settings, ...): ...   # 校验 + setattr
```

插件作者只需要写：

```python
class Hla(HighLevelAnalyzer):
    result_types = {"spi": {"format": "{{data.mosi}}"}}     # Handlebars 模板
    def __init__(self, settings): ...
    def decode(self, frame: AnalyzerFrame):                 # 逐帧流式
        return AnalyzerFrame("spi", frame.start_time, frame.end_time, {"mosi": ...})
```

**设置类型只有 3 种**（`settings.py`，101 行），各自 `_serialize()` 成小 dict：

| 类型 | 序列化结果 |
| --- | --- |
| `StringSetting(label=)` | `{type:'string', label}` |
| `NumberSetting(min_value=, max_value=, label=)` | `{type:'number', label, min_value?, max_value?}` |
| `ChoicesSetting(choices=[...], label=)` | `{type:'choices', label, choices}` |

**显示机制**（`highLevelAnalyzers/analyzerManager.ts:493`）：
宿主把 `result_types[type].format` 当 **Handlebars 模板**编译，渲染到
`{type, start_time, end_time, data}` 上。**显示逻辑在宿主，不在插件**。

### 1.6 插件清单：`extension.json`（已验证完整 schema）

```json
{
  "apiVersion": "string",   "author": "string",
  "name": "string",         "version": "string",
  "description": "string",
  "extensions": {
    "<显示名>": { "type": "HighLevelAnalyzer", "entryPoint": "my_hla.py" },
    "<显示名>": { "type": "AnalogMeasurement" | "DigitalMeasurement",
                  "entryPoint": "m.py",
                  "metrics": { "k": { "name", "notation", "units" } } }
  }
}
```
required = `apiVersion` / `author` / `extensions` / `name` / `version`。

**扩展只有两种**：`HighLevelAnalyzer` 与测量（Analog/DigitalMeasurement）。
清单极简 —— 这就是整个插件协议。

---

## 2. 授权与依赖风险

### 2.1 已核实的有利事实

| 项 | 状态 | 证据 |
| --- | --- | --- |
| **26 个 analyzer 插件** | **MIT**（Copyright (c) 2021 Saleae） | 各 `analyzers/*/LICENSE` **md5 全部相同** |
| **SDK 公开头文件**（9 个） | 随 SDK 仓库分发 | `sdk/AnalyzerSDK/include/` |
| **SDK testlib 源码** | **以源码形式提供** | `sdk/AnalyzerSDK/testlib/*.cpp` |
| **闭源 `libAnalyzer` 二进制** | **不需要** | `otool -L libsaleae_compat.dylib` → 只依赖 `libc++` / `libSystem` |
| 公开 SDK 与随应用分发的 `libAnalyzer` | **两个不同构建**，但 **SDK API 面相同** | UUID 不同（`32AB0FCF` vs `1DDAF91B`）；`AnalyzerResults` 89/89、`AnalyzerChannelData` 17/17、`FrameV2` 15/15 符号数一致；差异全是内嵌 zstd |
| ABI 稳定性 | **Saleae 明确承诺** | `LogicPublicTypes.h:51` 注释："this class can not add, remove or reorder member variables without breaking binary compatibility" |

**所以 LLA 这条链的授权是干净的 MIT，且不依赖任何闭源二进制。**
这是本次评估最有价值的发现。

### 2.2 已核实的风险

| 风险 | 说明 |
| --- | --- |
| **`saleae` Python 包无许可证文件** | 整个 `pythonlibs/` 下**找不到任何 LICENSE**。它是随 Logic 2 分发的，不是公开 SDK 的一部分 |
| **`SaleaeTime` 是 Cython，编译进宿主二进制** | `saleae/data/timing.pxd` 只有**声明**；实现是 `.pyx`，路径出现在 graph server 的构建字符串里（`.../saleae/data/analog_span.pyx`）→ **拿不到源码** |
| **闭源 SDK 的"非公开部分"** | 公开 `libAnalyzer`（563 符号）缺 175 个符号且多为 boost；随应用版（1232 符号）多出的是 zstd。**结论：公开版对 analyzer 用途是完整的**，但这是基于符号对比，未做全功能回归 |
| **商标与生态表述** | 不可声称"兼容 Saleae"或使用其商标；社区扩展的作者也可能对再分发有预期。**需法务确认** |

### 2.3 一个关键的降险判断

`saleae` 包**没有任何 LICENSE** → **不要 vendor 它的文件**。
但**API 面只有约 200 行、且是公开文档化的接口**，因此：

> **自行实现这约 200 行兼容 API，而不是复制 Saleae 的文件。**
> 接口（类名、方法签名）是公开文档化的契约；自行实现既规避了复制风险，
> 又能顺便解决 `SaleaeTime` 拿不到源码的问题（用宿主自己的时间类型鸭子类型替代）。

---

## 3. 三条集成路径对比

| | **A. 直接链接官方闭源 SDK** | **B. 用 MIT 源码自建运行时**（推荐） | **C. 干净实现自己的插件协议** |
| --- | --- | --- | --- |
| 做法 | 链接 `libAnalyzer.dylib`，把它当黑盒宿主 | 用 SDK 公开头文件 + `testlib` 源码重建宿主运行时；编译官方插件 | 自定协议，自己写插件 |
| **现成生态** | ✅ 全部 26 个 + 社区 | ✅ **同样全部**（插件源码是 MIT） | ❌ 从零 |
| **法律风险** | ⚠️ 依赖闭源二进制，授权未明 | ✅ **纯 MIT**（已验证不链接闭源） | ✅ 干净 |
| **技术依赖** | ⚠️ 被绑死在 Saleae 的二进制与发布节奏 | ✅ 源码在手，可改可修 | ✅ 无 |
| **性能** | 与 B 相同量级（同一个插件本体） | 已实测：见 §6 | 取决于自研核心 |
| **可维护** | 差（黑盒、ABI 不可控） | 好（可 patch、可裁剪） | 好但工作量最大 |
| **扩展成本** | 低但受制于人 | **低**（插件二进制兼容，可直接吃社区扩展） | 极高 |
| **结论** | **不推荐** | **推荐（已完成）** | 仅在放弃生态时考虑 |

**A 为什么不推荐**：你付出了闭源依赖的代价，却**拿不到 A 独有的好处**——
因为插件本体（`analyzers/*`）本来就是 MIT 的，A 与 B 跑的是**同一个插件代码**。
A 唯一的"优势"是少写一层运行时，而这一层 pxlogic 已经写完了。

**C 为什么不推荐**：这正是你说的"自建生态几乎不可能获得社区扩展"。
C 等于放弃本评估的全部价值。

---

## 4. 当前进度：你已经走到哪了

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 官方 LLA 插件（26 个） | ✅ **已集成** | `vendor/saleae-standalone/analyzers/` + `runtime/CMakeLists.txt` 的 `SALEAE_ANALYZER_CATALOG` |
| 不依赖闭源二进制 | ✅ **已验证** | `libsaleae_compat.dylib` 只依赖 `libc++`/`libSystem` |
| 插件**二进制兼容** | ✅ | CMake 注册别名 `Saleae::AnalyzerSDK`，**未修改的插件 CMakeLists 可直接编译** |
| 稳定 C ABI 适配层 | ✅ **已存在** | `runtime/include/saleae_compat.h`（约 60 个 `sr_*` 函数） |
| FrameV2 输出 | ✅ | CMake `target_compile_definitions(... PUBLIC LOGIC2)` |
| 气泡文本（插件自带渲染） | ✅ | `sr_session_generate_bubble_text` |
| 增量解码 + 取消 | ✅ | `sr_session_enable_incremental_results` / `sr_session_progress_sample` / `sr_session_cancel` |
| **HLA 清单解析 + UI** | ✅ **已有** | `src/lib/extensions.ts`、`src/components/ExtensionsPanel.tsx` |
| **HLA 模板脚手架** | ✅ **已有** | `src-tauri/src/main.rs:1928` 生成的模板就是 `from saleae.analyzers import ...` |
| **HLA 执行引擎** | ❌ **缺** | 所有 crate 均无脚本引擎（grep `pyo3`/`rustpython`/`mlua`/`rhai`/`quickjs`/`v8` 全空） |
| 测量扩展（Measurement） | ❌ 缺 | schema 支持，无执行 |

**所以缺口只有一个：HLA（以及顺带的测量扩展）的 Python 执行。**

---

## 5. 推荐方案与架构分层

### 5.1 推荐：B2 —— 自建运行时 + 自实现 HLA 兼容层

```
┌─────────────────────────────────────────────────────────────┐
│ L4  扩展生态层                                                │
│   · 官方 LLA 插件（26 个，MIT，已集成）                        │
│   · 社区 HLA / 测量扩展（extension.json + Python）             │
│   · 自研扩展（同一格式）                                       │
├─────────────────────────────────────────────────────────────┤
│ L3  HLA 运行时（待建，约 200 行兼容层 + CPython）              │
│   · saleae.analyzers 兼容模块（自实现，非复制）                 │
│   · decode() 逐帧驱动 + result_types Handlebars 渲染           │
│   · settings 反射收集 + 校验                                   │
├─────────────────────────────────────────────────────────────┤
│ L2  LLA 运行时（已完成）                                       │
│   · libsaleae_compat（SDK testlib 源码 + 自研 compat）         │
│   · sr_session_* C ABI ← 稳定边界                             │
│   · AnalyzerChannelData 自实现（喂稀疏转移）                   │
├─────────────────────────────────────────────────────────────┤
│ L1  自研解码核心                                               │
│   · 稀疏转移索引 / 帧模型 / 视口                              │
└─────────────────────────────────────────────────────────────┘
```

**分层原则**：`sr_session_*` C ABI 是**唯一稳定边界**。
L3 与 L4 都只依赖它，不依赖 C++ 对象布局。
这样 SDK 或插件升级时，改动被限制在 L2。

### 5.2 HLA 运行时的最小实现

**建议：把 HLA 执行放在 sidecar 进程内（复用现有隔离模型），不要嵌进 Rust 主进程。**

理由：HLA 是**第三方 Python 代码**，会崩、会死循环、会 import 任意包。
放进主进程等于把稳定性交给扩展作者。现有 `pxlogic-saleae-analyzer-sidecar`
已经是"独立进程 + JSON"的成熟模型，直接扩展即可。

```
Rust 主进程 ──NDJSON──> sidecar(CPython) ──> saleae.analyzers 兼容模块
                                              └─> 用户 HLA 的 decode()
```

**驱动循环（伪代码）**：

```python
hla = HlaClass(settings)                  # 元类已做设置注入与校验
hla.result_types                          # 宿主读取，编译成 Handlebars 模板
for lla_frame in lla_frames:              # 来自 L2 的 FrameV2/Frame
    af = AnalyzerFrame(lla_frame.type, to_time(lla_frame.start),
                       to_time(lla_frame.end), lla_frame.data)
    out = hla.decode(af)                  # 单个 / list / None
    emit(out)
```

**关键点**：`decode()` 是**逐帧流式**的，天然支持增量；
输入帧来自 LLA，所以 L3 只是 L2 输出的消费者，**不引入新的数据转换**。

---

## 6. 性能影响（基于已实测数据）

pxlogic 的 LLA 路径**已经测过**，结论可直接外推：

| 阶段 | 实测（2.5M×32ch，I2C+SPI，p50） |
| --- | --- |
| 冷启动全量解码 | 66.24 ms（**一次**，count=1） |
| **稳态窗口增量解码** | **~1.00 ms / 窗口**（count=14） |
| JSON 编解码占解码比 | **0.41%** |
| 单帧后端成本 | 0.98 ms（缓存命中）/ 8.37 ms（需解码） |
| 气泡聚合 | **0.04 ms**（可忽略） |

**三个结论：**

1. **JSON IPC 不是瓶颈（0.41%）** —— 所以 HLA 用同样的 NDJSON 传输是安全的，
   **不需要**为了 HLA 上共享内存或二进制协议。
2. **时间花在 sidecar 内的解码本体**（95%），即插件自身的计算。
   换任何集成方式都不会改变这一点。
3. **HLA 的增量是可行的**：L2 已有 `StartProcessing(starting_sample)` 与
   `sr_session_enable_incremental_results`，L3 逐帧消费即可，
   **不需要重解码历史**。

**但有一个必须警惕的点**：HLA 是 Python，**每帧一次 Python 调用**。
若 LLA 产出 32,915 帧，就是 32,915 次 `decode()` 调用 + 对象分配。

**这一项已实测（不再是待核实项）**，用与 fixture 相同的 32,915 帧：

| HLA 形态 | ns/帧 | 33k 帧总耗时 | 占 LLA 解码(66.2 ms) |
| --- | --- | --- | --- |
| 空 `decode()`（框架地板） | ~39 | 1.3 ms | **2.0%** |
| 真实状态机（累积字节、遇分隔符发帧） | 39.4 | 1.3 ms | **2.0%** |
| 格式化密集（`%` 格式化 + 分支 + 建 dict） | 358.5 | **11.8 ms** | **17.8%** |

**结论：HLA 不是性能瓶颈。** 框架开销约 **39 ns/帧**，即 33k 帧约 **1.3 ms**，
只占 LLA 解码的 **2%**；即便是格式化密集的 HLA 也仅 11.8 ms（18%）。

> **这推翻了我最初的担心。** 我原先按"Python 调用 1–5 µs/帧"估出 30–160 ms，
> 实测低了约 **25–100 倍**。原因：CPython 3.13 的自适应特化解释器让
> 平凡方法调用降到约 12 ns（已用 `sum(range(1000))` ≈ 5.2 µs 交叉校准过计时器），
> 而 `__slots__` 的帧对象 + 小 dict 各约 0.07/0.04 µs。
>
> **所以不需要**为 HLA 做批量化、也不必然需要"只对可见区间驱动"。
> 直接全量逐帧驱动即可，剩下的成本属于 HLA 作者自己的逻辑。

> ⚠️ 该测量用的是 3.13；Logic 2 内嵌的是 **python3.14**。数量级结论应可移植，
> 但若要精确对齐应在 3.14 上复测。

注意 `saleae/measurements/` 与 `range_measurements/` 也是 Python，
同样受此影响，但同理不构成瓶颈。

---

## 7. 主要限制与前提条件

**限制**

1. **HLA 只能消费 LLA 的输出**，不能直接读原始样本。所以 HLA 的可用性
   取决于 LLA 覆盖 —— 好在你已有 26 个。
2. **`SaleaeTime` 无法直接复用**（Cython，无源码）。需自实现时间类型，
   鸭子类型兼容；**大部分 HLA 只做传递或比较，风险可控，但需实测**。
3. **`saleae` 包无许可证** → 必须自实现，不能 vendor。
4. **不保证社区 HLA 全部可跑**：它们可能 `import numpy` 或依赖
   Logic 2 特有模块（`saleae.measurements` 等）。需要一份"兼容子集"说明。
5. **`sr_session_*` 是自研 ABI**，一旦对外发布就变成你自己的兼容负担。

**前提条件**

1. 需要一个**可控的 CPython 分发**（python-build-standalone 之类），
   且要能随应用打包 —— Logic 2 用的是 python3.14 + numpy。
2. 需要一份 **HLA 兼容性测试集**（拿社区真实 HLA 跑）。
3. **法务确认**：自实现兼容 API 的边界、是否可表述为"支持 Saleae HLA 格式"。
4. 若走 sidecar，需要定义 **L2→L3 的帧传输格式**（建议直接沿用现有 NDJSON）。

---

## 8. 需要进一步核实的信息

按优先级：

| # | 待核实 | 为什么重要 |
| --- | --- | --- |
| 1 | ~~HLA 逐帧调用的实际开销~~ **✅ 已实测**：框架约 39 ns/帧（33k 帧 = 1.3 ms = LLA 的 2%），格式化密集的 HLA 也仅 11.8 ms（18%） | **原为最高风险项，现已排除**。但测量基于 CPython 3.13，Logic 2 用 3.14，如需精确对齐应在 3.14 复测 |
| 2 | `SaleaeTime` 被 HLA 实际用到的程度（社区 HLA 抽样统计） | 决定时间类型鸭子类型替代的可行性。**这是现在最大的剩余不确定性** |
| 3 | 公开 `libAnalyzer` 与随应用版的功能等价性（全量回归，非符号对比） | 目前只做了符号面比对 |
| 4 | `saleae` 包的授权来源（是否来自公开仓库/文档站点） | 决定能否 vendor 而非自实现 |
| 5 | 社区 HLA 的 import 依赖分布（numpy / Logic 特有模块占比） | 决定"兼容子集"的边界与宣传口径 |
| 6 | 测量扩展（Measurement）是否也需要（schema 已支持，当前未实现） | 影响 L3 范围 |
| 7 | 商标与兼容性表述的法务边界 | 影响对外宣传 |

---

## 9. 建议的下一步（按顺序）

1. ~~先做 #1 的实测~~ **✅ 已完成**，结论：HLA 框架开销 2%，**全量逐帧驱动可行**，
   不需要批量化或可见区间裁剪。
2. **改为先做 #2**：抽样若干真实社区 HLA，统计它们如何使用 `start_time` / `end_time`
   （只传递？做算术？比较？格式化？）。**这决定 `SaleaeTime` 能否用鸭子类型替代**，
   是当前最大的剩余风险。
3. 实现 `saleae.analyzers` 兼容模块（约 200 行）+ sidecar 驱动，
   拿 2–3 个真实社区 HLA 验证。
4. 全程**不要 vendor** `saleae` 包的文件；**不要**链接闭源 `libAnalyzer`。
5. 补一份"兼容 HLA 子集"的公开说明，管理社区预期。
