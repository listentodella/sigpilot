# Logic 2 Bridge: Windows 11 实机验证

本文用于在 Windows 11 上继续验证 PXLogic Logic 2 Bridge。目标是让独立
native host 正确启动官方 GraphServer，再将 PXLogic 数据注入
GraphServer 的 `OnDataBuffer` 回调。

## 当前状态

当前分支为 `codex/graph-server-32ch`，Windows Logic 2.4.46 profile 为：

```text
logic-2.4.46-windows-x64-888ecceb
CodeView: 888ECCEB-C0E8-4943-8F4F-0F6F529F2ACA-1
OnDataBuffer RVA: 0x50B750
状态: pending-live-validation
```

PE 身份、SHA256、回调候选地址、prologue 和 Microsoft x64 参数布局已经分析，
但尚未在 Windows 11 上完成真实 PXLogic 捕获，因此不能标记为 `verified`。

## 当前阻塞点

典型日志如下：

```text
loading ...\\graph_server_shared.dll
physical Saleae scan: disabled
... GraphServer ... physical device scanning disabled by client
fatal: Timed out waiting for the native GraphServer on port <port>
```

这表示 DLL 已加载，但 `CreateGraphServer` 没有返回，GraphServer 也没有监听
WebSocket 端口。PXLogic helper 尚未启动，硬件和数据注入还没有参与。因此当前
应先取得 Windows 原生初始化调用栈，而不是先排查 USB、bitstream 或 decoder。

## 环境准备

- Windows 11 x64
- 官方 Logic 2.4.46，默认路径 `C:\Program Files\Logic`
- Visual Studio 2022 Desktop C++ workload、Windows SDK、MSVC x64 工具链
- Node.js 22、Rust stable、Git Bash
- WinDbg Preview 或 Visual Studio native debugger

拉取当前分支：

```powershell
git clone git@github.com:listentodella/pxlogic.git
Set-Location pxlogic
git checkout codex/graph-server-32ch
```

至少应包含这些修复提交：

```text
3f2a1e0  Windows COM/Winsock 生命周期修正
918c457  Windows DLL 搜索目录和依赖初始化
488c499  portable 构建在 artifact quota 满时仍保留产物
```

## 一、检查安装树和 profile

在 Git Bash 中执行：

```bash
node tools/logic2-bridge/scripts/fingerprint-installation.cjs \
  'C:/Program Files/Logic' \
  --platform win32 \
  --architecture x64
```

结果必须包含：

```text
logicVersion: 2.4.46
platform: win32
architecture: x64
identityKind: pe-codeview-guid-age
identity: 888ECCEB-C0E8-4943-8F4F-0F6F529F2ACA-1
```

如果 profile 不匹配，应停止运行，不要对未知 DLL 进行 patch。

## 二、启动 native host

推荐先由 packaged client 启动。也可以直接运行 bridge：

```powershell
node tools/logic2-bridge/index.cjs `
  --app 'C:\Program Files\Logic' `
  --allow-pending-profile `
  --capture-window-ms 1000
```

修复后的 host 应输出：

```text
DLL search directory: C:\Program Files\Logic\resources\windows-x64
Python home ...: directory
dependencies before CreateGraphServer: Analyzer.dll=loaded python314.dll=loaded
GRAPH_WS_READY ws://127.0.0.1:<backend-port>/saleae
```

如果 `GRAPH_WS_READY` 出现，继续确认 Logic 进程能连接 public Graph WebSocket。

如果 60 秒后仍超时，保存：

```text
%LOCALAPPDATA%\PXLogic\logic2-bridge\graphio.log
```

并记录 `where node`、`node --version`、Logic 安装路径、文件权限、Windows
Defender/企业安全软件状态以及 backend port 是否被占用。

## 三、WinDbg 调用栈取证

等日志出现 `waiting up to ... for native GraphServer` 后，用 WinDbg 附加
`graph-host.exe`，执行：

```text
File -> Attach to process -> graph-host.exe
Debug -> Break All
~* kb
lm
lmvm graph_server_shared
lmvm Analyzer
lmvm python314
```

保存所有线程的调用栈。重点判断是否停在 Python 初始化、Analyzer.dll、
`WS2_32.dll` 的 `bind/listen`、mutex/condition variable，或安全软件拦截。
如果 GraphServer 等待 Electron/Node 状态，独立 host 方案需要改为由官方
Electron 进程加载 GraphServer，而不是继续调整 PXLogic。

## 四、验证注入和真实硬件

只有 GraphServer 成功后才进行硬件验证。需要看到：

```text
verified GraphServer profile logic-2.4.46-windows-x64-888ecceb
installed experimental profile ... PXLogic hook
[logic2-bridge:inject] callback=...
```

依次验证：

1. 单通道捕获；
2. D0-D3 四通道 SPI 捕获；
3. 稀疏通道捕获；
4. 1.2 V、1.8 V、3.3 V nominal voltage；
5. Logic 软件 trigger 和 glitch filter；
6. SPI、UART、I2C 原生 decoder；
7. `.sal` 导出和重新打开。

Logic 的 trigger、glitch filter、decoder 和 marker 仍属于 GraphServer/Logic
软件链路，不需要为 PXLogic 增加对应的硬件触发配置。PXLogic 只输出按 Logic
Pro 16 布局转换后的采样数据。

## 五、portable 包验收

Windows portable 目录必须包含：

```text
PXLogic Bridge.exe
tools/logic2-bridge/index.cjs
tools/logic2-bridge/build/graph-host.exe
target/release/usb_smoke.exe
resources/bitstreams/hspi_ddr.bin
resources/bitstreams/hspi_ddr_RST.bin
resources/firmware/SCI_LOGIC.bin
```

portable 包不包含 Saleae GraphServer。运行时必须从用户选择的官方 Logic
安装目录加载 GraphServer、Analyzer.dll、Python DLL 和 Python runtime。

## profile 晋级标准

只有以下条件全部满足，才可以把 Windows profile 从
`pending-live-validation` 改为 `verified`：

- Win11 上 `CreateGraphServer` 成功返回并监听 WebSocket；
- 官方 Logic 能连接 Graph WebSocket；
- PE identity 和 prologue 运行时校验通过；
- 至少一次真实 PXLogic 捕获进入 `OnDataBuffer`；
- 四通道波形正确，至少一个原生 decoder 正确输出气泡；
- 捕获、触发、导出 `.sal` 全部通过；
- 没有 underflow、ABI 崩溃或数据错位。

在此之前，Windows 版本只能称为实验性验证包，不能声称已正式支持 Win11。
