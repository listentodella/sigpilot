# 改名方案：PXLogic Studio → SigPilot

本文档是改名的执行清单。目标：把**产品名**从 `PXLogic Studio` 改为 `SigPilot`，
同时**不破坏**已有采集文件、sidecar 线协议与硬件驱动。

- 决策依据见 `docs/sigrok-device-layer-reference.md` 与对话记录（共 12 轮候选评估）
- 候选名可用性已实测：`sigpilot` 在 crates.io / npm / GitHub 用户名三处全清
- 影响面实测：**160 个文件含 `pxlogic`，其中 77 个是生产代码**

---

## 0. 决定与已知代价

**新名：`SigPilot`**（驼峰统一写法）

选它的理由：

1. **`Pilot` 是真实 EE 术语** —— 导频信号（Pilot Signal）/ 导频音（Pilot Tone）是通信系统中嵌入的
   **已知参考信号**，用于**同步与监测**。这与上位机的职责一致（对齐并监测数字信号），
   而且中文里就叫"导频"。这不是比喻，它本身就是信号术语。
2. 拼写干净：`SIGP` 不成词，不会被误切（对比 `LABuddy` 会被读成 "Lab Buddy"）。
3. 三处注册表全清。
4. AI 联想弱于 `Buddy`（`Buddy` 已被 CodeBuddy / WorkBuddy 等 AI 工具在中文开发工具圈占用）。

**已知代价（必须接受并主动管理）：**

| 代价 | 缓解 |
| --- | --- |
| `SignalPilot`（signalpilot.ai）是活跃的 AI 数据平台产品，与本名**只差一个音节** | 全库统一驼峰 `SigPilot`；README 首行声明"与 SignalPilot 无关" |
| `PILOT` 在测试测量领域已被 **Seica PILOT Series**（电子板飞针测试系统）使用 | README 声明中一并提及 |
| 常见域名 `sigpilot.com` / `.dev` 均已注册 | 用 GitHub Pages 或 `sigpilot-app.com`（实测未注册） |

---

## 0.5 执行状态与决策记录

### 用户决策（已确认）

| # | 判断项 | 决定 |
| --- | --- | --- |
| 1 | Tauri `identifier` | **改** → `dev.sigpilot.app`（接受"等于换一个新应用"） |
| 2 | `PXView` 的归属 | **归入 pxlogic 驱动命名空间**。PXView 是 PXLogic 硬件的官方上位机，因此 `App.tsx` 的 "PXView Profile" / "PXView Channel Mode" 标签**保留**，不作为产品名改名对象 |
| 3 | 解码器侧的 `PXView` 名称 | **废弃**。解码器只有两个生态（Saleae / sigrok），`analyzers.ts` 的 `"Sigrok Native (PXView)"` 已改为 `"Sigrok Native"`。**当前优先保证 Saleae 链路** |

### 执行进度

| 步骤 | 状态 |
| --- | --- |
| 1. crate 目录与 Cargo 配置改名 | ✅ 完成（`git mv` 保留历史） |
| 2. Rust 模块引用替换 | ✅ 完成 |
| 3. 环境变量改名 + 向后兼容层 | ✅ 完成（实测 30 个，非 19 个；含 C/C++ 三侧同步） |
| 4. Tauri 配置与 sidecar 名 | ✅ 完成 |
| 5. 前端品牌字符串与持久化键 | ✅ 完成（4 个键均带迁移） |
| 6. `package.json` | ✅ 完成 |
| 7. 当前状态类文档 | ✅ 完成（README / CROSS_PLATFORM / FILE_MAP / performance-self-test） |
| 8. `Cargo.lock` | ✅ 已自动重生成 |

### 验证结果

| 检查 | 结果 |
| --- | --- |
| `cargo check --workspace` | ✅ 通过（5 个 crate） |
| `cargo test --workspace` | ✅ **207 passed / 0 failed**（另有预期的 ignored：需真实硬件或 sidecar） |
| 前端语法校验（`node --experimental-strip-types --check`） | ✅ 5 个改动文件全部通过 |
| 前端 `tsc` 类型检查 / `pnpm build` | ⚠️ **未执行** —— 环境拒绝 `pnpm install` 的符号链接（`ERR_PNPM_CODEBUDDY_BROKER_DENY`），`node_modules` 无法安装。**需在有网络的机器上补跑** |
| `pnpm perf:self-test` | ⚠️ 未执行（同上） |
| 真实硬件链路 | ⚠️ 未执行（需硬件） |

### 执行中发现、初版方案未覆盖的三件事

1. **环境变量实际是 30 个**，不是 19 个 —— 遗漏项在 `native/*/build.sh`、`verify.sh`、`scripts/`、`tools/logic2-bridge/`。
2. **`native/` 下的 C/C++ 不在初版替换范围** —— 初版只匹配 `.rs/.ts/.sh/...`，漏了 `.cpp/.c/.h`。
   这导致 Rust 已用 `SIGPILOT_*` 而 C++ 仍读 `PXLOGIC_*`，**worker 数覆盖与 timing 开关会静默失效**。已修复并验证三侧同名。
3. **格式标识符比初版清单多** —— 新增 `pxlogic.saleae-export.v1`、`pxlogic.saleae-transition.v1`、
   5 个 `testdata/decoders/*.json` 夹具标识符、`pxlogic.performance.decoder-self-test`。
   全部按"格式标识符冻结"原则保留，见 §3。

---

## 1. 三个命名空间（核心原则）

**这不是一次改名，而是三个命名空间，只有一个该改。**

| 命名空间 | 处置 | 内容 |
| --- | --- | --- |
| **产品名** | **要改** | 窗口标题、logo 文案、crate 前缀、安装包 `productName`、环境变量、前端持久化键 |
| **格式与协议名** | **冻结** | `.pxcap`、`.pxl`、`PXLF1`、`pxlogic.project.v1`、`pxlogic.decoder.*` |
| **驱动名** | **保留** | `pxlogic` 作为 `DeviceDriver` 的 `driver_id`；`protocol.rs` 的硬件常量 |

### 1.1 ⚠️ 最容易出错的地方：`pxlogic.` 前缀有两类，处置相反

代码里存在两种看起来一样、实际归属完全相反的 `pxlogic.` 字符串：

| 字符串 | 位置 | 性质 | 处置 |
| --- | --- | --- | --- |
| `pxlogic.preferences.v1` | `src/lib/preferences.ts:12` | 前端 localStorage | **可改**（加迁移读取） |
| `pxlogic.extensions.v1` | `src/lib/extensions.ts:46` | 前端 localStorage | **可改** |
| `pxlogic.screenshot-settings.v1` | `src/lib/screenshots.ts:32` | 前端 localStorage | **可改** |
| `pxlogic:decoder-timing` | `src/lib/analyzerPerformance.ts:10` | 前端 localStorage | **可改** |
| `pxlogic.project.v1` | `crates/pxlogic-file/src/lib.rs:913,949,979` | **文件格式标识** | **冻结** |
| `pxlogic.decoder.*`（9 个） | 见 §3.4 | **sidecar 线协议标识** | **冻结** |

**`pxlogic.decoder.*` 由 C++/C sidecar 产出、Rust 宿主校验。**
只改一侧（或只改 Rust 不改 C++）会直接让解码失效。见 §3.4。

### 1.2 ⚠️ 第二个陷阱：`PXLOGIC_` 前缀也有两类

| 类别 | 例 | 处置 |
| --- | --- | --- |
| **产品级配置**（环境变量，19 个） | `SIGPILOT_BITSTREAM_DIR` | **改为 `SIGPILOT_*`** |
| **硬件事实**（Rust 常量） | `PXLOGIC_WCH_VID` / `PXLOGIC_LEGACY_PID` / `PXLOGIC_DEVICE_PROFILES` / `PXLOGIC_CHANNEL_MODES` | **保留 `PXLOGIC_`** |

理由：硬件常量描述的是 **PXLogic 这台设备**的事实，而 `pxlogic` 作为驱动名是保留的。
它们将来会随驱动一起迁到 `crates/pxlogic-driver/`。

> **结论：不能做全局的 `PXLOGIC_` → `SIGPILOT_` 替换。** 必须按 §3.1 / §3.2 的白名单逐项处理。

---

## 2. 新命名映射表

### 2.1 Crate 与二进制

| 旧 | 新 | 备注 |
| --- | --- | --- |
| `pxlogic-core` | `sigpilot-core` | 目录 `crates/pxlogic-core/` 一并改名 |
| `pxlogic-file` | `sigpilot-file` | |
| `pxlogic-graph` | `sigpilot-graph` | 含 `src/bin/pxlogic-perf-self-test.rs` |
| `pxlogic-waveform` | `sigpilot-waveform` | |
| `pxlogic-desktop` | `sigpilot-desktop` | `src-tauri` 的 package name |
| `pxlogic-perf-self-test` | `sigpilot-perf-self-test` | 二进制名 |
| `pxlogic-saleae-analyzer-sidecar` | `sigpilot-saleae-analyzer-sidecar` | native sidecar |
| `pxlogic-sigrok-sidecar` | `sigpilot-sigrok-sidecar` | native sidecar |

Rust 模块引用同步：`pxlogic_core::` → `sigpilot_core::`，`pxlogic_graph::` → `sigpilot_graph::`，
`pxlogic_file::` → `sigpilot_file::`，`pxlogic_waveform::` → `sigpilot_waveform::`。

### 2.2 前端与安装包

| 旧 | 新 | 位置 |
| --- | --- | --- |
| `pxlogic-studio`（npm name） | `sigpilot` | `package.json` |
| `PXLogic Studio`（productName） | `SigPilot` | `src-tauri/tauri.conf.json:3` |
| `PXLogic Studio`（窗口标题） | `SigPilot` | `src-tauri/tauri.conf.json:15` |
| `dev.pxlogic.studio`（identifier） | **判断项，见 §5.3** | `src-tauri/tauri.conf.json:5` |

### 2.3 环境变量（**30 个**，全部 `PXLOGIC_` → `SIGPILOT_`）

> 执行时实测：实际数量是 **30 个**，不是初版方案估计的 19 个。遗漏项主要来自
> `native/*/build.sh`、`verify.sh`、`scripts/` 与 `tools/logic2-bridge/`（构建与桥接工具的开关）。

**运行时（Rust + C/C++ sidecar，跨语言必须同名）**

`SIGPILOT_BITSTREAM_DIR` · `SIGPILOT_FPGA_RESET` · `SIGPILOT_FPGA_MAIN` ·
`SIGPILOT_MCU_FIRMWARE` · `SIGPILOT_DECODER_TIMING` · `SIGPILOT_NATIVE_WINDOW_DECODE_WORKERS` ·
`SIGPILOT_SALEAE_SIDECAR` · `SIGPILOT_SALEAE_RUNTIME_ROOT` · `SIGPILOT_SALEAE_MANIFEST` ·
`SIGPILOT_SALEAE_WORKERS` · `SIGPILOT_SALEAE_WINDOW_BATCH` · `SIGPILOT_SALEAE_BATCH_WORKERS` ·
`SIGPILOT_SALEAE_WINDOW_BATCH_WORKERS` · `SIGPILOT_SALEAE_PERSISTENT_SIDECAR` ·
`SIGPILOT_SALEAE_SIDECAR_OPT_LEVEL` · `SIGPILOT_SIGROK_SIDECAR` · `SIGPILOT_SIGROK_DECODER_ROOT` ·
`SIGPILOT_SIGROK_PYTHON_DECODER_ROOT`

**构建与工具**

`SIGPILOT_COPY_NATIVE_DEPS` · `SIGPILOT_REUSE_SIGROK_BUILD` · `SIGPILOT_SIGROK_BUILD_DIR` ·
`SIGPILOT_SIGROK_SOURCE_ROOT` · `SIGPILOT_SALEAE_BUILD_DIR` · `SIGPILOT_SALEAE_RUNTIME_BUILD_DIR` ·
`SIGPILOT_NATIVE_BUILD_DIR` · `SIGPILOT_SALEAE_LOGIC_ZIP` · `SIGPILOT_NLOHMANN_JSON_INCLUDE` ·
`SIGPILOT_MACOS_ARCH` · `SIGPILOT_GRAPH_START_TIMEOUT_MS` · `SIGPILOT_USB_SMOKE`

**⚠️ 跨语言一致性（执行时发现的真实破坏点）**

`native/` 下的 C/C++ sidecar 也直接读环境变量，且**不在最初的替换范围内**
（初版方案只匹配了 `.rs/.ts/.sh/...`，漏了 `.cpp/.c/.h`）：

| 变量 | Rust 侧 | C/C++ 侧 |
| --- | --- | --- |
| `SIGPILOT_SALEAE_BATCH_WORKERS` | 由宿主 `command.env(...)` 设置（`decoder_backend.rs:1832`） | 读取（`standalone_main.cpp:323`） |
| `SIGPILOT_SALEAE_RUNTIME_ROOT` | 读取（`decoder_backend.rs:2369`） | 读取（`saleae-analyzer-sidecar/src/main.cpp:215`、`saleae-graph-sidecar/src/main.cpp:85`） |
| `SIGPILOT_DECODER_TIMING` | 读取（`decoder_backend.rs:156,1817`） | 读取（`standalone_main.cpp:184`） |

**只改一侧会让 worker 数覆盖与 timing 开关静默失效。** 已三侧同步。

**兼容层**：`crates/sigpilot-core/src/env.rs` 提供 `product_env()`，新名优先、
旧名回退并打印弃用警告。Rust 侧 17 个读取点已接入。
**C/C++ sidecar 未实现旧名回退**（它们由宿主拉起，宿主已解析好值）。

### 2.4 前端持久化键（4 个，全部 `pxlogic.` → `sigpilot.`）

| 旧 | 新 | 位置 |
| --- | --- | --- |
| `pxlogic.preferences.v1` | `sigpilot.preferences.v1` | `src/lib/preferences.ts:12` |
| `pxlogic.extensions.v1` | `sigpilot.extensions.v1` | `src/lib/extensions.ts:46` |
| `pxlogic.screenshot-settings.v1` | `sigpilot.screenshot-settings.v1` | `src/lib/screenshots.ts:32` |
| `pxlogic:decoder-timing` | `sigpilot:decoder-timing` | `src/lib/analyzerPerformance.ts:10` |

### 2.5 前端品牌字符串（约 14 处）

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `src/App.tsx:476` | `DEFAULT_DEVICE_ID = "fake:pxlogic-demo"` | `"fake:sigpilot-demo"` |
| `src/App.tsx:3765` | `{ name: "PXLogic Project", extensions: ["pxl"] }` | `{ name: "SigPilot Project", ... }` |
| `src/App.tsx:4940` | `<span>PXLogic</span>` | `<span>SigPilot</span>` |
| `src/App.tsx:8403` | `<small>PXLogic</small>` | `<small>SigPilot</small>` |
| `src/lib/api.ts:614` | `source_device: "PXLogic Preview"` | `"SigPilot Preview"` |
| `src/lib/api.ts:1021` | `id: "fake:pxlogic-demo"` | `"fake:sigpilot-demo"` |
| `src/lib/api.ts:1027,1034,1087` | `"PXLogic Preview Device"` | `"SigPilot Preview Device"` |
| `src/lib/api.ts:1029` | `manufacturer: "PXLogic"` | `"SigPilot"` |
| `src/lib/api.ts:2430` | `"PXLogic demo\n"` | `"SigPilot demo\n"` |
| `src/lib/api.ts:2520` | `Generated PXLogic extension template` | `Generated SigPilot extension template` |
| `src/components/AnalyzerLibraryMenu.tsx:78` | `name="pxlogic-analyzer-library-search"` | `"sigpilot-analyzer-library-search"` |
| `src/lib/waveformDrawProbe.ts` | `window.__SIGPILOT_DRAW__` | `window.__SIGPILOT_DRAW__` |
| `index.html:6` | `<title>PXLogic Studio</title>` | `<title>SigPilot</title>` |

**代码注释里的 `pxlogic`**（`wheelZoom.ts:85`、`frameLoop.ts:4,9`、`captureViewport.ts:10` 等）
按语义改为 `SigPilot`；其中 `captureViewport.ts:10` 引用的是 **crate 路径**，
需同步改为 `crates/sigpilot-graph/src/view_state.rs`。

---

## 3. 冻结清单（**不要改**）

### 3.1 文件扩展名与 magic

| 标识符 | 位置 | 为什么冻结 |
| --- | --- | --- |
| `.pxcap` | 采集文件扩展名（32 处） | 改了老用户的采集文件打不开 |
| `.pxl` | 工程文件扩展名（25 处） | 同上 |
| `PXLF1` | `decoder_backend.rs:520` 线协议 magic | 改了与 sidecar 不兼容 |

> `.pxcap` / `.pxl` 作为**格式名**与产品名解耦是常规做法（如 `.zip`、`.png`）。

### 3.2 硬件常量（保留 `PXLOGIC_` 前缀）

`crates/pxlogic-core/src/protocol.rs`：`PXLOGIC_WCH_VID` · `PXLOGIC_WCH_PID` ·
`PXLOGIC_LEGACY_VID` · `PXLOGIC_LEGACY_PID`

`crates/pxlogic-core/src/pxview_profile.rs`：`PXLOGIC_DEVICE_PROFILES` · `PXLOGIC_CHANNEL_MODES` ·
`PXLOGIC_THRESHOLD_VOLTAGES` · `PXLOGIC_32_CHANNEL_HARDWARE_DEPTH_BITS` 等

**理由**：这些是 PXLogic 硬件的事实，而 `pxlogic` 作为驱动名是保留的。

### 3.3 工程文件格式标识

| 标识符 | 位置 |
| --- | --- |
| `pxlogic.project.v1` | `crates/pxlogic-file/src/lib.rs:913,949,979` |

### 3.4 解码器线协议标识（9 个，跨进程，**最危险**）

| 标识符 | Rust 侧 | C/C++ sidecar 侧 |
| --- | --- | --- |
| `pxlogic.decoder.v1` | `decoder_backend.rs:4274,4313,4349,4392,4441` | `standalone_main.cpp` |
| `pxlogic.decoder.binary_v1` | `:663,1033,6103,6146` | `standalone_main.cpp:1449` |
| `pxlogic.decoder.compact_v1` | `:675,890,5953` | `standalone_main.cpp:1485` |
| `pxlogic.decoder.compact_v2` | `:672,918,5984` | `standalone_main.cpp:1482` |
| `pxlogic.decoder.compact_v3` | `:669,954,6018` | `standalone_main.cpp:1479` |
| `pxlogic.decoder.compact_v4` | `:666,991,6054` | `standalone_main.cpp:1470` |
| `pxlogic.decoder.batch.v1` | `:857` | `standalone_main.cpp:2184,2199` |
| `pxlogic.decoder.window_batch.v1` | `:875,2460` | `standalone_main.cpp:2253,2268` |
| `pxlogic.decoder.markers.binary_v1` | `:1158,6243` | `standalone_main.cpp:1105` |
| `pxlogic.decoder.spi.v1` | — | `native/sigrok-analyzer-sidecar/verify.sh:136,335`；`README.md:40` 明确注明「remains accepted for Saleae/SPI fixture compatibility」 |

**这些字符串跨越 Rust ↔ C++ ↔ C 三个语言边界，且由 shell 测试脚本断言。**
改动必须三侧同时进行，否则解码链路静默失效。

> **建议：完全不改。** 它们是线协议版本标识，与产品名无关。

---

### 3.5 执行时新发现的格式标识符（同样冻结）

初版方案遗漏，执行时经全库扫描补入。全部按同一原则保留：

| 标识符 | 位置 | 性质 |
| --- | --- | --- |
| `pxlogic.saleae-export.v1` | `crates/sigpilot-file/src/lib.rs:342,1821` | 写入 `manifest.json` 的 Saleae 导出格式 |
| `pxlogic.saleae-transition.v1` | `crates/sigpilot-file/src/lib.rs:368,1497` | 读取时校验的 Saleae 转移索引格式 |
| `pxlogic.decoder-fixture.v1` | `testdata/decoders/spi-conformance-v1.json`、`crates/sigpilot-core/tests/decoder_fixtures.rs:60` | 解码器夹具格式 |
| `pxlogic.parallel-conformance.v1` | `testdata/decoders/parallel-conformance-v1.json` | 同上 |
| `pxlogic.sigrok-native-fixture.v1` | `testdata/decoders/sigrok-native-conformance-v1.json` | 同上 |
| `pxlogic.native-can-fixture.v1` | `testdata/decoders/can-conformance-v1.json` | 同上 |
| `pxlogic.native-lin-fixture.v1` | `testdata/decoders/lin-conformance-v1.json` | 同上 |
| `pxlogic.performance.decoder-self-test` | `crates/sigpilot-graph/src/performance_self_test.rs:19` | 性能报告 schema（`docs/performance-self-test.md` 有记载） |

> **判定规则（可直接套用）**：凡是形如 `pxlogic.<something>.v<n>` 或
> `pxlogic.<something>-fixture.v1` 的字符串，都是**格式/协议标识符**，一律冻结；
> 只有 `pxlogic.<a>.<b>` 形态的**前端持久化键**（4 个）才改。
> 这条规则避免了"看起来一样、处置相反"的误判。

---

## 4. 需要迁移策略的四处

### 4.1 环境变量（有外部使用者的可能）

`README.md` 已公开指导用户设置 `SIGPILOT_BITSTREAM_DIR` 等。

**策略**：新名优先，**同时读旧名一个版本**，命中旧名时打印 deprecation warning。

```rust
fn env_var(name: &str) -> Option<OsString> {
    let new = format!("SIGPILOT_{name}");
    let old = format!("PXLOGIC_{name}");
    if let Some(v) = std::env::var_os(&new) { return Some(v); }
    if let Some(v) = std::env::var_os(&old) {
        tracing::warn!("{old} is deprecated, use {new}");
        return Some(v);
    }
    None
}
```

### 4.2 前端持久化键（用户数据）

直接改名会导致用户**偏好设置、扩展列表、截图设置丢失**。

**策略**：一次性迁移读取。

```ts
function migrateKey(oldKey: string, newKey: string) {
  const legacy = localStorage.getItem(oldKey);
  if (legacy !== null && localStorage.getItem(newKey) === null) {
    localStorage.setItem(newKey, legacy);
    localStorage.removeItem(oldKey);
  }
}
```

### 4.3 文件扩展名

**不改。** 但若将来要改，读取端需同时接受新旧扩展名（写入端只写新名）。

### 4.4 Tauri `identifier`（**最重要的判断项**）

见 §5.3。

---

## 5. 判断项（需人工决定）

> **本节三个判断项用户均已拍板，结论见 §0.5「用户决策」。** 下文保留原始分析供追溯。

### 5.1 `App.tsx:8202-8203` 的 "PXView" 标签

```
<InfoRow label="PXView Profile" value={selected?.profile_model ?? "-"} />
<InfoRow label="PXView Channel Mode" value={selectedChannelMode?.description ?? "-"} />
```

`PXView` 是**硬件厂商自己的软件名**（不是本项目名）。两个选项：

- **保留 `PXView`**：准确（设备档案确实来自 PXView 的格式），但用户可能困惑
- **改为中性标签**：如"设备档案 / 通道模式"，去掉厂商名

**建议**：改为中性标签，把 `PXView` 放到 tooltip 或文档里。

### 5.2 `src/lib/analyzers.ts:1153` 的 `"Sigrok Native (PXView)"`

这是**解码后端**的显示名，`PXView` 指的是 sigrok 侧的原生 C 解码器来源。
**建议保留**——它描述的是解码器来源，不是产品名。

### 5.3 Tauri `identifier`

| 选项 | 后果 |
| --- | --- |
| **保留 `dev.pxlogic.studio`** | 现有安装可平滑升级；但标识符与产品名不一致（用户可见于 macOS 偏好路径） |
| **改为 `dev.sigpilot.app`** | 干净；但 OS 视为**全新应用**——现有用户的偏好与权限全部丢失，**无升级路径** |

**建议**：本项目为**非商用致敬作品**，用户量小或为零，**现在就改**（越晚越贵）。
若已有真实用户，则保留并接受不一致。

---

## 6. 执行顺序

按"先底层后上层、先机械后判断"排列，每步可独立编译验证：

1. **Crate 改名**：`git mv crates/pxlogic-* crates/sigpilot-*`（4 个目录）
2. **Workspace 配置**：根 `Cargo.toml` 的 `members`、`[profile.dev.package.*]`；
   各 crate 的 `Cargo.toml` `name` 与 path 依赖
3. **Rust 模块引用**：`pxlogic_core::` → `sigpilot_core::` 等（全库替换）
4. **硬件常量**：**不动**（§3.2）
5. **环境变量**：19 个改名 + 加向后兼容读取（§4.1）
6. **`src-tauri`**：package name、`tauri.conf.json` 的 productName / 窗口标题 / identifier（§5.3）
7. **sidecar 名**：`native/*/build.sh`、`CMakeLists.txt`、`verify.sh`、`smoke-packaged.sh`
8. **线协议标识**：**不动**（§3.4）
9. **前端品牌字符串**：§2.5 的 14 处
10. **前端持久化键**：4 个改名 + 加迁移读取（§4.2）
11. **`package.json`**：name 改为 `sigpilot`
12. **文档**：`README.md`、`CROSS_PLATFORM.md`、`docs/FILE_MAP.md`
13. **`Cargo.lock`**：删除后重新生成

> `docs/` 下的**历史记录**（`ported-features/*`、`perf-attribution-*.md` 等）**不要改**——
> 它们是历史事实，改了会失真。只改 `README.md`、`CROSS_PLATFORM.md`、`FILE_MAP.md`
> 这类"当前状态"文档。

---

## 7. 验证

| 检查 | 命令 |
| --- | --- |
| Rust 编译与测试 | `cargo test --workspace` |
| 前端测试 | `node --test tests/*.test.ts` |
| 前端构建 | `pnpm build` |
| 性能无回归 | `pnpm perf:self-test` |
| 真实硬件链路 | `pnpm tauri dev` + USB 采集一次 |
| sidecar 链路 | `native/sigrok-analyzer-sidecar/verify.sh`、`native/saleae-analyzer-sidecar/verify.sh` |
| 残留检查 | 确认生产代码里无遗留的 `pxlogic`（§3 白名单除外） |

**残留检查命令**（应只剩白名单内的命中）：

```bash
grep -rn "pxlogic" --include='*.rs' --include='*.ts' --include='*.tsx' --include='*.cpp' --include='*.c' \
  --exclude-dir=vendor --exclude-dir=target --exclude-dir=node_modules . \
  | grep -v "PXLOGIC_WCH\|PXLOGIC_LEGACY\|PXLOGIC_DEVICE_PROFILES\|PXLOGIC_CHANNEL_MODES\|PXLOGIC_THRESHOLD\|PXLOGIC_.*_HARDWARE_DEPTH\|pxlogic\.decoder\|pxlogic\.project\|PXLF1\|pxcap\|pxl"
```

---

## 8. 影响面汇总

| 类别 | 数量 | 处置 |
| --- | --- | --- |
| 含 `pxlogic` 的文件（总） | **160** | — |
| 其中生产代码 | **77** | 需逐项处理 |
| `PXLOGIC_` 出现次数 | 258 | 19 个环境变量改；硬件常量保留 |
| `pxlogic.` 出现次数 | 96 | 4 个 localStorage 键改；10 个协议标识冻结 |
| `.pxcap` / `.pxl` | 57 | 冻结 |
| `PXLF1` | 2 | 冻结 |

---

## 附录：与本方案的关系

改名正好与前面讨论的**设备分层**是同一个动作：

- `pxlogic` 从"产品名"降级为 **`DeviceDriver` 的一个 `driver_id`**
- 平台名是新的 `SigPilot`
- 将来第三方驱动各自命名（`crates/sigpilot-driver-sigrok/`、`sigpilot-driver-vendorx/`）

所以执行本方案时，§3.2 的硬件常量应当**顺手迁到独立的驱动 crate**（如
`crates/pxlogic-driver/`），而不是留在 `sigpilot-core` 里。
若暂不拆分，至少加注释说明它们是**驱动事实**而非产品名。

设备分层的设计见 `docs/sigrok-device-layer-reference.md`。
