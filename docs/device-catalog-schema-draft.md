# 设备目录 JSON —— schema 草案（v1，待确认）

> **这是草案，不是最终格式。** 文件格式一旦公开就是兼容性契约，所以先请你过目字段设计。
> 下方示例用的是**仓库里真实的 PX 数据**，不是编的。

---

## 1. 设计目标与边界

**要解决的**：
- 用户能从仓库或界面看到「本版本支持哪些型号」，不必读代码
- **同一驱动家族内新增变体型号**不必重编（这是 JSON 相对"从代码生成"的唯一真实收益）

**不解决的**（**必须写进文件里，避免误导**）：
- **新增一个需要不同驱动的厂商，仍然要写 `CaptureBackend` 实现。** 文件只描述"有哪些设备、它们的能力是什么"，不描述"怎么跟它说话"。

**所以每个设备都带一个 `backend` 字段** —— 它让文件自己说明"我描述的是某个 backend 下的设备"，
而不是让人以为"加设备只需改配置"。

---

## 2. 结构总览

```jsonc
{
  "format": "pxlogic.device-catalog",
  "version": 1,

  // 全局默认，可被单个设备覆盖
  "defaults": { "threshold_volts": [1.8, 2.5, 3.3, 5.0] },

  // 通道模式表 —— 多设备共享，按 id 引用（与代码里的 PXLOGIC_CHANNEL_MODES 一致）
  "channel_modes": [ /* ... */ ],

  // 设备表
  "devices": [ /* ... */ ]
}
```

**为什么模式表是共享的而不是内联**：现在 10 个型号大量复用同一批模式（`MODES_32_SUPER` 等）。
内联会让同一个模式在文件里重复十几次，改一处要改十几处。共享表还让"哪些设备共用哪些模式"一眼可见。

---

## 3. 字段定义

### 3.1 `channel_modes[]`（模式）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 引用键。**保持现有命名**（`BUFFER_LOGIC250x32`），因为它已出现在现有代码与日志里 |
| `kind` | `"buffer"` \| `"stream"` | ✅ | 现为 `stream: bool`。改成枚举，因为"是否流式"不是布尔属性的语义 |
| `channels` | integer | ✅ | 该模式的数字通道数 |
| `default_sample_rate_hz` | integer | ✅ | |
| `default_sample_limit` | integer | ✅ | |
| `min_sample_rate_hz` | integer | ✅ | |
| `max_sample_rate_hz` | integer | ✅ | |
| `description` | string | ✅ | 界面显示用 |

### 3.2 `devices[]`（设备）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `backend` | string | ✅ | **哪个 `CaptureBackend` 驱动它**（如 `"rusb"`）。见 §1 的边界说明 |
| `vendor` | string | ✅ | 显示名，也用于分组 |
| `model` | string | ✅ | 显示名 |
| `match` | object | ✅ | **识别键**，见下 |
| `hardware_depth_bits` | integer | ✅ | 硬件采样深度 |
| `analog_channels` | integer | ❌ | 默认 `0`。**上一轮刚加进模型** |
| `modes` | string[] | ✅ | 引用 `channel_modes[].id` |
| `default_mode` | string | ✅ | 必须是 `modes` 之一 |
| `threshold_volts` | number[] | ❌ | **覆盖全局默认**（不同硬件档位不同 —— 这正是缺口二） |

### 3.3 `match`（识别键）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `vid` | integer | ✅ | USB Vendor ID |
| `pid` | integer | ✅ | USB Product ID |
| `usb_speed` | `"high"` \| `"super"` | ✅ | 同一 VID/PID 的 U2/U3 版本靠它区分 |
| `variant_code` | integer | ❌ | **硬件上报的"逻辑模式"寄存器值**，见下 |

#### ★ `variant_code` 到底是什么（用真实数据说明）

**它不是版本后缀**（不是 "USB 3.2" 里那个 `.2`），**也不是协议版本**。
它是**从设备寄存器 `REG_LOGIC_MODE` 读回的一个小整数**，用来区分**共用 VID/PID/USB 速度的不同型号**。

仓库里 10 个型号的完整识别键：

| vid | pid | usb_speed | variant_code | model |
| --- | --- | --- | --- | --- |
| `0x1A86` | `0x5237` | super | `0` | PX-Logic U3 channel **32** |
| `0x1A86` | `0x5237` | high | `0` | PX-Logic U2 channel **32** |
| `0x16C0` | `0x05DC` | super | `0` | PX-Logic U3 channel **32** |
| `0x16C0` | `0x05DC` | high | `0` | PX-Logic U2 channel **32** |
| `0x16C0` | `0x05DC` | super | `1` | PX-Logic U3 channel **16 Pro** |
| `0x16C0` | `0x05DC` | high | `1` | PX-Logic U2 channel **16 Pro** |
| `0x16C0` | `0x05DC` | super | `2` | PX-Logic U3 channel **16 Plus** |
| `0x16C0` | `0x05DC` | high | `2` | PX-Logic U2 channel **16 Plus** |
| `0x16C0` | `0x05DC` | super | `3` | PX-Logic U3 channel **16 Base** |
| `0x16C0` | `0x05DC` | high | `3` | PX-Logic U2 channel **16 Base** |

**看最后 8 行**：`0x16C0:0x05DC` 这一个 VID/PID 下有 **4 个不同型号**，
`usb_speed` 只分出 U2/U3，**剩下的靠 `variant_code` 区分**（0=32 通道、1=16 Pro、2=16 Plus、3=16 Base）。

**为什么硬件叫它 "logic mode" 而不是 "model id"**：同一块板子可以加载不同的 FPGA 逻辑配置，
"逻辑模式"就是**当前生效的那套配置**。因为不同型号就是同一板子的不同配置，
所以这个模式值**实际上等价于型号标识**。**代码里它只被读、从不写**（8 处全是 `read_register`），
所以对我们来说它是**只读的身份描述**，不是可切换的状态。

**对第二家厂商**：他们没有这个寄存器，**整个字段省略即可** —— 这就是把它做成可选的原因。

**★ 命名取舍**：硬件叫它 `logic_mode`，但我们改名成 `variant_code`。
理由是 `logic_mode` 会把这个厂商的概念留在通用类型上，而 `variant_code` 描述的是它**对我们起的作用**（区分变体），任何厂商都能理解这个名字。
**代价**：名字没保留"它是硬件逻辑模式"这层信息 —— 所以这段说明必须留在文档里。

---

## 4. 真实数据示例（节选）

```jsonc
{
  "format": "pxlogic.device-catalog",
  "version": 1,

  "defaults": { "threshold_volts": [1.8, 2.5, 3.3, 5.0] },

  "channel_modes": [
    {
      "id": "BUFFER_LOGIC250x32",
      "kind": "buffer",
      "channels": 32,
      "default_sample_rate_hz": 250000000,
      "default_sample_limit": 250000000,
      "min_sample_rate_hz": 2000,
      "max_sample_rate_hz": 250000000,
      "description": "…"
    },
    {
      "id": "STREAM_LOGIC50x32",
      "kind": "stream",
      "channels": 32,
      "default_sample_rate_hz": 50000000,
      "default_sample_limit": 0,
      "min_sample_rate_hz": 2000,
      "max_sample_rate_hz": 50000000,
      "description": "…"
    }
    // …其余 13 个模式
  ],

  "devices": [
    {
      "backend": "rusb",
      "vendor": "PX_Tool",
      "model": "PX-Logic U3 channel 32",
      "match": { "vid": 6790, "pid": 21047, "usb_speed": "super", "variant_code": 0 },
      "hardware_depth_bits": 4000000000,
      "analog_channels": 0,
      "modes": ["BUFFER_LOGIC250x32", "STREAM_LOGIC50x32", "…"],
      "default_mode": "BUFFER_LOGIC250x32"
    },
    {
      "backend": "rusb",
      "vendor": "PX_Tool",
      "model": "PX-Logic U2 channel 16 Base",
      "match": { "vid": 5824, "pid": 1500, "usb_speed": "high" },
      "hardware_depth_bits": 1000000000,
      "modes": ["BUFFER_LOGIC250x16", "STREAM_LOGIC125x16", "…"],
      "default_mode": "BUFFER_LOGIC250x16"
    }
    // …其余 8 个设备
  ]
}
```

> `6790 = 0x1A86`，`21047 = 0x5237`，`5824 = 0x16C0`，`1500 = 0x05DC`。
> **JSON 里写十进制还是十六进制？** 见 §5 开放问题 1。
>
> 第二个设备**故意省略了 `variant_code`** —— 演示"第二家/无变体标识的设备怎么表达"。

---

## 5. 已确认的决定（2026-09-29）

| # | 决定 |
| --- | --- |
| 1 | **VID/PID 用字符串十六进制**（`"0x1A86"`）—— 最符合直觉，人会反复对照 USB 描述符 |
| 2 | **`variant_code` 读不到时**：沿用现有的"精确匹配失败即回退"，但**回退时必须标记"型号未识别"**并在界面提示（见 §5.2 的瑕疵） |
| 3 | **内置默认目录 + 外部文件可扩展/覆盖** —— 文件丢了应用仍可用，与现有 `generic_logic_capture_capabilities()` 兜底哲学一致 |
| 4 | 文件位置：**`resources/device-catalog.json`**（运行时资源，不是文档） |
| 5 | **`version` 只允许加可选字段**；破坏性变更必须升 `version`，加载时遇到更高版本则拒绝并回退到内置目录 |
| 6 | **`usb_speed` 保留为识别键**（U2/U3 两个条目）—— 深度确实不同，强行合并更难读 |

### 5.2 那个回退瑕疵（决定 2 的落地细节）

现有 `pxview_profile.rs:626-645` 的回退是 `.find(...)`，即**表里顺序最靠前**的那个。
对 `0x16C0:0x05DC:high`（4 个型号共用 VID/PID/速度）会命中 `variant_code = 0` = **channel 32**，
若实际是 16 Base 就**按 32 通道的能力去用（高估）**。

**决定**：保留回退（不让设备消失），但**把结果标成"未识别"**，走 `DeviceInfo.probe_error` 那条既有通道提示用户。
理由：把不确定性告诉用户，比悄悄用一个可能错的能力档更诚实。

---

## 5.5 ★ 实现方式：**用 `Box::leak` 避免 `&'static` → owned 的大改动**

原计划担心"`&'static str` 要变 `String`、波及所有引用点"。**核实后有个更省事的做法：**

**先量了改动面**：`PxlogicDeviceProfile` / `PXLOGIC_DEVICE_PROFILES` 在 `pxview_profile.rs` 之外
**只有 2 个文件**引用（`lib.rs` 的 re-export、`rusb_backend.rs`），`&'static` 签名**只有 3 处**。

**做法**：**不改类型，改成"加载一次并泄漏为 `'static`"**：

1. `PxlogicDeviceProfile` **保持 `&'static str` 不变** —— 零类型改动
2. 加载器把 JSON 反序列化成中间结构，构造出 `PxlogicDeviceProfile`，然后 **`Box::leak`** 成 `&'static`
3. 用 `OnceLock<Vec<&'static PxlogicDeviceProfile>>` 做注册表：**内置 const 表 + 加载到的外部设备**
4. 查找改为查注册表

**为什么 `Box::leak` 在这里是诚实的**：设备目录在进程启动时加载一次、活到进程结束 ——
`Box::leak` 正是"程序生命周期分配"的准确表达，不是泄漏。目录很小（10 个设备 + 15 个模式），一次性、有界。

**收益**：`rusb_backend.rs` 的 `Option<&'static PxlogicDeviceProfile>`、`PxlogicCapturePlan.profile: &'static ...`
**全都不用改**，也就没有生命周期传染。**风险从"面广"降到"局部"。**

---

## 6. 迁移与落地顺序（确认后执行）

1. **定稿 schema**（本文档 → 正式格式说明）
2. **写 Rust 加载器**：`serde` 反序列化 → 转成现有的 `PxlogicDeviceProfile` 结构
   - 注意：`&'static str` 要变 `String`，`PXLOGIC_DEVICE_PROFILES` 从 `const` 变运行时表
3. **生成内置默认目录**：从现有 `const` 表导出 JSON，作为仓库里的 `resources/device-catalog.json`
4. **加校验测试**：加载失败/字段非法/`default_mode` 不在 `modes` 里 → 报错
5. **改 `supported_devices` 测试**：改为「JSON → markdown 是否最新」
6. **（可选）后端命令** `supported_devices`，让界面能直接列出全部支持型号

**第 2 步是唯一有面广风险的**（`&'static` → owned），值得单独一个提交。

---

## 7. 一句话总结

草案的核心判断是：**给每个设备加 `backend` 字段，让文件自己声明它的边界** ——
它描述"某个 backend 下有哪些设备"，而不是"加设备只需改配置"。
其余字段基本是现有 `DeviceProfile` + `ChannelMode` 的忠实映射，加上刚修好的两个厂商概念（`variant_code` 可选、`vendor_trigger` 不在设备表里）。
