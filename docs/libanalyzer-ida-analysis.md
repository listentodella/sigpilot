# IDA 分析 `libAnalyzer`：解码核心的真实结构与优化判断

用 idalib headless 反编译 `libAnalyzer.dylib`（570KB 公开构建 / 1.58MB 随应用版）
与 `libgraph_server_shared.dylib`（46MB），回答两个问题：
**① 我们的重实现哪里可以优化？② 是否干脆直接用原版？**

---

## 0. 最重要的发现：解码核心是**跨两个闭源库拆开的**

原以为"解码核心 = `libAnalyzer.dylib`"。**实际不是。**

```
libAnalyzer.dylib（闭源）
  ├─ Analyzer / AnalyzerResults / AnalyzerHelpers / DataBuilder / BitExtractor   ← SDK 运行时
  ├─ AnalyzerChannelData   ← 薄包装器
  └─ ChannelData           ← 【抽象接口】vtable 槽 +16..+104 全是 __cxa_pure_virtual
                              ★ 没有任何具体子类

libgraph_server_shared.dylib（闭源，46MB）
  ├─ Saleae::Graph::DigitalChannelData : ChannelData    ← 【真正的实现在这里】
  └─ Saleae::Graph::AnalyzerNode::CreateChannelData(const std::set<int>&)  ← 工厂
```

**证据**：`libAnalyzer` 的 `ChannelData` vtable（`__ZTV11ChannelData` @ `0x150330`）：

```
[ 0] +  0  ChannelData::~ChannelData()      ← 真实
[ 1] +  8  ChannelData::~ChannelData()      ← 真实
[ 2] + 16  ___cxa_pure_virtual
[ 3] + 24  ___cxa_pure_virtual
  ...
[13] +104  ___cxa_pure_virtual              ← 槽 +16..+104 全部是纯虚
[14] +112  RTTI
```

**`libAnalyzer` 里找不到任何 `ChannelData` 的具体子类**（扫描全部 `__ZTV*`，
只有 4 个带真实槽的 vtable：`Analyzer2` / `ChannelData` / `AnalyzerResults` / `AnalyzerSettings`，
其中 `ChannelData` 的真实槽只有两个析构函数）。

而 `libgraph_server_shared` 里有 `typeinfo for Saleae::Graph::DigitalChannelData`，
其 typeinfo 对象的基类指针指向 `__ZTI11ChannelData` —— **确认它就是 `ChannelData` 的实现者**。

---

## 1. `AnalyzerChannelData` 的真实结构：薄包装 + 虚转发

### 构造函数（`libAnalyzer` @ `0x27a0`）

```c
void AnalyzerChannelData::AnalyzerChannelData(AnalyzerChannelData *this, ChannelData *a2)
{
  _QWORD *v4 = operator new(0x10);                                 // 16 字节
  *v4     = a2;                                                    // [0] = 内部 ChannelData*
  v4[1]   = (*(a2->vptr + 104))(a2);                               // [8] = 缓存 vtable[+104]
  *(_QWORD *)this = v4;                                            // mData = v4
}
```

所以 `mData` 是 `{ChannelData* inner; u64 cached;}`。

### 被我们桩掉的两个方法（真实实现）

```c
// 0x2930
U64 AnalyzerChannelData::GetMinimumPulseWidthSoFar(this)
{
  return (*(***(_QWORD***)this + 56))(**(_QWORD**)this);   // inner->vtable[+56](inner)
}

// 0x29ac
void AnalyzerChannelData::TrackMinimumPulseWidth(this)
{
  return (*(***(_QWORD***)this + 80))(**(_QWORD**)this);   // inner->vtable[+80](inner)
}
```

**两个方法都只是"向内层对象虚转发"** —— 真正的脉宽跟踪逻辑在
`DigitalChannelData` 里，**不在 `libAnalyzer` 里**。

### 触发样本（真实实现）

```c
// Analyzer::GetTriggerSample  @ 0x266c
__int64 Analyzer::GetTriggerSample(this)
{
  result = *(_QWORD *)(*((_QWORD *)this + 1) + 16LL);   // mData->[16]
  if ( result ) JUMPOUT(0x12154);                       // 尾调 DeviceCollection::GetTriggerSample
  return result;
}

// DeviceCollection::GetTriggerSample  @ 0x12154
__int64 DeviceCollection::GetTriggerSample(a1) { return *(_QWORD *)(a1 + 48); }  // 字段 +48
```

**语义：`Analyzer::GetTriggerSample()` = `deviceCollection->triggerSample`（偏移 +48）**，
为空时返回 0。pxlogic 返回硬编码 `2`，**语义完全不对**。

---

## 2. pxlogic 为什么会桩掉它们（以及这是不是"错"）

pxlogic 的 `libsaleae_compat` 来自 SDK 的 **`testlib`（单元测试桩）**，
而 testlib 的 `MockChannelData` **直接继承 `AnalyzerChannelData`**，
用 `reinterpret_cast<MockChannelData*>(this)` 读自己的字段：

```cpp
// native/saleae-analyzer-sidecar/src/sdk_compat.cpp:50
bool AnalyzerChannelData::DoMoreTransitionsExistInCurrentData()
{
    auto* data = reinterpret_cast<AnalyzerTest::MockChannelData*>(this);
    const auto next = std::upper_bound(data->mTransitions.begin(), ...);
    return next != data->mTransitions.end();
}
```

**也就是说：pxlogic 完全绕过了 `ChannelData` 抽象层**，把
`AnalyzerChannelData` 从"薄包装器"改造成了"数据持有者"。

**这个改动的两面性：**

| 面 | 评价 |
| --- | --- |
| ✅ **更简单、更快** | 少一层对象、少一次虚调用。`DoMoreTransitionsExistInCurrentData` 直接二分查自己的数组 |
| ⚠️ **丢功能** | `ChannelData` 层的 12 个虚函数**一个都没实现** → 凡是依赖它们的插件行为缺失 |

**所以这不是"实现得不够忠实"，而是一个有意的架构简化。** 问题只在于：
**它丢掉了哪些插件真正用到的行为** —— 已确认是 serial / modbus 的 auto-baud。

---

## 3. 优化建议（针对我们的实现）

### O1. `GetTriggerSample()` —— 最该修，收益面最广

**现状**：`testlib/AnalyzerStubs.cpp:37` 硬编码 `return 2`，全仓库无处覆盖。

**真实语义**：`deviceCollection->triggerSample`（+48）。

**修法**：触发样本是一个 `u64`，在 C API 层透传即可：

```c
// saleae_compat.h 新增
int sr_session_set_trigger_sample(sr_session* session, uint64_t sample);
```
```cpp
U64 Analyzer::GetTriggerSample() { D_PTR(); return d->triggerSample; }   // 不再返回 2
```

**影响面**：`can` `biss` `atmel-swi` `dmx-512` `async-rgb-led` 等**大量插件**
调用它来定位输出。恒为 2 会让它们的**输出位置静默错误**——不崩溃，更难发现。

### O2. 脉宽跟踪 —— 用我们已有的稀疏索引直接实现

**不需要**复刻 `ChannelData` 那 12 个虚函数。真实实现在
`DigitalChannelData` 里，而 pxlogic 的数据结构**已经具备所需信息**：

- `DigitalChannelIndex { edges: Vec<u64> }` —— 跳变样本号，已按序
- 最短脉冲宽度 = **相邻边沿间距的最小值**，O(edges) 或增量维护

```cpp
void AnalyzerChannelData::TrackMinimumPulseWidth()
{
    // 在已有 edges 上增量维护 min(pulse width)
    auto* d = reinterpret_cast<AnalyzerTest::MockChannelData*>(this);
    d->trackingMinimumPulseWidth = true;
    d->updateMinimumPulseWidth();     // 扫相邻边沿差的最小值
}

U64 AnalyzerChannelData::GetMinimumPulseWidthSoFar()
{
    auto* d = reinterpret_cast<AnalyzerTest::MockChannelData*>(this);
    return d->trackingMinimumPulseWidth ? d->minimumPulseWidthSoFar : 0;
}
```

**注意一个语义细节**：真实实现里 `GetMinimumPulseWidthSoFar` 是**虚转发**，
说明它的行为取决于内层对象；而 pxlogic 两处兼容层分别返回 `UINT64_MAX` 与 `0`，
**都不是正确语义**（未跟踪时应返回 0 或"未知"的约定值，需按插件用法确认）。

### O3. 消除两套兼容层的重复定义

`sdk_compat.cpp`（sidecar）与 `compat_extensions.cpp`（runtime）**定义了同一批符号**
且取值不一致（`UINT64_MAX` vs `0`）。应合并为一处，否则链接结果依赖符号解析顺序。

### O4. 补一次系统性缺口盘点

本文只查了 4 个 API。建议把 `libAnalyzer` 导出的 1232 个符号与兼容层逐一对照，
**只看插件实际导入的那 108 个**，标出「真实现 / 桩 / 缺失」。
`ChannelData` 的 12 个纯虚函数是重点检查项（pxlogic 一个都没实现）。

---

## 4. 「直接用原版 `libAnalyzer` 更直接吗？」—— **不，而且它并不能解决问题**

这是本次分析**最重要的结论**。

### 4.1 关键事实：`libAnalyzer` 本身**不完整**

`ChannelData` 是**抽象接口**，具体实现 `DigitalChannelData` 在
**`libgraph_server_shared.dylib`（46MB 闭源）** 里。

**所以"直接用 `libAnalyzer`"拿不到能工作的脉宽跟踪** ——
你仍然得自己实现 `ChannelData` 的 12 个纯虚函数，
或者**连 graph server 一起加载**（那就等于走 bridge 那条路了）。

**换句话说：`libAnalyzer` 不是"解码核心"，它只是"解码核心的一半"。**
"直接用它"这个选项，**在技术上并不存在**。

### 4.2 而且它并不比现在更省事

| | 现状（MIT 重实现） | 改用 `libAnalyzer` |
| --- | --- | --- |
| 符号覆盖 | 已 108/108 | 同样 108/108 |
| `ChannelData` 实现 | 需自己写（或绕过） | **仍需自己写**（libAnalyzer 里没有） |
| 脉宽 / 触发样本 | 桩（待修） | **仍是桩**（实现不在这个库里） |
| 授权 | 纯 MIT | 闭源依赖，**分发授权未明** |

**结论：改用 `libAnalyzer` 收益为零，代价是引入闭源依赖。**

### 4.3 关于"只本地用、不商用"

即便只在本地构建工具用，仍有三个实际问题：

1. **它解决不了你真正缺的东西**（§4.1）—— `DigitalChannelData` 不在这个库里。
   真要"直接用"，唯一完整的选择是**走 bridge**（让整个 Logic 2 跑起来），
   而那已经是另一个产品路线了。
2. **调试与排障会变难**：闭源二进制出问题时无法插桩、无法看内部状态。
   这次能发现脉宽/触发样本的问题，**正是因为我们的实现是开源的**。
3. **"本地用"不影响许可证条款**：授权约束的是**复制与分发**，不是"是否收费"。
   MIT 路径已经把这件事变简单了，没有理由反向走回去。

**我的建议不变：继续用 MIT 重实现，按 §3 补上缺口。**
真正需要修的东西是**可枚举的**，而且比想象中少
（`ChannelData` 12 个纯虚函数里，插件实际用到的只有脉宽相关的那几个）。

---

## 5. 附：本次用到的 IDA 手法

| 手法 | 用途 |
| --- | --- |
| `nm -gU` 定位导出符号地址 | `libAnalyzer` 有 1232 个导出符号，**不必盲搜** |
| `__TEXT` 的 `vmaddr == fileoff == 0` | 文件偏移即 VA，可直接按字节搜常量 |
| `ida_funcs.add_func(ea)` | 符号存在但 IDA **未建函数**时（`is_code=False`）手动创建，之后才能反编译 |
| 扫描 `__ZTV*` 的槽 | 区分「真实实现」与 `___cxa_pure_virtual`，一眼看出哪个类是抽象接口 |
| `typeinfo` 对象的**基类指针** | `DigitalChannelData` 的 typeinfo 指向 `__ZTI11ChannelData` → **确认继承关系** |
| 反编译构造函数 | 一次看清对象布局（`mData` = `{inner, cached}`）与虚表偏移 |

**一个没做成的**：`DigitalChannelData` 的 vtable 没有符号，按 Itanium ABI
用 `typeinfo` 反查 `vtable[-1]` 也未命中（该段 vmaddr≠fileoff，且无 xref）。
**所以脉宽的具体算法没有反编译出来** —— 但结论不依赖它：
无论它怎么算，**实现都不在 `libAnalyzer` 里**，这一点已经由"没有具体子类"证实。

---

# 第二轮：更深入分析（含对第一轮结论的更正）

用 `reverse-engineering` 技能的方法论（metadata → 自顶向下 → 数据驱动）重做了一遍。
**结果推翻了我第一轮的两条判断。**

## 7. 元信息

| | `libAnalyzer.dylib` | `libgraph_server_shared.dylib` |
| --- | --- | --- |
| 架构 | ARM64 | ARM64 |
| imagebase | `0x0` | `0x0` |
| 函数数 | **122** | **85,988** |
| 符号数 | 4,751 | 54,826 |
| 导入模块 | `<self>`, libc++abi, libSystem | `<self>`, libc++abi, **`@rpath/libAnalyzer.dylib`**, ncurses, panel …（共 10） |

**新发现：`libgraph_server_shared.dylib` 导入了 `@rpath/libAnalyzer.dylib`。**
所以真实依赖链是：

```
插件(.so) ──> libsaleae_compat（pxlogic）
                    ↑
              原版：libAnalyzer.dylib  ←── libgraph_server_shared.dylib 导入它
```

**graph server 是 `libAnalyzer` 的宿主** —— 与 §0 的结论一致（`ChannelData` 的实现者在 graph server 里）。

## 8. 找到 `DigitalChannelData` 的虚表了（第一轮没找到）

第一轮失败的原因：**typeinfo 对象的基址算错了 8 字节**。

Itanium ABI 下 `si_class_type_info`（单继承）的对象布局是：

```
[+0]  typeinfo 类自身的 vptr
[+8]  __type_name  → 类名字符串        ← 我第一轮把这个槽当成了对象起点
[+16] __base_type  → 基类 typeinfo
```

所以对象起点 = 名字串指针所在地址 **减 8**。修正后：

```
typeinfo object @ 0x291d320:
  [+0]  0x2ba89f8   (typeinfo class vptr)
  [+8]  0x135a090   "N6Saleae5Graph18DigitalChannelDataE"
  [+16] 0x2ba8b78   __ZTI11ChannelData          ← 确认继承
```

扫描全部段找指向 `0x291d320` 的 qword → **命中 1 处 `0x291d2a8`**
→ **虚表在 `0x291d2b0`**。

```
=== DigitalChannelData vtable @ 0x291d2b0 ===
  [ 0] +  0  0x00276248   (dtor)
  [ 1] +  8  0x0027624c   (dtor)
  [ 2] + 16  0x00275224   Advance(num_samples)
  [ 3] + 24  0x0027526c   AdvanceToAbsPosition(sample)      ← 760 字节，真正的走边沿逻辑
  [ 4] + 32  0x00275580   AdvanceToNextEdge
  [ 5] + 40  0x00275970
  [ 6] + 48  0x00275b68   bool: *(a1+424) == 1
  [ 7] + 56  0x00275b78   GetMinimumPulseWidthSoFar   ★
  [ 8] + 64  0x00275b88   atomic_load(a1+472)          ← 当前样本号
  [ 9] + 72  0x00275b94   → sub_275BB8(a1, INT64_MAX, &b)
  [10] + 80  0x00275dc4   nullsub_2551                ★ TrackMinimumPulseWidth
  [11] + 88  0x00275dd0   Advance 的变体
  [12] + 96  0x00275de8   → sub_275BB8(a1, a2, &b)
  [13] +104  0x00275dc8   return *(a1+496)
```

**`+56` 与 `+80` 正是 `AnalyzerChannelData` 那两个方法转发的槽** —— 与第一轮推断吻合。

## 9. ★ 更正一：`TrackMinimumPulseWidth()` 真实实现**也是空操作**

```c
// vtable+80  @ 0x275dc4
void nullsub_2551() { ; }        // 4 字节，只有 ret
```

**所以 pxlogic 的空实现是正确的，我第一轮说"功能缺失"是错的。**

## 10. ★ 更正二：`UINT64_MAX` 是**正确**的哨兵，而 `0` 才是错的

```c
// vtable+56  @ 0x275b78  GetMinimumPulseWidthSoFar
if ( *(u64*)(a1 + 480) )  return *(u64*)(a1 + 480);
else                      return -1;              // ← -1 == UINT64_MAX
```

**真实语义：返回 `+480` 字段；该字段为 0（未设置）时返回 `-1`。**

对照 pxlogic 的两套实现：

| 文件 | 返回 | 判定 |
| --- | --- | --- |
| `native/saleae-analyzer-sidecar/src/sdk_compat.cpp` | `std::numeric_limits<U64>::max()` | **哨兵正确** ✅（等于 `-1`） |
| `vendor/saleae-standalone/runtime/cpp/compat_extensions.cpp` | `0` | **哨兵错误** ❌ |

**我第一轮说"两者都不正确"是错的** —— 应该是「一个哨兵对、一个哨兵错」。

### 而且**实际生效的是错的那个**

插件是独立 `.so`，链接的是 `libsaleae_compat.dylib`，
所以插件里的调用解析到 `compat_extensions.cpp` 的定义。反汇编确认：

```asm
__ZN19AnalyzerChannelData25GetMinimumPulseWidthSoFarEv:
0000000000008910	mov	x0, #0x0        ← 返回 0
0000000000008914	ret
```

顺带确认另外两个（与第一轮一致）：

```asm
__ZN19AnalyzerChannelData47GetNumberOfTransitionsToAbsPositionMinimumWidthEyy:
0000000000008918	b	__ZN19AnalyzerChannelData20AdvanceToAbsPositionEy   ← 忽略 minimum_width

__ZN8Analyzer16GetTriggerSampleEv:
000000000000148c	mov	w0, #0x2        ← 硬编码 2
0000000000001490	ret
```

（`DeviceCollection::GetTriggerSample` 在 `libsaleae_compat` 里**根本不存在** ——
pxlogic 的兼容层没有 DeviceCollection 这个概念。）

## 11. ★ 真正的脉宽算法（第一轮没拿到）

第一轮说"脉宽的具体算法没反编译出来"。这次拿到了，在 `sub_275580`（`AdvanceToNextEdge`）尾部：

```c
v18 = *(_QWORD *)(a1 + 400);                     // 本次边沿的样本号
v19 = *(_QWORD *)(a1 + 480);                     // minPulseWidthSoFar
if ( !v19 ) v19 = -1;                            // 0 视为未设置 → UINT64_MAX
if ( v18 - *(_QWORD *)(a1 + 488) < v19 )         // (cur - prev) < min ?
    v19 = v18 - *(_QWORD *)(a1 + 488);           //   则更新 min
*(_QWORD *)(a1 + 480) = v19;                     // 存回 min
*(_QWORD *)(a1 + 488) = v18;                     // prev = cur
atomic_store(v18, (unsigned __int64 *)(a1 + 472));  // 当前样本号
```

**归纳成伪代码：**

```python
prev = 0
min_so_far = 0                     # 0 == 未设置
# 每次推进到下一个边沿时无条件执行：
cur = <本次边沿样本号>
gap = cur - prev
if min_so_far == 0 or gap < min_so_far:
    min_so_far = gap
prev = cur

def GetMinimumPulseWidthSoFar():
    return min_so_far if min_so_far else (2**64 - 1)
```

**三点关键语义：**

1. **追踪是"推进边沿的副作用"，无条件进行** —— 这解释了为什么
   `TrackMinimumPulseWidth()` 是空操作（它是历史遗留的开关，现在恒开）。
2. **`0` 代表"未设置"**，不是"零宽脉冲"。
3. **未设置时对外返回 `-1`（UINT64_MAX）**，不是 `0`。

**对象字段布局（`DigitalChannelData`）：**

| 偏移 | 用途 |
| --- | --- |
| `+400` | 本次边沿样本号（推进时读） |
| `+424` | 状态枚举（vtable[6] 判 `== 1`） |
| `+472` | 当前样本号（atomic，vtable[8] 返回） |
| `+480` | **minPulseWidthSoFar** |
| `+488` | **上一次边沿样本号** |
| `+496` | vtable[13] 返回的值 |

**结论：我第一轮的 O2 建议（"用相邻边沿间距的最小值实现，基于我们已有的稀疏索引"）
方向是对的，现在有了精确语义** —— 包括 `0`=未设置、返回 `-1`、
以及在 advance 路径里维护这三点。

## 12. 更正后的优化清单

| # | 项 | 现状（反汇编确认） | 修法 |
| --- | --- | --- | --- |
| **O1** | `Analyzer::GetTriggerSample()` | `mov w0,#0x2` 硬编码 | C API 加 `sr_session_set_trigger_sample`，透传真实触发样本；影响 can/biss/atmel-swi/dmx-512 等大量插件 |
| **O2** | `GetMinimumPulseWidthSoFar()` | 生效实现返回 **`0`**（哨兵错） | 改成返回 `min ? min : (u64)-1`，**并在 advance 路径维护 min**（§11 算法） |
| **O2b** | `TrackMinimumPulseWidth()` | 空实现 | **不动 —— 空就是对的**（真实实现也是 no-op） |
| **O3** | `GetNumberOfTransitionsToAbsPositionMinimumWidth()` | 忽略 `minimum_width` | 按 min width 语义实现，或明确标注不支持 |
| **O4** | 两套兼容层重复定义 | `UINT64_MAX` vs `0`，实际生效的是 `0` | **合并为一处**，保留正确哨兵 |
| **O5** | `DeviceCollection` | 兼容层里不存在 | 若要支持 trigger 语义需补一个最小实现（只需一个 `u64` 字段） |

**优先级**：O1（影响面最广）→ O2/O4（一起改，同一个符号）→ O3 → O5。

---

# 实施记录（2026-09-23）

已按 §12 的优先级实施 **O1 / O2 / O2b / O4**。全部通过验证。

## 改动

| 文件 | 改动 |
| --- | --- |
| `runtime/cpp/compat_extensions.cpp` | **O2**：`GetMinimumPulseWidthSoFar()` 由 `return 0` 改为真实实现（扫描到游标的相邻边沿最小间距，未设置返回 `UINT64_MAX`）；**O2b**：`TrackMinimumPulseWidth()` 保持空实现并加注释说明为何正确；**O1**：新增 `SaleaeCompat::TriggerSample()` / `SetTriggerSample()` |
| `runtime/cpp/compat_internal.hpp` | 声明触发样本访问器，含完整理由 |
| `runtime/CMakeLists.txt` | **O1**：照 `MockResults.cpp` 的既有模式，用字符串替换把 testlib 的 `Analyzer::GetTriggerSample` 由 `return 2` 重定向到 `SaleaeCompat::TriggerSample()`（并注入 include）；新增 `enable_testing()` + `saleae_compat_tests` 目标 |
| `runtime/include/saleae_compat.h` | 新增 `sr_session_set_trigger_sample()` |
| `runtime/cpp/runtime_c_api.cpp` | 会话新增 `trigger_sample` 字段；`sr_session_run()` 在 `WorkerThread()` 前发布该值 |
| `runtime/cpp/test_pulse_width.cpp` | **新增**：13 条断言的回归测试 |
| `native/saleae-analyzer-sidecar/src/sdk_compat.cpp` | **O4**：**删除** |

## O4 的更正：它不是"重复定义"，而是死代码

上一版说"sdk_compat.cpp 与 compat_extensions.cpp 定义同一批符号，实际生效的是错的那个"。
**这是错的。** `build.sh` 只编译 `standalone_main.cpp`，而 `standalone_main.cpp`
也没有 `#include "sdk_compat.cpp"` —— **该文件从未参与编译**，所有符号都只来自
`libsaleae_compat`。所以不存在链接竞争，只是留了一个会误导人的孤儿文件（它确实误导了我）。
已删除。

## O2 的实现要点（三处踩坑记录）

1. **testlib 在 `mTransitions` 开头塞了一个哨兵**：
   `TestSetInitialBitState` 里有 `mTransitions.push_back(0);`，注释写着
   *"insert a dummy sample before the real data"*。它不是真实边沿，计入会得到
   一个虚假的首个脉宽（`first_edge - 0`）。已用 `first_real_transition()` 跳过。
   （真实边沿不可能落在样本 0：`TestAppendTransitionAtSamples` 断言 `sample > mCurrentSample`。）
2. **`TestAppendTransitions` 收的是增量而非绝对样本号** —— 它内部调
   `TestAppendTransitionAfterSamples`。测试里改用 `TestAppendTransitionAtSamples` 传绝对样本，读起来与推理一致。
3. **最初用"以通道指针为键的游标缓存"，被测试抓出设计缺陷**：
   栈上对象地址被复用时会继承上一轮的陈旧状态（测试里表现为 `got=20` 而非 `200`）。
   查过调用时机后放弃缓存：SDK 只从 **`Analyzer::NeedsRerun()`** 调它，即
   **worker 线程结束后**，所以每次从头扫描只付几次代价，而不是每个边沿。
   **去掉缓存同时也去掉了锁与整类失效问题。**

## 为什么 `UINT64_MAX` 是正确返回值（不只是"照抄原版"）

`serial-analyzer` / `modbus-analyzer` 的自动波特率里有：

```cpp
U64 shortest_pulse = mSerial->GetMinimumPulseWidthSoFar();
if( shortest_pulse == 0 )
    AnalyzerHelpers::Assert( "Alg problem, shortest_pulse was 0" );   // ← 旧的 return 0 会踩这里
U32 computed_bit_rate = U32( double( mSampleRateHz ) / double( shortest_pulse ) );
...
if( computed_bit_rate == 0 ) return false;   // ← 无有效数据时的正常出口
```

所以旧的 `return 0` **会主动触发断言**；而返回 `UINT64_MAX` 时
`computed_bit_rate` 算成 0，正好走已有的"数据无效就不重跑"出口。
**这不是风格选择，是行为正确性。**

## O1 的收益：修掉的是"时间戳偏移"

`i2s` / `unio` 等分析器的结果渲染里：

```cpp
U64 trigger_sample = mAnalyzer->GetTriggerSample();
AnalyzerHelpers::GetTimeString( frame.mStartingSampleInclusive, trigger_sample, sample_rate, time_str, 128 );
// 内部：double time = double( S64(sample) - S64(trigger_sample) );
```

**硬编码 `2` 意味着所有导出/表格时间戳都偏移 `(真实触发点 − 2)` 个样本。**
现在默认 0（= 无触发，时间相对采集起点），并可通过 `sr_session_set_trigger_sample()` 设成真值。
pxlogic 侧已有该数据（`metadata.trigger.sample_index`），**从 Rust 透传到 sidecar 属后续工作**。

## 验证

```
$ ctest --test-dir target/native/saleae-standalone-runtime-macos-arm64
1/1 Test #1: pulse_width ......  Passed    0.28 sec
100% tests passed

# 13 条断言全过（未设置返回 UINT64_MAX、取最小值、跳过哨兵、跨推进折叠、重复调用稳定、回退后重置）

$ nm -gU .../libsaleae_compat.dylib | grep trigger_sample
000000000000e134 T _sr_session_set_trigger_sample

# 反汇编确认两处硬编码都没了：
#   AnalyzerChannelData::GetMinimumPulseWidthSoFar  → 真实迭代（原为 mov x0,#0; ret）
#   Analyzer::GetTriggerSample                      → b SaleaeCompat::TriggerSample（原为 mov w0,#0x2）

$ cargo run --release ... --scenario 2.5m-i2c-spi   → passed=1 failed=0
$ cargo test --workspace                            → 198 passed / 0 failed
```

## 未做

- **O3** `GetNumberOfTransitionsToAbsPositionMinimumWidth` 仍忽略 `minimum_width`（已加注释标注）。
- **O5** 未补 `DeviceCollection`。
- **O1 的 Rust→sidecar 透传**未做（pxlogic 已有 `metadata.trigger.sample_index`，接上即可）。
