# sigrok 设备层抽象参考

面向"能否借鉴 sigrok 统一多厂商逻辑分析仪硬件的接口设计，以及对本项目 Rust trait 的参考价值"。
所有结论标注源码位置；**未验证项单独列出**，不做推断性断言。

- 源码基线：`sigrokproject/libsigrok`，`master` 分支，拉取于 2026-09-29
- 本地副本：`/tmp/sigrok-ref/libsigrok-master/`（如需长期保留，应移入 `vendor/` 或另行 checkout）
- 规模：`src/` + `include/` 共 **395 个 C 文件、181,843 行**
- 驱动规模：`src/hardware/` 下 **87 个驱动**，其中 **28 个声明 `SR_CONF_LOGIC_ANALYZER`**

---

## 0. 结论先行

| 问题 | 结论 |
| --- | --- |
| sigrok 如何统一 87 种硬件？ | 靠**五层抽象**：驱动 vtable、设备实例、通道/通道组、**配置键值接口**、datafeed 数据流。见 §1–§2 |
| 哪一层是真正的统一机制？ | **配置键值接口**（`config_get/set/list` + `SR_CONF_*` + 能力位）。没有它，逻辑分析仪、示波器、万用表、电源不可能共用一个 vtable。见 §2.4 |
| 设备驱动是运行时插件吗？ | **不是。编译期静态链接，全仓库无 `dlopen` / `g_module_open` / `LoadLibrary`。** 见 §4 |
| `api_version` 是版本兼容机制吗？ | **不是。** 全仓库只有 1 处校验，且只判断 `< 1`，实质是"结构体字段填了没"的完整性检查。见 §4.3 |
| 对本项目 Rust trait 的参考价值 | **控制面高价值、可抄；数据面必须偏离。** 见 §6 |
| 接入成本 | sigrok vtable 与目标 Rust trait 近乎 1:1，**一个适配器即可接入 28 个逻辑分析仪驱动**，而非 28 个。见 §7 |

**一句话**：sigrok 的设备层是一个经过 15 年、87 个驱动验证的**控制面协议**，值得借鉴其形状；
但它的**数据面是打包样本模型，比本项目现有的转移索引模型更差**，不应照搬。

---

## 1. 五层抽象总览

| 层 | 类型 | 公开性 | 职责 |
| --- | --- | --- | --- |
| 1 | `struct sr_dev_driver` | 公开 | 驱动 vtable：14 个函数指针 |
| 2 | `struct sr_dev_inst` | **不透明** | 设备实例：厂商/型号/序列号/通道/通道组 |
| 3 | `struct sr_channel` / `sr_channel_group` | 公开 | 通道与其分组（共享属性的通道集合） |
| 4 | `config_get` / `config_set` / `config_list` | 公开 | **配置键值接口 —— 统一异构设备的核心** |
| 5 | `struct sr_datafeed_packet` | 公开 | 设备无关的输出数据流（含 transform 链） |

`sr_dev_inst` 在公开头文件 `include/libsigrok/libsigrok.h:1278` 只有前向声明：

```c
struct sr_dev_inst;
```

完整定义在内部头 `src/libsigrok-internal.h`。**消费者只能通过 `sr_dev_inst_*_get()` 访问器读字段**
（见 §5），这是刻意的封装：驱动可以自由改内部结构，消费者不受影响。

---

## 2. 逐层定义

### 2.1 `sr_dev_driver` —— 驱动 vtable

`include/libsigrok/libsigrok.h:1309`，逐字引用：

```c
struct sr_dev_driver {
	/* Driver-specific */
	const char *name;
	const char *longname;
	int api_version;                                   /* currently 1 */

	int (*init) (struct sr_dev_driver *driver, struct sr_context *sr_ctx);
	int (*cleanup) (const struct sr_dev_driver *driver);
	GSList *(*scan) (struct sr_dev_driver *driver, GSList *options);
	GSList *(*dev_list) (const struct sr_dev_driver *driver);
	int (*dev_clear) (const struct sr_dev_driver *driver);

	int (*config_get) (uint32_t key, GVariant **data,
			const struct sr_dev_inst *sdi,
			const struct sr_channel_group *cg);
	int (*config_set) (uint32_t key, GVariant *data,
			const struct sr_dev_inst *sdi,
			const struct sr_channel_group *cg);
	int (*config_channel_set) (const struct sr_dev_inst *sdi,
			struct sr_channel *ch, unsigned int changes);
	int (*config_commit) (const struct sr_dev_inst *sdi);
	int (*config_list) (uint32_t key, GVariant **data,
			const struct sr_dev_inst *sdi,
			const struct sr_channel_group *cg);

	/* Device-specific */
	int (*dev_open) (struct sr_dev_inst *sdi);
	int (*dev_close) (struct sr_dev_inst *sdi);
	int (*dev_acquisition_start) (const struct sr_dev_inst *sdi);
	int (*dev_acquisition_stop) (struct sr_dev_inst *sdi);

	/* Dynamic */
	void *context;
};
```

**必需 vs 可选**：`src/backend.c` 的驱动校验函数（`Sanity-check all libsigrok drivers`，约 `:300`）
逐项检查以下指针非空，缺失即计入 `errors`：

> `name`、`longname`、`api_version`、`init`、`cleanup`、`scan`、`dev_list`、`dev_clear`、
> `config_set`、`config_list`、`dev_open`、`dev_close`、`dev_acquisition_start`、`dev_acquisition_stop`

**可选**（未被校验）：`config_get`、`config_channel_set`、`config_commit`。

> 值得注意：**`config_get` 是可选的**——即一个驱动可以只写不读。

### 2.2 `sr_dev_inst` —— 设备实例

`src/libsigrok-internal.h`，逐字引用：

```c
struct sr_dev_inst {
	struct sr_dev_driver *driver;
	int status;                 /* SR_ST_NOT_FOUND, etc. */
	int inst_type;              /* SR_INST_USB, etc. */
	char *vendor;
	char *model;
	char *version;
	char *serial_num;
	char *connection_id;        /* 唯一标识设备的连接串 */
	GSList *channels;
	GSList *channel_groups;
	void *conn;
	void *priv;
	struct sr_session *session;
};
```

相关枚举（`libsigrok.h:1281` / `:1295`）：

```c
enum sr_dev_inst_type {
	SR_INST_USB = 10000, SR_INST_SERIAL, SR_INST_SCPI,
	SR_INST_USER, SR_INST_MODBUS,
};

enum sr_dev_inst_status {
	SR_ST_NOT_FOUND = 10000, SR_ST_INITIALIZING,
	SR_ST_INACTIVE, SR_ST_ACTIVE, SR_ST_STOPPING,
};
```

**`connection_id` 是一个值得抄的设计**：驱动为每台设备生成一个稳定唯一串（USB 用 bus/address，
串口用 `/dev/ttyUSB0`，网络用 `host:port`），宿主据此做"上次用的是哪台设备"的记忆。

### 2.3 `sr_channel` / `sr_channel_group` —— 通道与通道组

`libsigrok.h:639` / `:656`：

```c
struct sr_channel {
	struct sr_dev_inst *sdi;
	int index;              /* 从 0 起；SR_DF_LOGIC 包内按此索引编码 */
	int type;               /* SR_CHANNEL_LOGIC / SR_CHANNEL_ANALOG */
	gboolean enabled;
	char *name;
	void *priv;
};

struct sr_channel_group {
	char *name;
	GSList *channels;
	void *priv;
};
```

通道类型只有两种（`libsigrok.h:631`）：

```c
enum sr_channeltype {
	SR_CHANNEL_LOGIC = 10000,
	SR_CHANNEL_ANALOG,
};
```

**`channel_group` 解决的是真实硬件问题**：MSO 的数字 pod（如 `P0–P7`）作为一个 bank 共享
逻辑阈值、示波器的多个通道共享时基。没有这一层，就只能把这类"组级配置"塞进设备级，
表达力不足。

通道启用状态变更走独立的 `config_channel_set`，带一个 `changes` 位掩码
（`src/libsigrok-internal.h:1714`）：

```c
enum { SR_CHANNEL_SET_ENABLED = 1 << 0 };
```

### 2.4 配置键值接口 —— 统一异构设备的核心

这是整个设计的支点。三个函数共用一套签名（`proto.h`）：

```c
SR_API int sr_config_get (const struct sr_dev_driver *driver,
		const struct sr_dev_inst *sdi, const struct sr_channel_group *cg,
		uint32_t key, GVariant **data);
SR_API int sr_config_set (const struct sr_dev_inst *sdi,
		const struct sr_channel_group *cg,
		uint32_t key, GVariant *data);
SR_API int sr_config_list(const struct sr_dev_driver *driver,
		const struct sr_dev_inst *sdi, const struct sr_channel_group *cg,
		uint32_t key, GVariant **data);
```

**键空间**：`enum sr_configkey`（`libsigrok.h:704`）定义 **115 个去重后的 `SR_CONF_*` 键**，
按数值区间分组：

| 区间 | 含义 | 例 |
| --- | --- | --- |
| 10000+ | 设备类别 | `SR_CONF_LOGIC_ANALYZER`、`SR_CONF_OSCILLOSCOPE`、`SR_CONF_MULTIMETER` |
| 20000+ | 驱动扫描选项 | `SR_CONF_CONN`、`SR_CONF_SERIALCOMM`、`SR_CONF_PROBE_NAMES` |
| 30000+ | 设备/通道组配置 | `SR_CONF_SAMPLERATE`、`SR_CONF_BUFFERSIZE`、`SR_CONF_VOLTAGE_THRESHOLD` |
| 40000+ | 特殊项 | `SR_CONF_CAPTURE_UNITSIZE`、`SR_CONF_DATA_SOURCE` |
| 50000+ | 采集模式与样本上限 | `SR_CONF_LIMIT_MSEC`、`SR_CONF_LIMIT_SAMPLES`、`SR_CONF_CONTINUOUS` |

**能力位**（`libsigrok.h:694`）——注意它们占用键的高 3 位：

```c
enum sr_configcap {
	SR_CONF_GET  = (1UL << 31),
	SR_CONF_SET  = (1UL << 30),
	SR_CONF_LIST = (1UL << 29),
};
```

因此分离键与能力的掩码是 `SR_CONF_MASK = 0x1fffffff`（`src/libsigrok-internal.h:1711`）。

**两个自省键**（`src/libsigrok-internal.h:1705` / `:1708`）：

```c
#define SR_CONF_SCAN_OPTIONS   0x7FFF0000   /* 该驱动支持的扫描选项 */
#define SR_CONF_DEVICE_OPTIONS 0x7FFF0001   /* 该设备支持的配置项 */
```

驱动通过 `config_list(SR_CONF_DEVICE_OPTIONS)` **报出自己支持哪些键、各自允许哪些操作**。
宿主在每次 `get/set/list` 前调用 `check_key()`（`src/hwdriver.c:720`）做运行时校验：

```c
/* 1. 从驱动拿到它支持的选项列表 */
if (sr_config_list(driver, sdi, cg, SR_CONF_DEVICE_OPTIONS, &gvar_opts) != SR_OK) {
	sr_err("No options available%s.", suffix);
	return SR_ERR_ARG;
}
opts = g_variant_get_fixed_array(gvar_opts, &num_opts, sizeof(uint32_t));
pub_opt = 0;
for (i = 0; i < num_opts; i++) {
	if ((opts[i] & SR_CONF_MASK) == key) {   /* 掩掉能力位后比对键 */
		pub_opt = opts[i];
		break;
	}
}
if (!pub_opt) { sr_err("Option '%s' not available%s.", srci->id, suffix); return SR_ERR_ARG; }
/* 2. 检查该操作是否被允许 */
if (!(pub_opt & op)) { sr_err("Option '%s' not available to %s%s.", ...); return SR_ERR_ARG; }
```

**键的人类可读元数据单独存放**，不污染驱动：`src/hwdriver.c:49` 的
`static struct sr_key_info sr_key_info_config[]`，每项形如：

```c
{SR_CONF_SAMPLERATE, SR_T_UINT64, "samplerate", "Sample rate", NULL},
```

结构（`libsigrok.h:680`）：

```c
struct sr_key_info {
	uint32_t key;
	int datatype;          /* SR_T_STRING / SR_T_UINT64 / SR_T_BOOL / SR_T_FLOAT ... */
	const char *id;        /* 短 ID，如 "samplerate" */
	const char *name;      /* 全名，如 "Sample rate" */
	const char *description;   /* 注释说 "unused currently" */
};
```

**这套设计的效果**：驱动只需实现"给我一个键、我给你一个值"，宿主与 UI 完全不需要知道
设备是什么型号。新增一种硬件，UI 一行不改。

**代价**：接口在边界上是**无类型的**（`uint32_t key` + `GVariant`），因此必须额外维护
`sr_key_info_config[]` 元数据表 + `check_key()` 校验器，把类型错误从编译期推迟到运行期。
**这一条在 Rust 里可以直接消除**（见 §6.2）。

### 2.5 `sr_datafeed_packet` —— 设备无关数据流

`libsigrok.h:494`：

```c
struct sr_datafeed_packet {
	uint16_t type;
	const void *payload;
};

struct sr_datafeed_header {          /* :500 */
	int feed_version;
	struct timeval starttime;
};

struct sr_datafeed_meta {            /* 载荷为配置项列表 */
	GSList *config;
};

struct sr_datafeed_logic {           /* :511 */
	uint64_t length;
	uint16_t unitsize;
	void *data;
};

struct sr_datafeed_analog {          /* :518 */
	void *data;
	uint32_t num_samples;
	struct sr_analog_encoding *encoding;
	struct sr_analog_meaning *meaning;
	struct sr_analog_spec *spec;
};
```

包类型（`libsigrok.h:162`）：

```c
enum sr_packettype {
	SR_DF_HEADER = 10000, SR_DF_END, SR_DF_META, SR_DF_TRIGGER,
	SR_DF_LOGIC, SR_DF_FRAME_BEGIN, SR_DF_FRAME_END, SR_DF_ANALOG,
};
```

**transform 链**（`src/session.c:1124` `sr_session_send()`）：驱动发出的包会先经过
会话上注册的 transform 模块链，每级可改写或吞掉包，最后才分发给所有 datafeed 回调：

```c
packet_in = (struct sr_datafeed_packet *)packet;
for (l = sdi->session->transforms; l; l = l->next) {
	t = l->data;
	ret = t->module->receive(t, packet_in, &packet_out);
	if (ret < 0) { sr_err("Error while running transform module: %d.", ret); return SR_ERR; }
	if (!packet_out) return SR_OK;      /* transform 吞掉了包 */
	packet_in = packet_out;
}
packet = packet_in;
for (l = sdi->session->datafeed_callbacks; l; l = l->next) {
	cb_struct = l->data;
	cb_struct->cb(sdi, packet, cb_struct->cb_data);
}
```

---

## 3. 生命周期与调用顺序

```
sr_init(ctx)
  └─ sr_drivers_init()          迭代链接段，建立驱动表
       └─ 每个驱动 sr_driver_init(ctx, driver)   → driver->init(ctx)
            └─ sr_driver_scan(driver, options)   → driver->scan()  → sr_dev_inst[]
                 └─ sr_session_dev_add(session, sdi)
                      └─ sr_dev_open(sdi)        → driver->dev_open()
                           ├─ sr_config_get/set/list  → 只改内存
                           ├─ sr_config_commit(sdi)   → driver->config_commit()  落硬件
                           ├─ sr_session_start(session)
                           │    └─ driver->dev_acquisition_start()
                           │         └─ driver 通过 sr_session_send() 推 datafeed 包
                           │              → transform 链 → 所有 datafeed 回调
                           └─ sr_session_stop()  → driver->dev_acquisition_stop()
                                └─ sr_dev_close(sdi) → driver->dev_close()
sr_exit(ctx) → driver->cleanup()
```

**`config_commit` 是最值得抄的一点**：`config_set` 只改内存，`config_commit` 才落到硬件。
这避免了"用户每拖一次采样率滑块就打一次 USB"。

---

## 4. 注册与构建机制

### 4.1 链接段自注册

`src/libsigrok-internal.h:1202`：

```c
#define SR_REGISTER_DEV_DRIVER(name) \
	SR_REGISTER_DEV_DRIVER_LIST(name##_list, &name);

#define SR_REGISTER_DEV_DRIVER_LIST(name, ...) \
	static const struct sr_dev_driver *name[] \
		SR_DRIVER_LIST_NOREORDER \
		__attribute__((section (SR_DRIVER_LIST_SECTION), used, \
			aligned(sizeof(struct sr_dev_driver *)))) \
		= { __VA_ARGS__ };
```

段名（`internal.h:1131`，macOS 需双段式写法）：

```c
#ifdef __APPLE__
#define SR_DRIVER_LIST_SECTION "__DATA,__sr_driver_list"
#else
#define SR_DRIVER_LIST_SECTION "__sr_driver_list"
#endif
```

迭代（`src/drivers.c`）：

```c
SR_PRIV extern const struct sr_dev_driver *sr_driver_list__start[];
SR_PRIV extern const struct sr_dev_driver *sr_driver_list__stop[];

SR_API void sr_drivers_init(struct sr_context *ctx) {
	GArray *array = g_array_new(TRUE, FALSE, sizeof(struct sr_dev_driver *));
#ifdef HAVE_DRIVERS
	for (const struct sr_dev_driver **drivers = sr_driver_list__start + 1;
	     drivers < sr_driver_list__stop; drivers++)
		g_array_append_val(array, *drivers);
#endif
	ctx->driver_list = (struct sr_dev_driver **)g_array_free(array, FALSE);
}
```

> `sr_driver_list__start` 由单独的 `src/driver_list_start.c` 提供（一个 `NULL` 哨兵项），
> 注释要求"必须链接在任何实际驱动之前"。

### 4.2 关键事实：没有运行时插件加载

| 检查项 | 结果 |
| --- | --- |
| `dlopen` / `g_module_open` / `LoadLibrary` 在 `src/hwdriver.c`、`src/drivers.c`、`src/backend.c` | **0 处** |
| 87 个驱动的纳入方式 | 全部显式列在顶层 `Makefile.am` 的 `libsigrok_la_SOURCES`，用 `if HW_XXX` 条件编译 |
| 驱动列表来源 | 主二进制的 `__sr_driver_list` 链接段（`__start`/`__stop` 只覆盖主二进制） |

**结论：sigrok 的设备驱动是编译期静态链接的。第三方要加驱动，必须合入上游并重新编译，
没有运行时插件机制。**

这一点在评估"开放设备层"时是决定性证据。加上另两个数据点：

| 生态 | 设备层开放度 |
| --- | --- |
| Saleae | 明确不开放。官方文档：extension API "does not open how data arrives. There is no device, transport, importer, trigger, or UI extension point at any layer."（引自 `docs/reuse-vs-rebuild-decision.md`） |
| sigrok（87 驱动 / 28 个 LA） | 抽象干净，但**静态链接**，无运行时插件 |
| pxlogic（本项目） | 目前硬编码 1 个设备族（`PXLOGIC_DEVICE_PROFILES`） |

**成熟栈的设备层从来是"策展"而非"开放"的。这不是技术做不到，是刻意的产品选择——
驱动直接碰硬件，质量与安全责任无法下放。**

### 4.3 `api_version` 的真实作用

全仓库检索 `api_version` 的结果：

| 位置 | 内容 |
| --- | --- |
| `include/libsigrok/libsigrok.h:1316` | 字段声明 `int api_version;` |
| `src/hardware/` 下 **92 处** `.api_version = 1` | 全部赋值为 `1`，无一处例外 |
| **`src/backend.c:329`** | **唯一的读取点** |

```c
if (drivers[i]->api_version < 1) {
	sr_err("API version in driver %d ('%s') < 1.", i, d);
	errors++;
}
```

**它是一个"结构体字段填了没"的完整性检查，不是版本兼容机制。** 没有任何代码按
`api_version` 分支行为、拒绝加载、或做能力协商。**不要把这个设计当作版本管理的参考。**
（Rust 侧应改用 manifest 中的 `protocol_version` + 能力协商，见 §6.2。）

---

## 5. 公开 API 面（`include/libsigrok/proto.h`）

`proto.h` 共 290 行，全部是**访问器函数**，消费者无法直接触碰结构体字段：

| 类别 | 代表函数 |
| --- | --- |
| 上下文 | `sr_init` / `sr_exit` |
| 驱动表 | `sr_driver_list(ctx)` / `sr_driver_init(ctx, driver)` / `sr_driver_scan_options_list(driver)` / `sr_driver_scan(driver, options)` |
| 设备实例读取 | `sr_dev_inst_vendor_get` / `_model_get` / `_version_get` / `_sernum_get` / `_connid_get` / `_channels_get` / `_channel_groups_get` / `_driver_get` |
| 设备实例构造 | `sr_dev_inst_user_new(vendor, model, version)` / `sr_dev_inst_channel_add(sdi, index, type, name)` |
| 设备控制 | `sr_dev_open` / `sr_dev_close` / `sr_dev_list` / `sr_dev_clear` / `sr_dev_has_option(sdi, key)` / `sr_dev_options(driver, sdi, cg)` / `sr_dev_config_capabilities_list(sdi, cg, key)` |
| 通道 | `sr_dev_channel_name_set` / `sr_dev_channel_enable(channel, state)` |
| 配置 | `sr_config_get` / `sr_config_set` / `sr_config_commit` / `sr_config_list` / `sr_key_info_get` / `sr_key_info_name_get` |
| 会话 | `sr_session_new` / `_destroy` / `_dev_add` / `_dev_remove` / `_dev_list` / `_trigger_set` / `_datafeed_callback_add` / `_datafeed_callback_remove_all` / `_start` / `_run` / `_stop` / `_is_running` / `_stopped_callback_set` |
| 包 | `sr_packet_copy` / `sr_packet_free` |
| 输入/输出/transform | `sr_input_*` / `sr_output_*` / `sr_transform_*` 各自的 `_list` / `_find` / `_id_get` / `_options_get` / `_new` |
| 触发 | `sr_trigger_new` / `_stage_add` / `_match_add` |
| 资源（固件等） | `sr_resourcepaths_get` / `sr_resource_set_hooks` |

**`sr_resource_set_hooks` 值得注意**：驱动通过它请求固件/位流文件，宿主决定这些文件
从哪来（本地路径、打包资源、网络）。本项目目前用环境变量
（`SIGPILOT_BITSTREAM_DIR` / `SIGPILOT_FPGA_RESET` / `SIGPILOT_FPGA_MAIN`），
sigrok 的做法更可移植。

---

## 6. 与本项目（SigPilot）的对照

### 6.1 逐项取舍

| sigrok 概念 | Rust 对应物 | 取舍 |
| --- | --- | --- |
| `sr_dev_driver` vtable | `DeviceDriver` trait | **形状可抄** |
| `SR_CONF_*` + `GVariant` 能力协商 | 类型化 `OptionValue` + `OptionCaps` | **改造后抄**（去掉运行时元数据表与 `check_key`） |
| `config_commit` 先攒后提交 | `OpenDevice::commit()` | **直接抄** |
| `sr_channel_group` | `ChannelGroup` | **直接抄** |
| `connection_id` | `DeviceId` 稳定串 | **直接抄** |
| `SR_DF_LOGIC` 打包样本 | `SparseSink` 转移索引 | **不要抄** |
| 链接段静态注册 | 清单 + sidecar 运行时注册 | **不要抄** |
| `void *priv` / `void *conn` | 关联类型 / 每驱动具体类型 | **改造后抄** |
| `api_version: int` | manifest `protocol_version` + 能力协商 | **不要抄** |
| `GSList` / `gboolean` / 手动内存 | 标准容器 / `bool` | **不要抄** |
| 进程内运行驱动 | sidecar 隔离 | **不要抄**（本项目已为解码器做过此决定） |

### 6.2 Rust trait 草案

```rust
// ── 能力声明：可序列化，同时驱动 UI 与 sidecar 握手 ──────────────
#[derive(Serialize, Deserialize, Clone)]
pub struct DeviceDescriptor {
    pub driver_id: String,          // "pxlogic" / "sigrok" / "vendor-x"
    pub protocol_version: u32,      // 取代 sr_dev_driver.api_version
    pub vendor: String,
    pub model: String,
    pub channels: Vec<ChannelDescriptor>,
    pub channel_groups: Vec<ChannelGroup>,   // 抄 sigrok：MSO bank / 共享阈值
    pub options: Vec<OptionDescriptor>,      // 取代全局扁平的 SR_CONF_*
    pub isolation: Isolation,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
pub enum Isolation { InProcess, Sidecar }   // 第一方 / 第三方，宿主据此决定是否起进程

#[derive(Serialize, Deserialize, Clone)]
pub struct ChannelDescriptor {
    pub index: u8,
    pub kind: ChannelKind,      // Logic | Analog
    pub name: String,
    pub default_enabled: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChannelGroup { pub name: String, pub channels: Vec<u8> }

// ── 配置：键是驱动私有命名空间，值是类型化的 ─────────────────────
#[derive(Serialize, Deserialize, Clone)]
pub struct OptionDescriptor {
    pub key: String,            // "samplerate" / "logic_threshold"
    pub label: String,          // UI 用，取代 sr_key_info 运行时元数据表
    pub value: OptionValue,
    pub caps: OptionCaps,
}

#[derive(Serialize, Deserialize, Clone)]
pub enum OptionValue {
    Bool(bool),
    Uint(u64),
    Float(f64),
    Text(String),
    Choice(Vec<String>),
    UintCandidates(Vec<u64>),   // 对应 sr_config_list 的候选值枚举
}

bitflags::bitflags! {
    #[derive(Serialize, Deserialize)]
    pub struct OptionCaps: u8 { const GET = 1; const SET = 2; const LIST = 4; }
}

// ── 驱动本体 ───────────────────────────────────────────────────
pub trait DeviceDriver: Send + Sync {
    fn descriptor(&self) -> &DeviceDescriptor;

    /// 对应 sr_dev_driver::scan
    fn scan(&self, options: &ScanOptions) -> Result<Vec<DeviceInstance>>;

    /// 对应 dev_open
    fn open(&self, id: &DeviceId) -> Result<Box<dyn OpenDevice>>;
}

/// 已打开的设备：配置 + 采集。一个设备实例一个对象，取代 `void *priv`。
pub trait OpenDevice: Send {
    fn get_option(&self, key: &str) -> Result<OptionValue>;
    fn set_option(&mut self, key: &str, value: OptionValue) -> Result<()>;
    fn list_option(&self, key: &str) -> Result<Option<OptionValue>>;

    /// 抄 sigrok 的 config_commit：先攒后提交
    fn commit(&mut self) -> Result<()>;

    fn start(&mut self, settings: &CaptureSettings, sink: &mut dyn SparseSink) -> Result<()>;
    fn stop(&mut self) -> Result<()>;
}

/// 刻意偏离 sigrok：输出转移索引，不是打包样本
pub trait SparseSink {
    fn begin(&mut self, metadata: &CaptureMetadata);
    fn push(&mut self, channel: u8, initial_high: bool, transitions: &[u64]);
    fn end(&mut self);
}
```

**Rust 相对 C 直接消除的三项成本：**

1. `OptionValue` enum 取代 `uint32_t key` + `GVariant` → 不再需要
   `sr_key_info_config[]` 元数据表（`hwdriver.c:49`）与 `check_key()` 校验器（`hwdriver.c:720`），
   类型校验交给编译器。
2. `OptionCaps` bitflags 取代 `SR_CONF_GET = 1<<31` 高位编码 → 不再需要
   `SR_CONF_MASK`（`internal.h:1711`）这类手工位运算。
3. 键用 `String` 而非全局枚举 → sigrok 的 `SR_CONF_*` 已涨到 115 个键，
   因为它要同时覆盖 LA / 示波器 / 万用表 / 电源 / LCR / 信号源。
   **逻辑分析仪专用软件不需要这个跨度**，应为「小核心 + 驱动私有命名空间」。

### 6.3 为什么数据面必须偏离 sigrok

```c
struct sr_datafeed_logic {
	uint64_t length;
	uint16_t unitsize;      /* ← 打包样本 */
	void *data;
};
```

这与本项目正想摆脱的 `CaptureData { samples: Vec<u8>, metadata.unitsize }` **形状完全一致**。

而本项目已有更好的模型：

- `SparseCaptureData { channel, initial_high, transitions: Vec<u64> }` —— **与通道数无关**
- `DigitalGraph::from_sparse_capture()`（`crates/sigpilot-graph/src/lib.rs:360`）已在消费它
- 真实硬件路径已在用：`src-tauri/src/main.rs:770 GraphSession::replace_sparse_capture`

**sigrok 的打包模型对长采集是线性内存占用；本项目的转移索引是稀疏的——
这是本项目做 32ch 长采集的核心优势，不应为"与 sigrok 一致"而放弃。**

---

## 7. 接入 libsigrok 的可行性

### 7.1 成本：一个适配器，不是 28 个

sigrok 的 vtable 与 §6.2 的 Rust trait 近乎 1:1 对应：

| sigrok | Rust trait 方法 |
| --- | --- |
| `init` / `cleanup` | `DeviceDriver` 的构造与 `Drop` |
| `scan` / `dev_list` / `dev_clear` | `scan()` |
| `dev_open` / `dev_close` | `open()` / `OpenDevice` 的 `Drop` |
| `config_get` / `config_set` / `config_list` | `get_option` / `set_option` / `list_option` |
| `config_commit` | `commit()` |
| `dev_acquisition_start` / `_stop` | `start()` / `stop()` |
| `SR_DF_LOGIC` 包 | 需在适配器内转成 `SparseSink::push`（见 7.3） |

**因此写一个 `SigrokDriver: DeviceDriver` 适配器，即可一次性接入 28 个逻辑分析仪驱动**，
而不是写 28 个适配器。

### 7.2 授权与隔离

- libsigrok 是 **GPL-3.0-or-later**（`COPYING`）
- 本项目主仓库是 MIT/Apache，且已确立「GPL 只放独立 sidecar」的先例
  （`native/sigrok-analyzer-sidecar` 自带独立 LICENSE）
- **因此该适配器必须放在 GPL sidecar 内**，通过 §6.2 的 `Isolation::Sidecar` 与宿主通信

### 7.3 唯一需要真正做工作的部分：packed → sparse 转换

适配器需要把 sigrok 的 `SR_DF_LOGIC` 打包样本转成本项目的转移索引。两种做法：

| 做法 | 代价 |
| --- | --- |
| 在 sidecar 内扫一遍样本、提取边沿、只回传转移 | sidecar CPU 开销；但网络/进程传输量下降 1–2 个数量级 |
| 原样回传打包样本，宿主侧扫边沿 | 传输量大；但 sidecar 逻辑最简 |

**建议取前者**：与 §「数据面搬转移索引」的结论一致，且 sigrok 驱动本身通常已经
在设备侧做了边沿/RLE 处理（如 `SR_CONF_RLE`），在 sidecar 内提取边沿不会引入额外瓶颈。

### 7.4 直接可用的 LA 驱动（28 个）

其中与项目定位相关的重点项：

| 驱动 | 说明 |
| --- | --- |
| `saleae-logic16` / `saleae-logic-pro` | **sigrok 已有 Saleae 驱动** |
| `fx2lafw` | 覆盖大量 FX2 系开源 LA（最广谱的一个） |
| `kingst-la2016` | Kingst |
| `dreamsourcelab-dslogic` | DreamSourceLab |
| `zeroplus-logic-cube` | Zeroplus |
| `chronovu-la` / `sysclk-sla5032` / `sysclk-lwla` | ChronoVu / Sysclk |
| `beaglelogic` / `openbench-logic-sniffer` / `pipistrello-ols` | 开源硬件 |
| `ftdi-la` / `greatfet` / `microchip-pickit2` / `raspberrypi-pico` | 通用/开发板 |
| `ikalogic-scanalogic2` / `ikalogic-scanaplus` / `ipdbg-la` / `hantek-4032l` / `asix-sigma` / `link-mso19` / `lecroy-logicstudio` / `lascar-el-usb` | 其它 |

完整 87 个驱动清单见附录 A。

---

## 8. 未验证 / 需进一步核实

| # | 待核实 | 为什么重要 |
| --- | --- | --- |
| 1 | 28 个 LA 驱动中，**实际在 macOS arm64 上能跑的有几个**（部分依赖 libusb 权限、FTDI 内核扩展、或仅 Windows 驱动） | 直接决定"接 sigrok 能拿到多少真实设备" |
| 2 | 各 LA 驱动的**边沿/RLE 能力差异**（是否都支持 `SR_CONF_RLE`，是否都在设备侧预处理） | 决定 §7.3 的转换开销 |
| 3 | libsigrok 的 `GSList`/`GVariant`（glib）依赖在 sidecar 内的打包成本 | 决定 sidecar 体积与交叉编译复杂度 |
| 4 | 本项目 `SparseCaptureData` 的 `sample_count` 上限与 sigrok `uint64_t length` 的语义对齐 | 决定长采集（>2^32 样本）转换是否安全 |
| 5 | `sr_session_send` 的 transform 链在本项目是否需要等价物 | 若需要，属于数据面的额外设计 |
| 6 | 87 个驱动中非 LA 类别（DMM/示波器/电源等）是否值得接入 | 影响 `DeviceClass` 是否需要预留多值 |

---

## 附录 A：87 个驱动清单

（28 个逻辑分析仪驱动以 **粗体** 标注）

agilent-dmm, appa-55ii, arachnid-labs-re-load-pro, asix-omega-rtm-cli, **asix-sigma**,
atorch, atten-pps3xxx, baylibre-acme, **beaglelogic**, bkprecision-1856d, cem-dt-885x,
center-3xx, **chronovu-la**, colead-slm, conrad-digi-35-cpu, dcttech-usbrelay,
**demo**, **dreamsourcelab-dslogic**, devantech-eth008, fluke-45, fluke-dmm,
**ftdi-la**, **fx2lafw**, gmc-mh-1x-2x, **greatfet**, gwinstek-gds-800, gwinstek-gpd,
gwinstek-psp, **hameg-hmo**, **hantek-4032l**, hantek-6xxx, hantek-dso, hp-3457a,
hp-3478a, hp-59306a, hung-chang-dso-2100, icstation-usbrelay,
**ikalogic-scanalogic2**, **ikalogic-scanaplus**, **ipdbg-la**, itech-it8500,
juntek-jds6600, kecheng-kc-330b, kern-scale, **kingst-la2016**, korad-kaxxxxp,
lascar-el-usb, **lecroy-logicstudio**, lecroy-xstream, **link-mso19**, manson-hcs-3xxx,
mastech-ms6514, maynuo-m97, **microchip-pickit2**, mic-985xx, mooshimeter-dmm,
motech-lps-30x, norma-dmm, **openbench-logic-sniffer**, pce-322a, **pipistrello-ols**,
**raspberrypi-pico**, rdtech-dps, rdtech-tc, rdtech-um, rigol-dg, rigol-ds,
rohde-schwarz-sme-0x, **saleae-logic-pro**, **saleae-logic16**, scpi-dmm, scpi-pps,
serial-dmm, serial-lcr, siglent-sdl10x0, **siglent-sds**, **sysclk-lwla**,
**sysclk-sla5032**, teleinfo, testo, tondaj-sl-814, uni-t-dmm, uni-t-ut181a,
uni-t-ut32x, **yokogawa-dlm**, **zeroplus-logic-cube**, zketech-ebd-usb

> 注：清单由 `src/hardware/` 目录列表与 `grep -rl SR_CONF_LOGIC_ANALYZER` 得出，
> 共 87 个目录、28 个 LA。部分驱动一个目录内含多个 `sr_dev_driver` 实例
> （如 `scpi-pps`、`serial-dmm`），因此**实际驱动实例数多于 87**。

---

## 附录 B：源码索引（关键位置）

| 内容 | 位置 |
| --- | --- |
| `sr_dev_driver` 定义 | `include/libsigrok/libsigrok.h:1309` |
| `sr_dev_inst` 完整定义 | `src/libsigrok-internal.h` |
| `sr_dev_inst` 公开前向声明 | `include/libsigrok/libsigrok.h:1278` |
| `sr_channel` / `sr_channel_group` | `include/libsigrok/libsigrok.h:639` / `:656` |
| `enum sr_channeltype` | `include/libsigrok/libsigrok.h:631` |
| `sr_config` / `sr_key_info` | `include/libsigrok/libsigrok.h:666` / `:680` |
| `enum sr_configcap` | `include/libsigrok/libsigrok.h:694` |
| `enum sr_configkey`（115 个键） | `include/libsigrok/libsigrok.h:704` |
| `SR_CONF_SCAN_OPTIONS` / `_DEVICE_OPTIONS` / `SR_CONF_MASK` | `src/libsigrok-internal.h:1705` / `:1708` / `:1711` |
| `SR_CHANNEL_SET_ENABLED` | `src/libsigrok-internal.h:1714` |
| datafeed 结构体 | `include/libsigrok/libsigrok.h:494`–`:518` |
| `enum sr_packettype` | `include/libsigrok/libsigrok.h:162` |
| 驱动注册宏 | `src/libsigrok-internal.h:1172` / `:1202` |
| 链接段名 | `src/libsigrok-internal.h:1131` |
| 段起始哨兵 | `src/driver_list_start.c` |
| 驱动表迭代 | `src/drivers.c` |
| 配置键元数据表 | `src/hwdriver.c:49` |
| `check_key()` 能力校验 | `src/hwdriver.c:720` |
| `sr_config_get/set/list` | `src/hwdriver.c:820` / `:875` / `:963` |
| `sr_session_send()` transform 链 | `src/session.c:1124` |
| `api_version` 唯一校验点 | `src/backend.c:329` |
| 驱动必需方法校验 | `src/backend.c` 约 `:300` 起 |
| 公开 API 面 | `include/libsigrok/proto.h`（290 行） |
| 驱动构建纳入方式 | `Makefile.am` 的 `libsigrok_la_SOURCES` + `if HW_XXX` |
| 标准驱动辅助库 | `src/std.c`（941 行） |

**参考实现规模**：`src/hardware/demo/`（1534 行）、`src/hardware/fx2lafw/`（1523 行）。
