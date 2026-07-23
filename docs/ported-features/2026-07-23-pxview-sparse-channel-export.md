# PXView Sparse Physical Channel Export

## 功能范围

- 稀疏捕获导出 `.sr` 时，只声明真实启用的物理 probe，不再把 D0 与 D4 之间的 D1-D3 伪装成已采集通道。
- `.sr` 继续保留 PXView 的物理 probe 编号：D0 写为 `probe1`，D4 写为 `probe5`。
- VCD 只声明、初始化和更新 enabled channels，同时直接读取 capture sample word 中对应的物理 bit。
- 连续通道捕获和缺少 `enabled_channels` 的旧 `.pxcap` 保持原有导出行为。

## 上游参考路径

- `pxview-fork/libsigrok/output/srzip.c`
  - `init()` 将全部逻辑通道数量写入 `total probes`。
  - 只为 `ch->enabled` 的通道写 `probeN`，其中 `N = ch->index + 1`，因此稀疏 probe 保留物理编号。
  - `append_archive_data()` 将 packet `unitsize` 写入 metadata，样本数据不因 probe 名单而重新编号。
- `pxview-fork/PXView/pv/storesession.cpp`
  - `StoreSession::meta_gen()` 只统计 enabled 且有数据的逻辑 probe。
  - 逻辑 probe metadata 使用 `probe->index`，而不是 compact list index。

## 本地落点

- `crates/pxlogic-file/src/lib.rs`
  - 新增统一的 export channel 校验路径，复用 `resolve_enabled_channels()` 的排序、重复和越界规则。
  - `.sr` metadata 生成器改为遍历 enabled physical channels，保留 `total probes = channel_count` 与物理 `probeN`。
  - VCD declaration 和 value dump 改为遍历 enabled physical channels。
  - 新增 D0+D4 稀疏 `.sr` archive 与 VCD transition 测试。

## 复用方式

- 直接搬运 PXView `srzip.c` 的“物理总数 + enabled probe entries + physical probe index”规则。
- VCD 沿用同一通道身份规则；VCD identifier 是不透明标识，因此以物理通道号生成稳定 identifier。
- capture 内部样本仍保持物理 bit 布局，不执行 compact repack，避免 D4 在导出时被误解释为 D1。

## 用户可见行为

以 `channel_count=5`、`enabled_channels=[0,4]` 的捕获为例：

```text
[device 1]
capturefile=logic-1
total probes=5
samplerate=...
unitsize=1
probe1=D0
probe5=D4
```

- PulseView/sigrok 不再看到 D1-D3 的虚假通道名称。
- VCD viewer 只看到 D0、D4；两条波形的边沿来自 sample byte 的 bit 0 与 bit 4。

## 验证

```text
cargo test -p pxlogic-file
cargo test --workspace
cargo check --workspace --all-targets
cargo fmt --all --check
git diff --check
```

- `pxlogic-file`：7 tests passed。
- 稀疏 SR 测试解包归档，确认只存在 `probe1=D0`、`probe5=D4`，且 `logic-1` 保持原始物理样本字节。
- 稀疏 VCD 测试使用 `0x10 -> 0x01 -> 0x11`，确认 D0/D4 的初始化与两个时间点转换均来自正确物理 bit。

## 已知差距 / 后续任务

- 当前 `.sr` writer 延续本项目既有的单个 `logic-1` entry；PXView 的通用 `srzip.c` 可按 packet 写 `logic-1-N` chunks。本轮只修正通道身份，不改变既有 archive 分块格式。
- 本轮不修改 `.pxcap`：其 metadata 已在前一功能中保存完整 `enabled_channels`。

## 对应 Git 提交

- 尚未提交。
