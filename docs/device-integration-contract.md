# 接入一个新的逻辑分析仪型号：契约与约束

> 回答四个问题：新设备要提供哪些**配置项**、要支持哪些**输出**、输出要转成什么**格式**、以及这些**是否已有标准**。
>
> 结论：**约束存在，但只存在于代码里，没有写下来。** 这份文档就是把它们写下来。

---

## 0. 先回答"是否已有标准或约束"

| 问题 | 答案 |
| --- | --- |
| 数据格式有约束吗？ | **有，而且是硬校验** —— `validate_metadata`（`crates/pxlogic-graph/src/lib.rs:4722`） |
| 有写下来的接入契约吗？ | **没有。** 只有代码里的 trait 与校验函数 |
| 现有文档覆盖这个吗？ | **不覆盖。** `docs/saleae-ecosystem-integration.md`（443 行）讲的是**解码器/HLA 生态**，不是硬件接入 |

**所以"立规矩"的具体含义 = 把已经在代码里隐式存在的契约写成文档，并尽量变成可执行的测试。**

---

## 1. 新设备必须提供的配置项

### 1.1 设备描述：`DeviceProfile`

`crates/pxlogic-core/src/pxview_profile.rs:48`（类型名待去厂商化，见 `docs/hardware-decoupling-assessment.md`）：

```rust
pub struct PxlogicDeviceProfile {
    pub vid: u16,                                    // USB Vendor ID
    pub pid: u16,                                    // USB Product ID
    pub usb_speed: PxUsbSpeed,
    pub variant_code: u32,                           // 厂商自己的变体标识（见 §5）
    pub vendor: &'static str,                        // 显示用
    pub model: &'static str,                         // 显示用
    pub hardware_depth_bits: u64,                    // 采样深度
    pub supported_modes: &'static [PxlogicChannelModeId],
    pub default_mode: PxlogicChannelModeId,
}
```

### 1.2 通道模式：`ChannelMode`

```rust
pub struct PxlogicChannelMode {
    pub id: PxlogicChannelModeId,
    pub stream: bool,                    // 是否流式
    pub channels: u8,
    pub default_samplerate_hz: u64,
    pub default_samplelimit: u64,
    pub min_samplerate_hz: u64,
    pub max_samplerate_hz: u64,
    pub description: &'static str,
}
```

**一个型号 = 一个 `DeviceProfile` + 一到多个 `ChannelMode`。** 这就是"配置项"的全部。

### 1.3 枚举时返回：`DeviceInfo`

`crates/pxlogic-core/src/models.rs:11`：

```rust
pub struct DeviceInfo {
    pub id: String,              // 稳定标识，后续所有调用都用它
    pub kind: DeviceKind,
    pub vid: u16, pub pid: u16,
    pub bus: Option<u8>, pub address: Option<u8>,
    pub label: String,           // 界面显示
    pub ready: bool,             // 是否可直接采集
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub usb_speed: Option<String>,
    pub variant_code: Option<u32>,     // 厂商自己的变体标识（见 §5）
    pub profile_model: Option<String>,
    pub probe_error: Option<String>,
}
```

---

## 2. 新设备必须支持的输出：`CaptureBackend`

`crates/pxlogic-core/src/transport.rs:12`：

```rust
pub trait CaptureBackend: Send + Sync {
    // 必须实现：
    fn list_devices(&self) -> Result<Vec<DeviceInfo>>;
    fn prepare_device(&self, device_id: &str, bitstreams: Option<&Bitstreams>) -> Result<()>;
    fn capture(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
    ) -> Result<CaptureData>;

    // 有默认实现，可选覆盖：
    fn capture_streaming(...) -> Result<CaptureData> { /* 退化为 capture + 一次性回调 */ }
    fn stop_capture(&self, _device_id: &str) -> Result<()> { Ok(()) }
}
```

**最少实现 3 个方法即可接入。** `capture_streaming` 与 `stop_capture` 有默认实现，但**要支持实时流式采集就必须覆盖 `capture_streaming`**（默认实现会退化成"采完再一次性给"，界面上就没有边采边画）。

### 输入侧：`CaptureSettings`

`crates/pxlogic-core/src/models.rs:59`（部分）：

```rust
pub struct CaptureSettings {
    pub device_id: String,
    pub sample_rate_hz: u64,
    pub channel_count: u8,
    pub enabled_channels: Vec<u8>,
    pub duration_ms: u64,
    pub buffer_size_mb: u64,
    pub decode_cross: bool,
    pub threshold_volts: f64,
    pub external_trigger_mode: ExternalTriggerMode,
    pub mode: CaptureMode,
    pub trigger_enabled: bool,
    pub trigger_channel: u8,
    pub trigger_kind: CaptureTriggerKind,
    /// 厂商协议自己的电平条件（见 §5）。不支持该方案的 backend 留空即可。
    pub vendor_trigger: Option<VendorTriggerSettings>,
}
```

**这些就是界面能下发给设备的所有参数。** 新设备若不支持其中某项（如 `threshold_volts`），backend 需要自行忽略或报错。

---

## 3. 输出必须转成什么格式

### 3.1 目标格式：`CaptureData`

```rust
pub struct CaptureData {
    pub metadata: CaptureMetadata,
    pub samples: Vec<u8>,        // 位打包的原始采样
}
```

### 3.2 `CaptureMetadata` 的硬约束

`crates/pxlogic-core/src/models.rs:185`：

```rust
pub struct CaptureMetadata {
    pub version: u32,
    pub source_device: String,
    pub sample_rate_hz: u64,
    pub channel_count: u8,
    pub enabled_channels: Vec<u8>,
    pub unitsize: u8,              // ★ 每采样单元的字节数
    pub sample_count: u64,
    pub captured_at: DateTime<Utc>,
    pub labels: Vec<String>,
    pub trigger: Option<CaptureTriggerMetadata>,
}
```

### 3.3 ★ 校验规则（`validate_metadata`，`crates/pxlogic-graph/src/lib.rs:4722`）

这是**已经存在的标准**，全部是硬失败（`GraphError::InvalidMetadata`）：

```rust
const MAX_CHANNELS: u8 = 32;

// ① 通道数范围
if !(1..=MAX_CHANNELS).contains(&metadata.channel_count) { return Err(...); }

// ② unitsize 必须由 channel_count 推导，不能自定
let expected_unit_size = match metadata.channel_count {
    1..=8  => 1,      // 8 通道  → 每采样 1 字节
    9..=16 => 2,      // 16 通道 → 每采样 2 字节
    17..=32 => 4,     // 32 通道 → 每采样 4 字节
    _ => unreachable!(),
};
if metadata.unitsize != expected_unit_size { return Err(...); }

// ③ 采样率不能为 0
if metadata.sample_rate_hz == 0 { return Err(...); }

// ④ 触发通道必须在范围内且已启用
if trigger.channel >= metadata.channel_count
   || !enabled_channels.contains(&trigger.channel) { return Err(...); }
```

### 3.4 采样字节布局

- **每个采样占 `unitsize` 字节**
- **通道号 = bit 位置**：通道 `n` 对应单元内的第 `n` 位

  依据：`channel_mask(channel_count)` 在 `lib.rs:4749` 实现为 `(1u32 << channel_count) - 1`，
  即通道 `0..channel_count-1` 依次对应 bit `0..channel_count-1`。
- **小端序**：`crates/pxlogic-core/src/capture.rs:1386` 的 `read_sample_word` 用
  `u16::from_le_bytes` / `u32::from_le_bytes` 读取。

```rust
pub fn read_sample_word(samples: &[u8], unitsize: u8, sample_index: u64) -> Option<u32> {
    let stride = usize::from(unitsize);
    let offset = usize::try_from(sample_index).ok()?.checked_mul(stride)?;  // 防溢出
    let bytes = samples.get(offset..offset + stride)?;                      // 越界 → None
    let value = match unitsize {
        1 => u32::from(bytes[0]),
        2 => u32::from(u16::from_le_bytes(bytes.try_into().ok()?)),         // 小端
        4 => u32::from_le_bytes(bytes.try_into().ok()?),                    // 小端
        _ => return None,                                                   // 非法 unitsize → None
    };
    Some(value)
}
```

### 3.5 长度不一致会怎样（已核实，不是猜测）

`validate_metadata` **没有**校验 `samples.len() == sample_count × unitsize`。
但所有采样读取都经过 `read_sample_word`，它越界返回 `None`，
而调用处把它**显式映射成错误**（`crates/pxlogic-waveform/src/lib.rs:199`）：

```rust
let level_at = |sample| {
    read_sample_word(&capture.samples, metadata.unitsize, sample)
        .map(|word| word & mask != 0)
        .ok_or(WaveformError::InvalidCapture)     // ← 明确报错
};
```

**所以长度不一致会"响亮地失败"（`InvalidCapture`），不会 panic、也不会静默画出错误的波形。**

**建议（稳健性改进，非缺陷修复）**：把长度检查也放进 `validate_metadata`，
这样失败会归因到元数据本身、且在进入渲染前就被拦下，而不是等到读第 N 个采样才暴露。

**这三点（unitsize 表、bit 位置、小端序）+ §3.3 的四条校验，就是"新设备输出必须满足什么才能被解析"的完整答案。**

---

## 4. 立什么规矩

### 4.1 命名规矩（三类分清）

1. **本应用的名字** → 用统一的应用名
2. **某家硬件的属性**（VID/PID/型号/固件布局/协议行为）→ **用厂商名**（如 `WCH_VID`）
3. **参考实现的既有行为** → 保留其名或中性化（如 `rusb_backend.rs:226` 的 "PXView-provided CH569 firmware"）

### 4.2 接入规矩（本文档 §1–§3）

新设备接入必须满足：**一个 `DeviceProfile` + `ChannelMode` → 实现 `CaptureBackend` → 产出满足 §3.3 校验的 `CaptureData`。**

### 4.3 ★ 建议：把规矩变成可执行的测试

**只写文档不够** —— 文档会过期，而校验只在图渲染时才触发（失败时用户只看到"图不出来"）。

**建议新增一个可复用的符合性测试**，任何 `CaptureBackend` 实现都能跑：

```rust
/// 任何 backend 都应能通过：枚举 → 准备 → 采集 → 元数据满足全部硬约束。
fn assert_backend_conforms(backend: &dyn CaptureBackend) {
    let devices = backend.list_devices().expect("list_devices");
    for device in &devices {
        // DeviceInfo 的必要字段非空
        assert!(!device.id.is_empty());
        // ...
    }
    // 采集一次，逐条断言 §3.3 的四个约束 + samples.len() == sample_count * unitsize
}
```

`FakeBackend`（`crates/pxlogic-core/src/fake.rs:173`）已经是一个现成的第二个实现，**可以直接拿它当这个测试的第一个用户** —— 顺带证明这个契约确实可被第三方满足。

---

## 5. ★ 两个厂商概念泄漏（**已处理**）

这两处曾把单一厂商的概念放在通用类型的一级字段上。**现已改为厂商私有、可选的形式**：

### 5.1 `logic_mode` → `variant_code`

```rust
// 之前：厂商概念放在通用类型的一级字段上
pub struct DeviceProfile { pub logic_mode: u32, ... }
pub struct DeviceInfo   { pub logic_mode: Option<u32>, ... }

// 现在
pub struct DeviceProfile { pub variant_code: u32, ... }
pub struct DeviceInfo   { pub variant_code: Option<u32>, ... }
```

**核实过的性质**：`REG_LOGIC_MODE`（`protocol.rs:51`）**只被读、从不写**
（8 处全是 `read_register`），用途是**区分共用 VID/PID 的不同型号**。

**所以改名为 `variant_code`** —— "厂商自己的变体标识"是它真实的作用，这个名字对任何厂商都成立；
第二家若没有自己的变体方案，留 `None` 即可（字段本来就是 `Option`）。

### 5.2 `trigger_high_mask` / `trigger_low_mask` → `vendor_trigger`

```rust
// 之前：必填字段，语义被注释绑死到一家厂商
/// Additional level conditions, matching PXView's per-channel simple trigger masks.
pub trigger_high_mask: u32,
pub trigger_low_mask: u32,

// 现在
/// 厂商协议自己的电平条件。不支持该方案的 backend 留空即可。
pub vendor_trigger: Option<VendorTriggerSettings>,

pub struct VendorTriggerSettings {
    pub high_mask: u32,   // 每通道一位：该通道须为高
    pub low_mask: u32,    // 每通道一位：该通道须为低
}
```

**这一处比 5.1 更实质**：原来是**必填**字段，一个触发模型不同的厂商**无法表达自己的条件，
只能硬填一个无意义的 0**。现在整块可选，缺失即"不适用"。

**通用的部分保留在外层**：`trigger_kind` / `trigger_channel` / `trigger_enabled` /
`trigger_position_percent` 仍是与厂商无关的描述；只有**电平掩码这一对**是厂商私有的。

**这两处修完，JSON schema 才值得冻结** —— 否则它们会被写进格式，第三方按它配置后
再想删就要做版本迁移。

---

## 6. 一句话总结

- **配置项**：一个 `DeviceProfile`（VID/PID/USB 速度/深度/支持模式）+ 一到多个 `ChannelMode`（通道数/采样率范围/是否流式）
- **输出**：实现 `CaptureBackend` 的 3 个必需方法
- **格式**：`CaptureData { metadata, samples }`，其中 **`unitsize` 必须按通道数推导**（1-8→1、9-16→2、17-32→4 字节），**通道号 = bit 位置**，**小端序**，采样率非 0，触发通道需在范围内且已启用
- **是否已有标准**：**约束有（`validate_metadata`），文档没有** —— 本文档补上；但**建议进一步做成可执行测试**，否则它会随代码漂移
- **厂商概念泄漏**：已处理 —— `logic_mode` → `variant_code`，`trigger_high_mask`/`trigger_low_mask` → 可选的 `vendor_trigger`（见 §5）

---

# 附：型号参数表应该做成外部文件吗？

> 问题：是否需要维护一个 json/xml/yaml/toml 表来识别型号，再按型号加载硬件参数
> （数字通道数、模拟通道数、采样率、阈值…），用于界面显示与用户配置？

## 1. 先说现状：**这个表已经存在，但它是编译期常量**

| 表 | 定义 | 形式 |
| --- | --- | --- |
| 设备/型号 | `PXLOGIC_DEVICE_PROFILES: &[PxlogicDeviceProfile]`（`pxview_profile.rs:309`） | **`pub const`** |
| 通道模式 | `PXLOGIC_CHANNEL_MODES: &[PxlogicChannelMode]`（`:90`） | **`pub const`** |
| 阈值 | `PXLOGIC_THRESHOLD_VOLTAGES: &[f64] = &[1.8, 2.5, 3.3, 5.0]`（`:88`） | **`pub const`** |

**没有任何运行时加载。** 注意这些名字看着像环境变量，其实是常量 —— 我核对过真正通过
`env::var` 读取的只有 14 个，全部是**路径与后端配置**（`PXLOGIC_SALEAE_SIDECAR`、
`PXLOGIC_BITSTREAM_DIR`、`PXLOGIC_MCU_FIRMWARE` …），**没有一个是型号表**。

## 2. 更好的消息：**"界面需要什么"的聚合结构也已经有了**

`crates/pxlogic-core/src/models.rs:43`：

```rust
pub struct HardwareCaptureCapabilities {
    pub device_id: String,
    pub profile_vendor: Option<String>,
    pub profile_model: Option<String>,
    pub usb_speed: Option<String>,
    pub logic_mode: Option<u32>,
    pub max_channels: u8,                    // ← 数字通道数
    pub default_channel_count: u8,
    pub default_sample_rate_hz: u64,
    pub sample_rates: Vec<u64>,              // ← 支持的采样率
    pub threshold_volts: Vec<f64>,           // ← 支持的阈值
    pub channel_modes: Vec<HardwareChannelModeInfo>,
}
```

**而且已经有"未知设备"的兜底**：`generic_logic_capture_capabilities()`（`pxview_profile.rs:459`），
给一个没有 profile 的设备生成一套通用能力。

**所以"按识别到的型号加载参数、驱动界面显示与配置"这条链路已经通了** ——
`DeviceProfile` → `HardwareCaptureCapabilities` → 前端。**缺的不是这条链路。**

## 3. 相对你的需求，有两个真实缺口

### 缺口一：**模拟通道数在核心模型里根本不存在**

- `crates/pxlogic-core/src/models.rs` 与 `pxview_profile.rs` 里**零个** analog 概念
- `HardwareCaptureCapabilities` **没有模拟通道字段**
- 但**前端有**：`src/lib/analogChannels.ts`（`enabledAnalogChannels` / `makeDefaultAnalogChannels` / `UiAnalogChannelSettings`）

**即模拟通道只活在 UI 层，设备模型不知道它的存在。**
这意味着"这个型号有几个模拟通道"**无法从设备能力推导**，只能前端自己假定。
**这是接第二家硬件时会立刻撞上的第一个洞。**

### 缺口二：阈值是**全局一份**，不是每型号

```rust
threshold_volts: PXLOGIC_THRESHOLD_VOLTAGES.to_vec(),   // pxview_profile.rs:454
```

它被复制进了每个设备的 capabilities，但**来源是同一个全局常量** ——
所以所有型号共享 `[1.8, 2.5, 3.3, 5.0]`。**不同硬件支持的阈值档位不同，这个结构表达不了。**

## 4. ★ 建议：**不要现在就做外部文件表** —— 顺序错了会付出更大代价

### 为什么顺序重要

现在把表外部化成文件，等于**把 `logic_mode` 与 `trigger_high_mask` 这两个厂商概念冻结进一个公开 schema**。
**文件格式是兼容性契约** —— 一旦第三方按它写配置文件，之后再想删掉这两个字段，就得做格式版本迁移。
**先修抽象，再外部化。**

### 推荐顺序

**第 1 步：修两处厂商概念泄漏**（见上文 §5：`logic_mode`、`trigger_high_mask`）
**第 2 步：把模拟通道加进设备模型**（缺口一），并把阈值改成每型号可不同（缺口二）
**第 3 步：此时 schema 才值得冻结** —— 定义格式、写校验、外部化
**第 4 步：内置默认表 + 文件可扩展/覆盖** —— 保持"开箱即用"，
与现有 `generic_logic_capture_capabilities()` 的兜底哲学一致

### 格式选择：**JSON**

| 格式 | 判断 |
| --- | --- |
| **JSON** | **推荐** —— Rust 侧已有 serde；sidecar 已用 JSON 做 IPC；前端可直接消费 |
| TOML | 手写更友好，但多一个依赖，且嵌套结构（模式列表）表达不如 JSON 自然 |
| YAML | 缩进陷阱多，收益不明显 |
| XML | 无理由 |

### ★ 一个必须说清的边界

**配置文件本身不能"支持一个新硬件"。** 它只覆盖三件事：
**识别型号 → 描述能力 → 驱动界面显示与配置**。

**真正的采集仍然需要写一个 `CaptureBackend` 实现**（USB 协议、固件烧写、时序）。
**不要让文件格式造成"加设备只需改配置"的错觉** —— 那会把最贵的那部分工作藏起来。

### 一个机械但面广的改动要提前知道

现在的 profile 用 `&'static str`（`vendor` / `model` / `description`），所以能放进 `const`。
改成从文件加载就要变成**拥有所有权的数据**（`String`），
`PXLOGIC_DEVICE_PROFILES` 也得从 `&'static [T]` 变成运行时持有的表。
**这不是难点，但会波及所有引用点** —— 值得单独一个提交。
