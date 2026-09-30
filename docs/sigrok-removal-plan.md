# 废弃 sigrok 集成：影响面与执行清单

> 状态：**待评估，未执行**。本文只做清点，不改任何代码。
> 所有数字与行号均为在本仓库实测所得（2026-09-30，基线 `174b89c`）。
>
> **v2 修订说明**：v1 版本按「连续行区间」划分 Rust 改动范围，实测会误删 Saleae 的共用代码。
> 本版已按**逐顶层项判定**重写，并列出必须保留的清单。详见 §1.4。

## 0. 结论先说

**如果目的是「省代码量」，不值得做。如果目的是包体、许可证和构建链，值得认真考虑。**

| 维度 | 实测结果 | 是否值得 |
| --- | --- | --- |
| 仓库受跟踪代码量 | 1,014 文件 / 约 241,600 行（占仓库 56.3% 文件数） | ❌ **省下的是仓库体积**：其中 999 个文件、236,598 行（98.5%）是 vendored 第三方代码 |
| 自己维护的代码 | **3,922 行**（sidecar 3,014 + Rust 胶水 773 + 前端 135） | ⚠️ **这是一块真实的维护面**，但不是「代码量」意义上的节省 |
| 冷构建时间 | **15 秒**（10 核，217 个 CMake 目标） | ❌ 不构成决策依据 |
| 包体（macOS） | **−22 MB**（215 个 C `.so` + 223 个 Python 解码器） | ✅ 用户可感知 |
| 包体（Windows/Linux） | **−79 MB**（22 MB 解码器 + 57 MB CPython 标准库） | ✅ 用户可感知 |
| GPL 传染面 | 树内 524 个 GPL-2.0-or-later + 55 个 GPL-3.0-or-later 文件全部消失 | ✅ 法律义务归零 |
| CI | 少一个原生构建+验证环节、少 215 个 `.so` 产物上传 | ✅ |
| 功能 | **失去 223 个 sigrok Python 解码器**，只剩 Saleae Native 一条链路 | ⚠️ **这是真实代价** |

`docs/rename-plan.md` §0.5 已记录过「当前优先保证 Saleae 链路」。如果那仍是当前取舍，本方案与之一致。

> **关于「3,922 行」这个数字**：它不算小——其中 `src/main.c` 有 2,339 行，
> 另有 675 行构建/验证工具链（`build.sh` 里那段 Python toolchain fingerprint 逻辑就是为它写的）。
> 这块代码必须跟着 GLib / Python 版本走，是**长期维护成本**，不是一次性删除。
> 但把它和「省 24 万行代码」混为一谈是不诚实的：省下的大头是 vendored 代码。

---

## 1. 必须先决策 / 必须知道的四件事

### 1.1 `DecoderBackendKind::SigrokNative` 是**线格式标识**，删变体会让旧存档解析失败

`crates/sigpilot-core/src/decoder_backend.rs:37`

```rust
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]          // ← 没有 #[serde(other)] 兜底
pub enum DecoderBackendKind {
    Auto,
    SaleaeNative,
    SigrokNative,                             // ← 就是这一行
    LegacyRust,
}
```

它被写进工程文件：`crates/sigpilot-file/src/lib.rs:93` 的 `pub decoder_backend: DecoderBackendKind`。

**直接删变体的后果**：任何已保存、其中某个分析器记录了 `"sigrok_native"` 的 `.pxcap` / `.pxl` 文件，
**反序列化会直接报错**（serde 遇到未知变体即失败），整个工程打不开。

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A（推荐）** | 枚举留着 `SigrokNative`，只删实现；需要它的分支返回「该后端已不可用」 | 最安全，留一个死变体 |
| B | 加 `#[serde(other)] Unknown`，旧值落到 `Unknown` 并降级为 `Auto` | 需要处理所有 match 的穷尽性 |
| C | 直接删 | **破坏用户已有工程文件**，需要发版说明 |

**建议 A**——与 `docs/rename-plan.md` §3.4「线协议标识冻结」原则一致：格式兼容性优先于代码整洁。

### 1.2 `.sr` 导出**不是** sigrok 集成，不要动 `sigpilot-file`

`crates/sigpilot-file/src/lib.rs` 里有 5 处 sigrok 命中，但**全部是 sigrok session 文件格式支持**：

- `:1118` `output.push_str("sigrok version=0.5.2\n\n")` —— `.sr` 导出的文件头
- `:1288` / `:1388` —— `.sr` 元数据往返测试
- `:1930` / `:1935` —— 测试夹具里的 `"LIN via sigrok"`

`.sr` 是**导出格式**，与是否内置 sigrok 解码器无关。按 §3.1（文件扩展名与 magic 冻结）**整文件不动**。

### 1.3 名字容易误导的两处，方向相反

| 路径 | 是什么 | 处置 |
| --- | --- | --- |
| `crates/sigpilot-core/src/pxview_profile.rs` | **PXLogic 设备型号表**（10 条 profile）。PXView 是 PXLogic 的官方上位机 | ✅ **不要动** |
| `vendor/pxview-sigrokdecode/` | PXView 对 libsigrokdecode 的 fork | ❌ 随集成删除 |

### 1.4 ⚠️ 两个已实测踩到的陷阱（v1 计划就是在这里错的）

**陷阱一：`decoder_backend.rs` 里同一段区间混着 Saleae 的共用代码，不能按连续行区间删。**

v1 计划写的是「删除 3218–3922 主块」。实测该区间内住着二十来个**Saleae 或双后端共用**的函数：

```
discover_workspace_saleae_sidecar     saleae_sidecar_search_paths      saleae_build_platform_id
native_sidecar_search_paths           decoder_resource_search_paths    workspace_native_search_paths
workspace_decoder_search_paths        push_bundled_native_candidate    push_workspace_native_candidate
dedup_paths                           discover_saleae_runtime_root     saleae_runtime_search_dirs
push_saleae_runtime_candidates        is_saleae_analyzer_runtime (×4)  native_protocol_name
supports_compact_edges                prefer_saleae_compact_v4         prefer_saleae_binary_v1
protocol_names                        ensure_protocol_available
```

整块删会直接把 Saleae 链路打断。

**陷阱二：`SigrokDecoderCatalog` 等 4 个类型是 Saleae 也在用的共享类型，必须保留。**

名字带 `Sigrok` 纯属历史命名（第一个消费者是 sigrok）。证据：

- `SaleaeNativeDecoder::decoder_catalog()`（`:2392`）返回 `SigrokDecoderCatalog`
- `src-tauri/src/main.rs:1697 saleae_decoder_catalog()` 也返回它
- `DecoderBackendInfo.decoder_catalog: Vec<SigrokDecoderCatalogItem>`（`:252`）是共享结构体字段
- `graph/src/performance_self_test.rs:357` 也调用它

**这两条合起来说明：范围判定不能靠「看着像一块」，必须逐个顶层项查调用方，最后让编译器兜底。**

---

## 2. 删除清单

### 批次 A：vendored 第三方源码（999 文件 / 8.84 MB）

```
vendor/pxview-sigrokdecode/          整目录
```

删除前确认无其他消费者：`grep -rn "pxview-sigrokdecode" --exclude-dir=target .`
当前消费者只有 `native/sigrok-analyzer-sidecar/CMakeLists.txt` 与 `scripts/prepare-tauri-resources.sh`（都在本次修改范围内）。

### 批次 B：sidecar 本体（8 文件 / 3,014 行）

```
native/sigrok-analyzer-sidecar/      整目录
├── src/main.c            2,339 行   ← 主要实现
├── verify.sh               355 行   ← CI 里的 conformance 验证（23 个用例）
├── build.sh                121 行   ← 含 python toolchain fingerprint 逻辑
├── CMakeLists.txt           97 行   ← 定义 217 个目标
├── smoke-packaged.sh        36 行
├── README.md                50 行
├── LICENSE                  14 行   ← 标的是 GPL-2.0-or-later（本身不准，见下）
└── .gitignore                2 行
```

顺带修掉：`native/sigrok-analyzer-sidecar/LICENSE` 标的是 **GPL-2.0-or-later**，
但树里 55 个文件是 GPL-3.0-or-later → 整体应为 GPL-3.0-or-later。删除后这个问题自动消失。

### 批次 C：测试夹具（1 文件）

```
testdata/decoders/sigrok-native-conformance-v1.json
```

唯一消费者是 `native/sigrok-analyzer-sidecar/verify.sh:8`（同批删除），可安全移除。

### 批次 D：本地生成物（不进 git，但要清）

```bash
rm -rf native/sigrok-analyzer-sidecar/target      # 42 MB 构建缓存（215 个 .so）
rm -rf resources/native/sigrok-analyzer-sidecar   # 17 MB 打包资源
```

并从 `.gitignore` 移除 `/pxview-fork/` 一行（那是 sigrok 源码树的备用路径）。

---

## 3. 修改清单

### 3.1 `crates/sigpilot-core/src/decoder_backend.rs`（唯一复杂的一处）

文件共 **7,268 行**，sigrok 相关 125 行。**必须分成 6 个互不相连的区间处理**，不能整块删。

#### 3.1.1 删除（sigrok 专属，已逐个核验）

| 行区间 | 内容 |
| --- | --- |
| `140–142` | `const SIGROK_NATIVE_PROTOCOLS` |
| `163–166` | `const SIGROK_SIDECAR_EXECUTABLE`（`#[cfg(windows)]` + `#[cfg(not(windows))]` 两份） |
| `3218–3224` | `pub struct SigrokNativeDecoder` |
| `3225` | `type SigrokProbeCacheKey` |
| `3226–3227` | `static SIGROK_PROBE_CACHE` |
| `3228–3230` | `static SIGROK_FROM_ENV_CACHE` |
| `3292–3312` | `struct SigrokSidecarProbe` |
| `3313–3503` | `impl SigrokNativeDecoder`（含 `from_env` / `from_env_cached` / `probe` / `probe_with_catalog` / `decode_*`） |
| `3504–3509` | `fn discover_workspace_sigrok_path` |
| `3510–3520` | `fn discover_workspace_sigrok_python_decoder_root` |
| `3759–3879` | `impl DecoderBackend for SigrokNativeDecoder` |
| `3914–3922` | `fn ensure_sigrok_protocol_available` |
| `5466–5478` | 测试 `native_backend_fallback_info_keeps_external_protocol_catalog_visible` 里的 **sigrok 断言段**（该测试本身保留，只删这一段） |
| `6943–7002` | 三个只被 sigrok 测试使用的 helper：`catalog_item_native_settings` / `catalog_channel_key` / `catalog_option_key` |
| `7021–7267` | 九个 `#[ignore]` 的 sigrok sidecar 测试（`sigrok_native_sidecar_decodes_*` 等） |

> 删除时**从下往上**执行，避免行号漂移。区间之间的空行归属需人工确认，删完立即 `cargo fmt`。

#### 3.1.2 必须保留（在 3.1.1 的区间之间，位置会让人以为该删）

| 行区间 | 内容 | 为什么留 |
| --- | --- | --- |
| `3231–3237` | `pub struct SigrokDecoderCatalog` | Saleae 的 `decoder_catalog()` 返回它 |
| `3238–3266` | `pub struct SigrokDecoderCatalogItem` | 同上 + `DecoderBackendInfo` 的字段类型 |
| `3267–3279` | `pub struct SigrokDecoderChannel` | 同上（item 的字段） |
| `3280–3291` | `pub struct SigrokDecoderOption` | 同上（item 的字段） |
| `3522–3758` | 全部 Saleae / 双后端共用的路径发现函数 | 见 §1.4 清单 |
| `3881–3913` | `native_protocol_name` / `supports_compact_edges` / `prefer_saleae_*` / `protocol_names` | Saleae 与 LegacyRust 都在用 |
| `3924–3941` | `fn ensure_protocol_available` | 双后端共用 |
| `5456–5464` | 测试 `native_backend_fallback_info_...` 的 Saleae 断言段 | 该测试保留 |

> 这 4 个 `Sigrok*` 类型建议**改名**为后端中立的 `DecoderCatalog` / `DecoderCatalogItem` /
> `DecoderCatalogChannel` / `DecoderCatalogOption`——但那是**独立的改名任务**（要同步改 TS 类型
> 与 `sigrokCatalog*` 前端 helper），**不要和本次删除混在一起**。

#### 3.1.3 只改文案（可选，不影响功能）

| 行 | 内容 |
| --- | --- |
| `5` / `43–44` / `100` | 文档注释里提到 sigrok 的句子 |
| `4762` | 错误文案 `"Compatibility fallback only; prefer Saleae Native or Sigrok Native."` |
| `5187` / `5223` | 测试夹具字符串 `"sigrok-uart-test"` / `"sigrok-i2c-test"`（纯命名） |

#### 3.1.4 ⚠️ 强制流程

**不要一次删完就提交。** 按区间删 → 立刻 `cargo check -p sigpilot-core --all-targets` → 处理报错 → 再删下一批。
编译器的 `unused` 警告是发现「某个 helper 其实只有 sigrok 在用」的唯一可靠信号。

### 3.2 其余 Rust 文件

| 文件 | 位置 | 处置 |
| --- | --- | --- |
| `crates/sigpilot-core/src/lib.rs` | `:38` `pub use decoder_backend::{...}` 里的 `SigrokNativeDecoder` | 删该导出项（**保留 4 个 `Sigrok*Catalog*` 导出**） |
| `crates/sigpilot-core/src/decode.rs` | `:282` 文案 `"... requires a Saleae Native or Sigrok Native decoder backend"` | 改为只提 Saleae Native |
| `crates/sigpilot-graph/src/lib.rs` | `:15` import、`:759` 文案、`:1810–1811` match 分支、`:2824` match 分支、`:4320–4321` 工厂分支、`:8480` 测试 | 逐处删/改 |
| `src-tauri/src/main.rs` | `:20` import 里的 `SigrokDecoderCatalog`/`SigrokNativeDecoder` | 只删 `SigrokNativeDecoder` |
| | `:1686` `async fn sigrok_decoder_catalog()` 整个命令 | 删 |
| | `:1978` `fn warm_sigrok_native_catalog_async()` 及其调用点 | 删 |
| | `:2040` `generate_handler!` 里的 `sigrok_decoder_catalog,` | 删该行 |
| | `:1697` `saleae_decoder_catalog()` / `:1963` / `:1987` | **保留**（Saleae 的目录查询，返回共享类型） |

**不要动**：
- `crates/sigpilot-core/src/device.rs` —— 7 处命中全是**设计注释**（说明驱动 vtable 为何照 sigrok 的
  `sr_dev_driver` 形状设计）+ 1 处测试断言。删掉会丢失「为什么这么设计」。
- `crates/sigpilot-file/src/lib.rs` —— 见 §1.2。
- `crates/sigpilot-core/src/pxview_profile.rs` —— 见 §1.3。

### 3.3 前端（7 个文件，约 135 行）

| 文件 | 命中行 | 处置 |
| --- | --- | --- |
| `src/lib/analyzers.ts` | 45 | `:33` `EXTERNAL_DECODER_BACKENDS` 去掉 `"sigrok_native"`；`:234` 删 `backends: ["sigrok_native"]` 分组；`:422–455` 删 `sigrokCatalogDisplayName` / `sigrokCatalogDetailName` / `sigrokCatalogProtocolName` / `sigrokCatalogRunnerLabel`；`:335` `:476` `:546` 改为只走 Saleae |
| `src/App.tsx` | 35 | sigrok catalog 拉取与状态 |
| `src/components/AnalyzerSettingsDialog.tsx` | 15 | 后端选择项 |
| `src/lib/api.ts` | 13 | TS 类型 + `sigrok_decoder_catalog` 的 invoke 封装 |
| `src/components/AnalyzerLibraryMenu.tsx` | 4 | 后端过滤 |
| `src/lib/sidebar.ts` | 1 | 后端列表 |
| `tests/analyzer-backends.test.ts` | 275 行 / 18 命中 | **混合文件，不是整篇删**。8 个 test 中 4 个 sigrok 专属（`:40` `:93` `:140` `:179`）删掉，其余保留 |

> ⚠️ `api.ts` 里 `SigrokDecoderCatalog*` 的 **TS 类型是 Saleae 目录也在用的**（与 Rust 侧同理）。
> 删之前先确认哪些类型名被 `saleae` 相关代码引用。

### 3.4 脚本与 CI

| 文件 | 处置 |
| --- | --- |
| `scripts/prepare-tauri-resources.sh` | 34 处命中。删 `copy_python_runtime()`（`:105–129`，**Windows/Linux 上省 57 MB**）、sigrok sidecar 落地、`decoders/c_decoders` 与 `decoders/python_decoders` 复制、`PXVIEW_ROOT` 探测、`SIGPILOT_SIGROK_*` 分支、"Skipping Sigrok sidecar" 提示 |
| `.github/workflows/build-cross-platform.yml` | 29 处命中。删：`native/sigrok-analyzer-sidecar/verify.sh` 步骤（checks / Linux 各一处）、`SIGPILOT_SIGROK_BUILD_DIR` 缓存、资源探测里的 `sidecar` / `decoder_root` / `python_root` / `python_home` 四个变量与对应 `test`、`smoke-packaged.sh` 调用、Windows 便携包与 AppImage 里的 sigrok 探测块 |

**不受影响**：`native/saleae-analyzer-sidecar/`、`vendor/saleae-standalone`、`vendor/saleae-runtime-2.4.43`、
`crates/sigpilot-{graph,waveform}`、设备注册表。

### 3.5 文档

| 文件 | 处置 |
| --- | --- |
| `docs/FILE_MAP.md`（3 处） | 删 sigrok sidecar 条目 |
| `README.md`（5 处） | 删 sigrok 后端说明 |
| `CROSS_PLATFORM.md`（3 处） | 删 sigrok 构建前置条件（GLib / Python3） |
| `docs/sigrok-device-layer-reference.md`（752 行） | **保留**。设备层设计的参考依据（多厂商如何组织驱动），不是集成代码 |
| `docs/ported-features/2026-07-2{3,4,5}-*sigrok*.md`（5 篇） | **保留**。按 §6「历史记录不改」 |

---

## 4. 验证清单

```bash
# 1. 残留检查（应只剩「保留」清单里的历史文档与设计注释）
grep -rnE "sigrok|Sigrok" --include='*.rs' --include='*.ts' --include='*.tsx' \
  --include='*.sh' --include='*.c' --include='*.json' \
  --exclude-dir=target --exclude-dir=node_modules --exclude-dir=dist \
  --exclude-dir=vendor --exclude-dir=.git .

# 2. Rust（预期 220 个测试减少 sigrok 相关的那部分，0 failed）
cargo test --workspace
cargo check --workspace --all-targets        # 必须无 warning

# 3. 前端
./node_modules/.bin/tsc --noEmit
node --experimental-strip-types --test tests/*.test.ts

# 4. 资源准备脚本（不应再产出 sigrok 目录）
rm -rf resources/native && node scripts/prepare-tauri-resources.mjs && ls resources/native/

# 5. CI YAML
python3 -c "import yaml;yaml.safe_load(open('.github/workflows/build-cross-platform.yml'))"

# 6. 兼容性（若选 §1.1 方案 C 则必然失败——这正是要验的）
#    用一个含 "sigrok_native" 的旧 .pxl 打开
```

**包体回归**：打一次 release，对比 `SigPilot.app` 体积（macOS 预期 −22 MB）。

---

## 5. 回滚

全部改动集中在一个提交里即可整体回滚：

```bash
git revert <commit>
```

**已实测的完整回滚配方**（本次执行中途用过，有效）：

```bash
git reset -q && git checkout -- .     # 受跟踪的删除与修改全部恢复
```

`git rm` 会把删除放进索引，**必须先 `git reset` 清空索引**，否则 `git checkout -- .` 只恢复工作区、
索引里仍是删除状态。

被 gitignore 的生成物 git 恢复不了，必须重建：

```bash
native/sigrok-analyzer-sidecar/build.sh                              # 15 秒，215 个 .so，42 MB
SIGPILOT_REUSE_SIGROK_BUILD=1 scripts/prepare-tauri-resources.sh     # 5 秒，17 MB
native/sigrok-analyzer-sidecar/verify.sh                             # 86 秒，23 PASS / 0 FAIL
```

---

## 6. 建议的执行顺序

1. **先决策 §1.1**（`DecoderBackendKind` 怎么处理）——这一步决定后面所有 Rust 改动的形状
2. 批次 A + B + C 的删除，跑一次 `cargo check` 确认编译面
3. 按 §3.1 **分区间**清 `decoder_backend.rs`，**每删一批就跑一次 `cargo check`**（见 §3.1.4）
4. 按 §3.2 清其余 Rust，跑 `cargo test --workspace`
5. 按 §3.3 清前端，跑 `tsc` + 前端测试
6. 按 §3.4 清脚本与 CI
7. 按 §3.5 更新文档
8. 打包验证包体

**每步单独一个提交**，便于定位问题。
