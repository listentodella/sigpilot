# Saleae HLA 兼容范围

## 目标

SigPilot 支持在不安装 Logic 2 的情况下，运行明确列入支持清单的本地纯 Python High Level Analyzer（HLA）。实现方式是：

- 使用通用、可分发的 CPython；
- 使用项目原创的 `saleae.analyzers` / `saleae.data` 兼容层；
- 使用项目自己的 JSON-lines 宿主和解码编排；
- 将 Saleae Native LLA 产生的原始 FrameV2 字段传给 HLA；
- 不复制 Logic 2 的私有 Python 包、graph server 或宿主二进制。

这里的 `saleae` 命名空间是公开作者接口的兼容名称，不表示其中代码来自 Saleae。

## 首版支持

### 扩展加载

- 本地 `extension.json`；
- `extensions` 中 `type: "HighLevelAnalyzer"` 的 `Module.Class` 入口；
- 扩展目录内的辅助 Python 模块；
- 本地扩展路径、入口和设置会随分析器会话保存。

宿主会先校验 manifest 和入口，再导入 Python 模块；入口模块必须位于扩展目录内。

### Python API 子集

支持项目自身实现的：

- `HighLevelAnalyzer`；
- `AnalyzerFrame`；
- `StringSetting`；
- `NumberSetting`；
- `ChoicesSetting`；
- `result_types` 的有限格式模板；
- `GraphTime` / `GraphTimeDelta` 的主要算术、比较、UTC 转换和采样网格校验。
- 两种实例化约定：常见的 `def __init__(self)`，以及 Saleae 旧式 `def __new__(cls, settings, ...)`（宿主把设置映射交给 `__new__`，扩展可先适配再交给基类应用）；

`result_types` 目前只支持 `{{type}}` 和 `{{data.field}}` 形式的点路径插值。不支持 Handlebars helper、block、comment、triple braces 或任意表达式。

### 输入与执行

- 首版上游限定为一个 Saleae Native UART、I2C 或 SPI 分析器；
- 处理完整采集，不按当前可视窗口重置 HLA 状态；
- 批量传输，默认每批最多 1024 个 FrameV2；
- 支持 `decode(frame)` 返回 `None`、单个 `AnalyzerFrame` 或列表；
- 结果按时间顺序进入现有轨道、气泡和表格；
- 修改上游配置、HLA 设置、采集或扩展入口会使完整缓存失效；
- 可从 UI 或 Tauri 命令取消运行中的 HLA，取消会终止宿主并使当前解码代次失效。
- 单个 HLA 失败只影响它自己：波形与其它分析器继续更新，失败原因随该分析器的渲染结果返回并显示，不再让整帧请求失败；

原始字段保留字符串、整数、布尔、浮点、byte、bytes、空值、列表和映射等传输类型。显示层若需要兼容现有字段模型，复杂值会被格式化；HLA 输入本身不依赖显示用字符串。

## 明确不支持

首版不承诺：

- `DigitalMeasurement` / `AnalogMeasurement`；
- `AnalogData`；
- numpy、C 扩展或自动 pip 安装；
- 多层 HLA 链；
- sigrok `OUTPUT_PYTHON` 与 HLA 的协议桥接；
- Marketplace 自动安装/更新；
- 所有 Logic 2 API；
- 任意社区 HLA 零修改兼容；
- 完整 Handlebars 兼容；
- 把宿主进程当作安全沙箱。

扩展在宿主进程中拥有调用者的文件、网络和操作系统权限。只运行可信扩展。`-I` 和路径清理用于减少环境污染，不是权限隔离。

## 运行时与分发

Sigrok 和 HLA 共用一份经过 ABI 检查的 CPython 分发，但使用独立进程。资源布局为：

```text
resources/native/
├── python-runtime/
├── sigrok-analyzer-sidecar/
├── saleae-analyzer-sidecar/
└── hla-analyzer-sidecar/
```

打包器会检查 Sigrok 构建记录的 Python 动态库与打包解释器一致，并在 macOS/Linux/Windows 目标布局中重定位依赖。当前 macOS arm64 验证使用 CPython 3.14.6；不能据此承诺其他平台已经验证。

不应从 Logic 2 安装包复制 `saleae` 私有模块。扩展自身的许可证仍由扩展作者/分发者负责。

## 验证记录

当前已验证：

- Python 宿主单元测试 22 项；
- 前端测试 223 项；
- `cargo test -p sigpilot-core --lib`：129 项通过，22 项环境相关测试忽略；
- `cargo test -p sigpilot-graph --lib`：94 项通过，6 项环境相关测试忽略；
- UART/I2C/SPI 原始 FrameV2 → HLA 回环；
- HLA 设置覆盖、状态保持、重复运行和异常传播；
- 使用第三方本地扩展（QST sensor decoders 的 QMI8660，旧式 `__new__(cls, settings)`）验证设置发现、实例化与 I2C 帧解码；
- 分析器渲染失败隔离：一个分析器报错时，其余分析器与波形瓦片仍在同一帧内返回；
- 真实 GraphSession 全采集缓存、跨视口复用、轨道/表格结果和设置变更失效；
- macOS arm64 共享运行时 manifest、组合 smoke、归档安装和依赖重定位检查；
- 桌面端 `cargo check -p sigpilot-desktop`、前端生产构建和 `tsc --noEmit`。

尚未在本机完成 Windows、Linux、macOS Intel 和无 Homebrew 机器的实际运行；CI 提供对应布局和 smoke 流程，但跨平台结果不能由本机验证替代。
