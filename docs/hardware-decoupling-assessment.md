# 去硬件耦合评估：是否需要大规模重命名

> 目标：一个**兼容不同逻辑分析仪硬件**的客户端，界面统一为 Saleae 风格。
> 现状：功能基本完成，但命名与部分结构偏向单一硬件（PXLogic）。
> 问题：**是否有必要做大规模重命名？**

---

## 结论先说

**不需要"大规模重命名"，也不需要对架构做重构。** 需要的是**一次有边界的命名清理**，而且**它和"支持多硬件"这个目标基本是两件事**。

三个理由，都有代码证据：

**① 硬件抽象层已经存在，而且已经被两个实现验证过**

`crates/pxlogic-core/src/transport.rs:12`：

```rust
pub trait CaptureBackend: Send + Sync {
    fn list_devices(&self) -> Result<Vec<DeviceInfo>>;
    fn prepare_device(&self, device_id: &str, bitstreams: Option<&Bitstreams>) -> Result<()>;
    fn capture(...);
    fn capture_streaming(...);
    fn stop_capture(&self, _device_id: &str) -> Result<()> { ... }
}
```

实现有两个：
- `crates/pxlogic-core/src/rusb_backend.rs:1696` — `impl CaptureBackend for RusbBackend`
- `crates/pxlogic-core/src/fake.rs:173` — `impl CaptureBackend for FakeBackend`

**"有 trait + 有第二个实现"是抽象真实可用的最强证据** —— 不是画了个接口却只服务一条路径。

**② 设备描述表本身就是通用形状**

`crates/pxlogic-core/src/pxview_profile.rs:48`：

```rust
pub struct PxlogicDeviceProfile {
    pub vid: u16,                 // USB Vendor ID
    pub pid: u16,                 // USB Product ID
    pub usb_speed: PxUsbSpeed,
    pub logic_mode: u32,
    pub vendor: &'static str,     // 已经是通用字段
    pub model: &'static str,      // 已经是通用字段
    pub hardware_depth_bits: u64,
    pub supported_modes: &'static [PxlogicChannelModeId],
    pub default_mode: PxlogicChannelModeId,
}
```

**VID/PID → 能力表**，字段名（`vendor` / `model` / `supported_modes`）已经与厂商无关。**问题只在类型名，不在结构。**

**③ 前端已经是中立的**

- `src/` 全目录只有 **12 处** `pxlogic`，且多为 demo 设备 id 与 localStorage 键
- CSS 类名已经是**领域命名 + Saleae 命名**：`.channelContextMenu`、`.channelCounter`、`.saleaeBottomBar`、`.saleaeGraphChannelIndex`
- 没有 `.pxlogicXxx` 这样的厂商类名

---

## 真正需要改的：范围与优先级

**源码真实足迹约 700 行**（`crates` 454 + `src-tauri` 71 + `native` 134 + `src` 24 + `scripts` 8）。

> 注：`grep pxlogic native/` 会看到 2.4 万行，但其中 **99% 在 `native/sigrok-analyzer-sidecar/target/`** —— CMake 产物里的绝对路径，是噪声。统计时必须 `--exclude-dir=target`。

### A. 产品身份（用户可见，收益最高，风险最低）

| 位置 | 现状 |
| --- | --- |
| `src-tauri/tauri.conf.json` `productName` | `PXLogic Studio` |
| 同上 `identifier` | `dev.pxlogic.studio` |
| 同上 窗口标题 | `PXLogic Studio` |

**⚠️ `identifier` 是唯一有"不可逆"性质的一项**：改它等于给操作系统换了一个新应用，**用户的设置、窗口状态、路径都会丢失**。要么不改，要么在改的同时做一次配置迁移。

### B. crate 名（机械、编译器全程兜底）

```
pxlogic-core / pxlogic-file / pxlogic-graph / pxlogic-waveform
```

影响面：`Cargo.toml` ×5、`Cargo.lock`、所有 `use pxlogic_*`、`src-tauri/Cargo.toml`。
**语义风险低**（编译器会报错），但**改动面广**，适合单独一个提交。

### C. 类型名（约 130 处集中在两个名字上）

| 现状 | 建议 |
| --- | --- |
| `PxlogicDeviceProfile` | `DeviceProfile` |
| `PxlogicChannelModeId`（**109 处**） | `ChannelModeId` |
| `PxlogicChannelMode`（23 处） | `ChannelMode` |
| `PxlogicCapturePlan` | `CapturePlan` |

**这一类是"去厂商化"性价比最高的**：名字变通用，结构一行不动。

### D. 常量（**这些确实与厂商相关，应改成厂商名而非应用名**）

```rust
PXLOGIC_WCH_VID / PXLOGIC_WCH_PID          // WCH 沁恒的 VID/PID
PXLOGIC_LEGACY_VID / PXLOGIC_LEGACY_PID    // 旧版 VID/PID
PXLOGIC_32_CHANNEL_HARDWARE_DEPTH_BITS
PXLOGIC_16_PRO_HARDWARE_DEPTH_BITS
```

**注意方向**：这些值描述的是**某家硬件的属性**，所以正确的改名是 `WCH_VID` / `WCH_LEGACY_PID`，**而不是**把 `PXLOGIC` 换成另一个应用名。**换成厂商名才真正解耦** —— 否则换个应用名，耦合照旧。

### E. 字符串契约（**风险最高，编译器不兜底**）

**38 个 `PXLOGIC_*` 环境变量**，跨 Rust ⇄ shell ⇄ Tauri 配置三处。例如：

```
PXLOGIC_SALEAE_SIDECAR / PXLOGIC_SALEAE_RUNTIME_ROOT / PXLOGIC_SIGROK_SIDECAR
PXLOGIC_DEVICE_PROFILES / PXLOGIC_CHANNEL_MODES / PXLOGIC_THRESHOLD_VOLTAGES
PXLOGIC_BITSTREAM_DIR / PXLOGIC_MCU_FIRMWARE / PXLOGIC_FPGA_MAIN
```

**二进制/资源名**：

```
pxlogic-sigrok-sidecar (23) / pxlogic-saleae-analyzer-sidecar (13)
pxlogic-saleae-graph-sidecar (5) / pxlogic-perf-self-test (4) / pxlogic-demo (5)
```

**这一类改错的后果是运行时静默失效** —— 环境变量对不上就退回默认值，不报错。

---

## 必须**保留**的 PXLogic / PXView 引用

这是本次评估里最需要小心的一点：**有些 `PXView` 不是在叫我们的应用，而是在陈述硬件协议的事实。**

`crates/pxlogic-core/src/rusb_backend.rs`：

```
:226  /// Loads the PXView-provided CH569 application firmware. ...
:278  // Exact PXView layout: a 48 KiB FF-padded image at offset 48 KiB,
```

`crates/pxlogic-core/src/pxview_profile.rs:86`：

```
/// PXView exposes these standard logic-level thresholds while retaining its ...
```

`crates/pxlogic-graph/src/lib.rs:703`：

```
// PXView switches from individual transition lines to pixel-level ...
```

**这些是"参考实现/固件协议就是这样"的陈述。改掉它们会让代码说谎。** 正确做法是**保留，或统一改写为"参考实现"这类中性措辞**，而不是删掉厂商名。

同样必须保留的：

| 内容 | 为什么保留 |
| --- | --- |
| `vendor: "PX_Tool"` / `model: "PX-Logic U3 channel 32"` | **真实设备字符串**，要用于匹配 |
| `docs/ported-features/pxview-*.md` | 历史记录 |
| `pxview-fork/` | 上游 fork（GPLv3），不是我们的代码 |
| `vendor/pxview-sigrokdecode/` | 第三方 |

**谱系**（有助于理解为什么两个前缀并存）：
`sigrok` → `DSView` → **`PXView`**（PXLogic 硬件的 Qt GUI）→ **本项目**（Tauri/Rust，自 pxview 移植）。
**`pxlogic` 同时是"本项目"和"一条硬件产品线"的名字** —— 这正是混淆的来源。

---

## 风险影响

### 对现有功能

| 改动 | 风险 | 是否编译器兜底 |
| --- | --- | --- |
| crate 改名 | 低（机械） | ✅ |
| 类型改名 | 低 | ✅ |
| 常量改名 | 低（**值不能动**） | ✅ |
| **环境变量改名** | **高（静默失效）** | ❌ |
| **sidecar 二进制改名** | **高**（Rust 找它、Tauri 打包它、脚本产出它，三处必须同时改） | ❌ |
| **`identifier` 改名** | **高且不可逆**（用户配置丢失） | ❌ |

**净结论**：真正危险的不是"改了多少"，而是**少数几处不报错的字符串契约**。700 行里绝大多数是安全的重命名。

### 对架构

**没有影响 —— 因为架构不需要改。** 支持第二个厂商的路径已经存在：

1. 在 `pxview_profile.rs` 的 profile 表里加该厂商的 VID/PID 与能力
2. 写一个新的 `impl CaptureBackend`（如果其 USB 协议不同）
3. 前端不需要动（它只消费 `DeviceInfo` / `DeviceProfile` 的通用字段）

**唯一真正需要留意的架构点**：`rusb_backend.rs`（2069 行）里包含 **CH569 固件烧写与精确内存布局**（见上面的 `PXView layout` 注释）。**这部分天然属于"某个厂商的协议"，不应该被强行通用化** —— 它应该作为一个 backend 实现留在那里，而不是抽象掉。

---

## 推荐实施步骤

按"收益/风险"排序，**每一步都可独立提交、独立回滚**。

### 第 0 步：先立规矩，不动代码

在 `CONTRIBUTING` 或 `docs/` 里写清一条判断准则，避免以后再混：

> **命名区分三类：**
> 1. **本应用的名字** → 用统一的应用名（如 `<AppName>`）
> 2. **某家硬件的属性**（VID/PID/型号/固件布局/协议行为）→ **用厂商名**，如 `WCH_VID`、`PX_Tool`
> 3. **参考实现的既有行为** → 保留其名，或写成中性的"参考实现"

**这一条比任何改名都重要** —— 否则改完还会长回来。

### 第 1 步：类型与常量（纯代码，编译器兜底）

- `PxlogicDeviceProfile` → `DeviceProfile`
- `PxlogicChannelModeId` → `ChannelModeId`，`PxlogicChannelMode` → `ChannelMode`
- `PxlogicCapturePlan` → `CapturePlan`
- `PXLOGIC_WCH_VID` → `WCH_VID` 等（**保留值**）

**验收**：`cargo test --workspace` 全绿。这一步不涉及任何字符串契约。

### 第 2 步：crate 名

`pxlogic-core/file/graph/waveform` → 目标名。单独一个提交。
**验收**：`cargo build --workspace` + `cargo test --workspace` + `npm run build`。

### 第 3 步：字符串契约（**风险集中在这里，必须一起改、一起验**）

- 38 个环境变量
- sidecar 二进制名
- `scripts/prepare-tauri-resources.sh` 里的资源路径
- `src-tauri/tauri.conf.json` 的 `resources`
- 前端里那 12 处

**做法**：先用 `grep -rn "PXLOGIC_"` 和 `grep -rn "pxlogic-"` 生成一份**完整清单**，逐项打勾，**不要靠印象**。
**验收**：**必须实际跑一次完整构建 + 启动应用 + 触发一次解码**（因为这一类失败不报错）。

### 第 4 步：产品身份（**最后做，且单独决策**）

`productName` / 窗口标题可以改。**`identifier` 建议不改**；若必须改，需要同时做用户配置迁移。

### 第 5 步（可选，独立于改名）：让第二个厂商真的能接进来

**这才是验证"解耦是否成功"的唯一硬标准。**
建议以**最小可用**为目标：加一个 `FakeBackend` 之外的第二真实 backend（哪怕只是回放一份录制的 USB 数据），
走通 `list_devices → prepare_device → capture → 前端渲染`。

**只改名不接第二个 backend，无法证明解耦真的成立。**

---

## 一句话总结

**该做的是"命名清理 + 一条命名规矩"，不是"大规模重构"。**
架构已经具备多硬件能力（`CaptureBackend` trait 有两个实现、profile 表是通用的），
**约 700 行源码重命名**里绝大多数是编译器兜底的安全改动；
**真正的风险集中在 38 个环境变量与 sidecar 二进制名这类不报错的字符串契约上**，
以及 **`identifier` 这个改了会丢用户配置的不可逆项**。

**顺序上，先立规矩、再改类型常量、最后碰字符串契约；产品名与 identifier 单独决策。**
