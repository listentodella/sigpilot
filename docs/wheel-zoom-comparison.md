# 滚轮缩放倍率对比：Logic 2 vs pxlogic

对"pxlogic 缩放太慢、Logic 2 太快"这一体感的量化对比。
两边的公式都从源码读出并逐项核对，**结论是结构性的，不是调一个常数就能对齐**。

## 1. 两侧的公式

### Logic 2（`saleae-priv/src`）

**归一化**（`app/utils/normalizeWheelEvent.ts`）：

```ts
const expectedTickSize = 120 / zoomFactor;              // zoomFactor = Electron webFrame zoom，通常 1
const isPhysicalWheel = wheelDelta !== 0 && wheelDelta % expectedTickSize === 0;
const normalizedY = Math.round((wheelDeltaY / expectedTickSize) * 120 * gainY);
```

**缩放因子**（`app/hooks/useInteraction.ts:835`）：

```ts
export function calcWheelZoomFactor(normalizedEvent: NormalizeWheelEvent, scale: number = 1) {
  const zoomFactor = Math.pow(
    2,
    ((normalizedEvent.isPhysicalWheel ? 0.5 : 1) * scale * (-1 * normalizedEvent.deltaY)) / WHEEL_DELTA,
  );
  return zoomFactor;
}
```

`WHEEL_DELTA = 120`（`app/utils/defaults.ts:22`）。
水平缩放调用时 `scale = 1`（`SessionStore.wheelHorizontalZoom` → `calcWheelZoomFactor(normalizedEvent)`）；
`scale` 只在**垂直**缩放时被 `e.shiftKey ? 0.1 : 1` 影响（`useInteraction.ts:262`）。

### pxlogic（`src/components/WaveformCanvas.tsx`）

```ts
const delta = normalizeWheelDelta(event.deltaY, event.deltaMode);      // :781
const intensity = event.ctrlKey || event.metaKey || event.altKey ? 0.003 : 0.0015;   // :782
const factor = Math.exp(Math.max(-800, Math.min(800, delta)) * intensity);           // :783
```

```ts
function normalizeWheelDelta(delta: number, deltaMode: number) {       // :1337
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 240;
  return delta;
}
```

## 2. 逐步等价换算

| | Logic 2 | pxlogic |
| --- | --- | --- |
| 曲线 | `2^(x/120)`（**以 2 为底**） | `e^(x·0.0015)`（**自然指数**） |
| 输入单位 | `wheelDelta` 归一化后的**刻度**（物理滚轮固定 ±120/格） | 原始 `deltaY` **像素** |
| **物理滚轮一格** | **2^0.5 = 1.4142（+41.4%）** | 需要 **231 px** 的 deltaY 才等价 |
| 触摸板 | `isPhysicalWheel=false` → 每 120 归一化单位 **×2** | 同上，231 px/格 |
| 翻倍所需 | 物理轮 **166** 归一化单位 | **462 px** |
| 钳制 | 公式内无钳制 | deltaY 钳在 **±800 px**（factor ≤ 3.32） |

**核心数字：Logic 2 的一格 = pxlogic 的 231 px。**

所以 pxlogic 相对慢多少，完全取决于**你的设备一格滚轮产生多少 `deltaY`**：

| 一格 = N px | 该有的 intensity | 相对当前 0.0015 |
| --- | --- | --- |
| 53 | 0.00654 | **4.36×** |
| 77 | 0.00450 | 3.00× |
| 100 | 0.00347 | **2.31×** |
| 120 | 0.00289 | 1.93× |
| 231 | 0.00150 | 1.00×（已等价） |

**如果 macOS 一格约 100 px，pxlogic 比 Logic 2 慢 2.3 倍** —— 与"倍率太低"的体感吻合。

## 3. 五处结构性差异（不是调常数能解决的）

1. **物理滚轮 vs 触摸板：Logic 2 区别对待，pxlogic 不区分。**
   Logic 2 对物理滚轮乘 **0.5**（`isPhysicalWheel ? 0.5 : 1`），触摸板不乘。
   也就是说 **Logic 2 的触摸板缩放比它的滚轮更快**。pxlogic 两条输入走同一公式，
   所以**你用什么设备会得到完全不同的体感**——这很可能是"Logic 2 太快"的来源。

2. **手势分类有去抖。** Logic 2 对触摸板要求**至少 5 个**滚轮事件
   （`WHEEL_MIN_HISTORY_LENGTH = 5`，200 ms 窗口内）才决定是缩放还是平移；
   物理滚轮则直接按 `|deltaY| > |deltaX|` 判定。pxlogic 无此分类。

3. **修饰键：纵向已经一致，横向是"被平移抢走"。**
   | | 变细 | 变粗 |
   | --- | --- | --- |
   | Logic 2 纵向（模拟量幅度） | **Shift = 0.1×** | （无） |
   | Logic 2 横向（时间） | （无，scale 恒为 1） | （无） |
   | pxlogic 纵向（`AnalogWaveformOverlay`） | **Shift = 0.1×** ✅ 已一致 | — |
   | pxlogic 横向（`WaveformCanvas`） | — | **Ctrl/Cmd/Alt = 2×** |

   **修正**：我先前写"两者语义相反"是错的。pxlogic 的**纵向**缩放本来就有
   `scale = shiftKey ? 0.1 : 1`，与 Logic 2 完全一致。真正的差异在**横向**：
   Logic 2 的横向缩放 **Shift 不改变速率**（`scale = 1`），
   而 pxlogic 的横向 **Shift 被平移占用**（`WaveformCanvas.tsx:766`
   `event.shiftKey` → pan 分支），所以横向上按 Shift 根本不会缩放。
   这是需要单独决定的取舍，不属于本次改动。

4. **动画策略不同。** Logic 2 对物理滚轮走 `animateHorizontalZoom`、触摸板走立即
   `horizontalZoom`（`SessionStore.wheelHorizontalZoom`）；pxlogic 一律立即派发
   view intent，由后端 `ViewAnimation` 处理。

5. **底数不同导致"感觉非线性"。** `2^x` 在同样输入下比 `e^x` 变化更快
   （`2^x = e^(0.693x)`），即 Logic 2 的等效系数是 pxlogic 的 **0.693 / 0.0015 ≈ 462** 倍
   每"归一化单位"，而两边单位本身又不同。两重差异叠加，手感不可能靠试常数对齐。

## 4. 已实施：照搬 Logic 2 的 `wheelDelta` 归一化（方案 A）

**不需要测量。** 关键点是：物理滚轮在**已废弃的 `wheelDelta` 字段里每格恒为 ±120**，
与设备、系统、浏览器缩放都无关；而 `deltaY` 的像素值因设备而异。
Logic 2 正是因此选择归一化到 `wheelDelta`，pxlogic 现在同样这么做：

```
新增 src/lib/wheelZoom.ts：wheelZoomFactor(event, normalizedDelta, scale = 1)
```

| 输入 | 走哪条路 | 每步倍率 |
| --- | --- | --- |
| 物理滚轮（`wheelDeltaY % 120 === 0` 且非捏合） | `2^(±0.5 × 格数)` | **一格 = 2^0.5 = 1.414（±41.4%）**，与 Logic 2 一致 |
| 触摸板 / 捏合 / 无 `wheelDeltaY` | `exp(像素 × 0.0015)` | **与改动前完全相同** |

**保留了原有的方向约定**：`direction` 取自 `deltaY` 的符号，所以
`factor < 1` 仍是放大 —— 两侧都把 factor 当作"跨度的乘数"
（已用 Logic 2 的 `Commands.ZoomIn → 0.5` / `ZoomOut → 2` 核对确认语义一致），
本次**只改幅度不改方向**。

**捏合优先判定**：macOS 捏合会置 `ctrlKey` **且** `wheelDeltaY = ±120`，
与滚轮一模一样，所以捏合必须先判掉，否则一次捏合会变成一整格。

**两处调用点**共用同一个实现：
- `WaveformCanvas.tsx`（时间轴，横向缩放）
- `AnalogWaveformOverlay.tsx`（模拟量幅度，纵向缩放，`scale = shiftKey ? 0.1 : 1`）

### 验证

`wheelZoomFactor` 是纯函数，已编译后逐项断言 **12 项全部通过**：

- 一格 = `2^0.5`（放大 0.707 / 缩小 1.414）；两格 = `2^1`
- **`deltaY` 为 10 与 100 得到同一个步长** —— 这正是原缺陷被修掉的地方
- 捏合不被误判成一格
- `wheelDeltaY = 7`（非 120 倍数）与无 `wheelDeltaY` 均回退像素曲线，数值与改动前一致
- `scale = 0.1` 使一格变为十倍精细（`2^0.05`）
- ±800 钳制仍生效

### 若仍想微调

现在微调是安全的：物理滚轮的步长已经是"每格 2^0.5"这个**与设备无关**的量，
改 `WHEEL_ZOOM_PER_NOTCH_POW2` 即可（0.5 = 41.4%/格；0.4 ≈ 32%）。
**不要再动 `TOUCHPAD_ZOOM_INTENSITY`**，那条只影响触摸板。

---

## 4b. 若想进一步对齐（未做）

**不要直接改常数。** 先量出你设备的一格是多少 px，再决定：

**在 Tauri devtools 里粘这段，滚几下滚轮，读控制台：**

```js
(() => {
  const el = document.querySelector('canvas')?.parentElement ?? document.body;
  const log = [];
  const handler = (e) => {
    log.push({
      deltaY: Math.round(e.deltaY * 100) / 100,
      deltaMode: e.deltaMode,
      wheelDeltaY: e.wheelDeltaY,      // 物理滚轮每格恒为 ±120
      ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey,
    });
    console.table(log.slice(-12));
  };
  el.addEventListener('wheel', handler, { passive: true });
  window.__stopWheelProbe = () => el.removeEventListener('wheel', handler);
  console.log('滚几下滚轮；结束调用 __stopWheelProbe()');
})();
```

看点：
- **`wheelDeltaY` 是否恒为 ±120** → 是则说明是物理滚轮，Logic 2 会走 0.5× 分支
- **`deltaY` 的绝对值** → 除以它算 `k = 0.34657 / |deltaY|`，就是对齐 Logic 2 物理滚轮所需的 intensity
- **`ctrlKey` 在捏合时为 true**（macOS 触摸板捏合会置 ctrlKey）→ 对应 Logic 2 的 pinch 分支

**然后按需要做两件事（推荐都做）：**

1. **把 intensity 从固定常数改为按设备/输入类型推导** —— 与 Logic 2 的结构对齐：
   物理滚轮走"每格固定 2^0.5"，触摸板走"每归一化单位 ×2"。
2. **补上 `Shift` = 微调**（当前 Shift 被平移占用），并把 Ctrl/Cmd 的"变粗"语义
   与 Logic 2 对齐或明确区分。

## 5. 未验证

- 本机 macOS 一格滚轮的实际 `deltaY`（上表 100 px 是估计，**必须实测**）。
- 符号/方向约定：Logic 2 在 macOS 上把物理滚轮的 `gainX` 设为 **-1**
  （`platformSettings.osx.physicalWheel.gainX = -1`），pxlogic 不做此翻转。
  两者的"上滚=放大还是缩小"是否一致**未在真机确认**，建议一并看 `deltaY` 的符号。
