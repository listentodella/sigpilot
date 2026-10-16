# 缩放动画一致性：以"动画友好呈现"弱化闪烁

> 起因：Saleae 的键盘缩放与滚轮缩放**动画类型几乎一致**（只是倍率不同）；
> pxlogic 则不一致 —— **滚轮看起来有动画，键盘几乎瞬间到位**。
> 既然闪烁本身短期难以根治，就从动画呈现入手，让键盘缩放的过渡平滑自然，
> 从而弱化那几帧闪烁的视觉影响。

---

## 1. 先纠正我自己上一轮的判断

我上一轮把键盘缩放从"带动画"改成了**立即生效**（已提交在 `806392d`），
依据是我读到 Saleae 对直接操作传 `duration: 0`。**那个依据是不完整的** ——
`duration: 0` 只是 Saleae 的一条分支，不是全部。**这个改动正是造成键盘/滚轮不一致的原因。**

### Saleae 的真实规则：按**输入是否离散**分，不按"是否直接操作"

`SessionStore.ts:1786 wheelHorizontalZoom`：

```ts
const horizontalZoomFactor = calcWheelZoomFactor(normalizedEvent);
if (normalizedEvent.isPhysicalWheel) {
  this.renderingManager.animateHorizontalZoom(relativeTimeSeconds, horizontalZoomFactor);  // ← 带动画
} else {
  this.horizontalZoom(relativeTimeSeconds, horizontalZoomFactor);                            // ← 立即
}
```

`isPhysicalWheel` 的判定（`normalizeWheelEvent.ts:137`）：

```ts
const expectedTickSize = 120 / zoomFactor;
const isPhysicalWheel = wheelDelta !== 0 && (wheelDelta % expectedTickSize === 0);
```

**物理滚轮每格发 `wheelDelta` 的整数倍（120 的倍数），触控板发任意值。**

动画时长（`RenderingManager.ts:814`）：

```ts
public animateHorizontalZoom(centerTime, zoomFactor) {
  await manager.animateZoom({
    fixpointPixels, zoomFactor,
    duration: this.session.rapidDataStore.developerOptions.animationDurationScale * 0.1,  // = 100ms
  });
}
```

### 归纳成一张表

| 输入 | 性质 | Saleae 的处理 | 时长 |
| --- | --- | --- | --- |
| **物理滚轮** | **离散**（一格一跳） | `animateHorizontalZoom` → 后端插值 | **100ms** |
| **键盘**（`=`/`-`/`↑`/`↓`/`w`/`s`） | **离散** | 与滚轮同族，**也是动画** | 100ms |
| **触控板 / 平滑滚动** | **连续**（事件流） | `horizontalZoom` → 立即 | 0 |
| **菜单/按钮**（`ConnectedTimeRangeMenu`） | 程序驱动 | `horizontalZoom` → 立即 | 0 |

**规则是：离散输入 → 动画；连续输入与程序跳转 → 立即。**

**关键：`isPhysicalWheel` 走动画不是因为"用户直接操作"，恰恰是因为它"离散"。**
离散的一跳如果瞬时完成，画面就是一次硬跳；插值 100ms 才读得出来"发生了什么"。

---

## 2. pxlogic 现在为什么看起来不一致

pxlogic 有两套视口机制：

| 机制 | 位置 | 说明 |
| --- | --- | --- |
| **后端驱动** | `crates/pxlogic-graph/src/view_state.rs` | 注释自陈：*"Glide to a viewport over `duration_ms`. **The backend owns the animation** and interpolates it per requested frame, so the frontend never runs a second clock that can drift"* |
| **前端 rAF** | `src/App.tsx` `animateViewport()` | JS 侧自己插值 |

后端已有的意图（`view_state.rs:167`）：

| 变体 | 语义 |
| --- | --- |
| `Set { start_sample, samples }` | 直接替换视口 |
| `PanSamples { delta_samples }` | 平移 |
| **`Zoom { factor, anchor_ratio }`** | **乘法缩放（瞬时）** ← **滚轮走这条** |
| **`AnimateTo { start_sample, samples, duration_ms }`** | **滑行到视口，后端做动画** ← **键盘没用这条** |

**所以滚轮的"动画感"并不是真的在做动画** —— 它一次滚轮事件发一个瞬时的 `Zoom`，
**只是滚轮会连续发很多事件，一串小步看起来就像动画**。

而**键盘一次按键只发一步**，瞬时到位 —— 于是"滚轮有动画、键盘没有"。

**结论：这不是两套动画不一致，而是"键盘缺少了那 100ms 的插值"。**

---

## 3. 方案：键盘缩放改走后端已有的 `AnimateTo`

### 3.1 做法

键盘缩放（`=` / `-` / `↑` / `↓` / `w` / `s`）不再调用前端的 `setViewportImmediately`，
而是发一个**带动画的后端意图**，时长对齐 Saleae：

```ts
dispatchSessionViewIntent(sessionId, {
  kind: "animate_to",
  start_sample: targetStart,
  samples: targetSamples,
  duration_ms: 100,          // 与 Saleae 的 animationDurationScale * 0.1 对齐
});
```

### 3.2 为什么用后端的 `AnimateTo`，而不是退回前端的 `animateViewport(..., 100)`

| | 前端 `animateViewport` | **后端 `AnimateTo`** |
| --- | --- | --- |
| 动画时钟 | JS 的 rAF | **后端每帧插值** |
| 与滚轮是否同源 | ❌ 不同引擎，曲线/时序可能不一致 | ✅ **与滚轮同一套后端视口** |
| 与数据渲染的对齐 | 前端时钟可能与渲染用的时钟漂移（后端注释明确提到这点） | ✅ 同一个时钟 |
| 是否需要前端 rAF 循环 | 需要 | **不需要** |

**后端的 `AnimateTo` 就是 pxlogic 版的 `AnimateZoom`** ——
Saleae 是"渲染器拥有动画"，pxlogic 的对应物就是"后端拥有动画"，而 `view_state.rs` 已经是这么写的。
**键盘只是还没接上去。**

### 3.3 连按（长按重复）怎么处理

我上一轮改成"立即生效"的理由是：`animateViewport(..., 100)` 每次按键都**从动画中途的位置重新缓动**，
连按会叠加。**这个担心本身成立，但解法不该是"取消动画"，而应该是"重新定向（re-target）"**：

- 连按时**取消当前滑行，从当前位置向新目标重新起一条 100ms 曲线**
- 视觉上是"平滑追赶"，不是"叠加错乱"
- Saleae 的 `AnimateViewStateCancel` 与 `keyBindings` 里的 `cancelable: true` 就是这个意思

**需要在实现时确认**：后端在收到新的 `AnimateTo` 时是否替换（而非排队）当前动画。
`ViewIntent::is_animated()` 与注释 *"Animating intents are the only ones that leave an animation running"*
说明有这个区分，但要实测确认"新动画替换旧动画"。

---

## 4. 为什么"动画"能弱化闪烁（这是本方案的核心论点）

闪烁的成因（上一轮已定位）：缩放时绘制路径会在
`viewport-raster` ↔ `stale-*-raster`（放大 √2）之间跳变，**每 4 帧有 1 帧笔画粗 41%**。

**关键：这个"41% 的粗细差"有多显眼，取决于相邻帧之间画面变了多少。**

| | 瞬时跳变 | 100ms 插值 |
| --- | --- | --- |
| 单帧位移 | **整段变化一次发生** | 总变化的 **1/6**（60Hz 下 6 帧） |
| 闪烁帧与相邻帧的差异 | 叠加在"整幅图都变了"之上 → **非常显眼** | 叠加在"只挪了一点点"之上 → **被运动掩盖** |
| 眼睛的状态 | 静态注视 → 会捕捉到突变 | **追随运动（smooth pursuit）** → 对局部细节不敏感 |

**所以动画不是"修掉"闪烁，而是把闪烁放进一段连续运动里，让它不再是一个孤立的突变。**

**这正是用户提的角度，也是唯一能在不触碰渲染架构的前提下见效的方向。**

---

## 5. 与 Saleae 的对照总结

| 维度 | **Saleae** | **pxlogic（现状）** | **pxlogic（本方案后）** |
| --- | --- | --- | --- |
| 动画归属 | **原生渲染器** | 后端（滚轮）/ 前端 rAF（键盘，已改立即） | **统一在后端** |
| 物理滚轮 | **动画 100ms** | 一串瞬时 `Zoom`（看起来像动画） | 不变（已足够） |
| **键盘** | **动画 100ms** | **瞬时** ❌ | **动画 100ms** ✅ |
| 触控板 | 瞬时 | 瞬时 | 瞬时（保持） |
| 程序跳转 | 瞬时 | `Set` 瞬时 | 瞬时（保持） |
| 动画时长 | `animationDurationScale × 0.1`（可调） | — | 建议同样做成常量/可调 |

**注意 Saleae 的一个细节值得借鉴**：它**不是"所有缩放都动画"**，
触控板和程序跳转都是瞬时的。**如果把键盘也改成无条件动画，但把滚轮/触控板保持瞬时，
就已经和 Saleae 的规则一致了。**

---

## 6. 建议的落地顺序

1. **先确认后端 `AnimateTo` 的替换语义**（新动画是否取消旧动画）—— 这决定连按体验
2. 键盘缩放改发 `AnimateTo { duration_ms: 100 }`，**移除上一轮加的 `setViewportImmediately`**
3. **实测对比**（用同一套 Playwright 脚本）：
   - 键盘单次按键：是否从"瞬时"变成 ~100ms 的平滑滑行
   - 长按连按：是否平滑追赶而非叠加
   - **帧节拍 `missedFrameRatio` 不应上升**（这是上一轮方案 E 翻车的教训）
4. **不要在 demo 小采集上验收** —— 上一轮就是因为在 demo 上量测得出"成本没恶化"的错误结论。
   **需要在接近真实规模的负载（有解码分析器）上确认。**

---

## 7. 需要你确认的点

1. **时长**：跟 Saleae 一样用 **100ms**？还是你觉得更短/更长更好？（Saleae 是可调的 `animationDurationScale`）
2. **范围**：只改键盘，还是**键盘 + 滚轮都显式走 `AnimateTo`**？
   （滚轮现在靠"事件密集"看起来平滑，显式动画可能更稳，但也会改变现有手感）
3. **是否要我实现**，还是你先看方案。

---

# 补充（2026-09-24）：三个问题的查证结果

## 1. "可调"在哪里？—— 是隐藏的开发者选项

**答案：在 Developer 侧栏里，但入口被刻意隐藏。**

`ConnectedDeveloperActions.tsx:265`：

```ts
{
  type: 'Number',
  label: 'Animation Scale',
  tooltipContent: 'Scale for animation duration. This is used to speed up or slow down animations.',
  value: developerOptionsApi.animationDurationScale,
  limits: { min: 0.1, max: 100 },
  onChange: value => { developerOptionsApi.animationDurationScale = value; },
}
```

**怎么打开**（`keyBindings.ts:266`）：

```ts
[DeveloperCommands.EnableDeveloperMode]: {
  label: 'Enable Developer Mode',
  category: 'Tabs',
  shortcuts: ['ctrl+alt+shift+c'],                        // ← 快捷键
  hidden: { commandPalette: true, shortcutsDialog: true }, // ← 故意从命令面板和快捷键列表里隐藏
  cancelable: true,
}
```

**按 `Ctrl+Alt+Shift+C`** → 打开开发者模式并切到 Developer 侧栏 → 里面就有 **Animation Scale**（范围 0.1–100，默认 1.0）。

**你没找到是因为 `hidden: { commandPalette: true, shortcutsDialog: true }` —— 它被有意排除在命令面板和快捷键说明之外。**

**一个值得注意的点**：`animationDurationScale` 是**全局动画速度倍率**，不只作用于缩放 —— 它还乘在平移（`PANNING_ANIMATION_DURATION`）、惯性衰减（`timeConstant`）、时间轴缩放等多处。**所以 Saleae 把"动画快慢"做成了一个统一旋钮，而不是给缩放单独设时长。**

**给 pxlogic 的建议**：不要硬编码 `100`，而是照这个思路留一个可调倍率（哪怕是常量 + 注释），
这样以后调手感不用改逻辑。

## 2. 触摸板的逻辑确实不同 —— 两处都不同

`useInteraction.ts:835`：

```ts
export function calcWheelZoomFactor(normalizedEvent: NormalizeWheelEvent, scale: number = 1) {
  const zoomFactor = Math.pow(
    2,
    ((normalizedEvent.isPhysicalWheel ? 0.5 : 1) * scale * (-1 * normalizedEvent.deltaY)) / WHEEL_DELTA
  );
  ...
}
```

**`isPhysicalWheel ? 0.5 : 1`** —— 这是关键。

| 维度 | **物理滚轮** | **触摸板** |
| --- | --- | --- |
| **缩放步长** | 指数 **× 0.5** → 每格 **√2** | 指数 **× 1** → 每单位**全步** |
| **动画** | **有**（`animateHorizontalZoom`，100ms） | **无**（`horizontalZoom`，duration 0） |
| **事件频率** | 低（每格一次） | **高**（连续流） |
| **`isPhysicalWheel` 判定** | `wheelDelta % 120 === 0` | 其他 |

**为什么这样设计是自洽的**：
- **物理滚轮**：一格就是一次"硬跳"，所以**步长取小（√2）** + **补一段 100ms 插值**把这一跳抹平
- **触摸板**：本身就在连续发事件，**不需要插值**（每帧都在更新），但**单次步长要大**，否则要划很久

**所以"离散输入 → 动画 + 小步长"、"连续输入 → 立即 + 大步长"是同一条设计意图的两面。**

**给 pxlogic 的建议**：这正是 pxlogic 目前缺的另一半。
pxlogic 的 `wheelZoomFactor` 已经区分了滚轮/触摸板（上一轮加的），但**两者的步长与动画没有按这条规则配对**。
仿照 Saleae 应该是：
- **物理滚轮**：√2 步长 + `AnimateTo` 100ms
- **触摸板**：更大步长 + **保持立即**（不要动画）

## 3. "连按"的澄清 —— 你描述的两种现象，同一条规则就能同时产生

我先前的说法含糊了。按你的观察拆开：

| 行为 | 现象 | 机制 |
| --- | --- | --- |
| **长按不松手** | **波形快速连续缩放** | 键盘 repeat 以高频发事件；**每个事件都取消当前滑行、从当前位置向新目标重新起一条 100ms 曲线** → 动画永远来不及走完，变成**持续追赶** → 看起来是连续快速缩放 |
| **连续多次按下** | **看起来快速渲染了多次缩放动画** | 每次按键之间有空隙 → 每条 100ms 曲线**都走完了** → 看到的是**一段一段独立的动画** |

**关键：不需要为这两种情况写两套逻辑。**
**"每个输入事件都从当前位置重新定向（re-target）到新目标"这一条规则，自然同时产生这两种现象** ——
区别只在于事件间隔是否大于动画时长。

**这对应 Saleae 的**：
- `AnimateViewStateCancel`（取消在跑的插值）
- `keyBindings` 里的 `cancelable: true`
- `ViewIntent::is_animated()` 的区分 —— *"Animating intents are the only ones that leave an animation running"*

**⚠️ 实现前必须确认的一点**：pxlogic 后端收到新的 `AnimateTo` 时，是**替换**当前动画，还是**排队**？
- **替换** → 长按会连续追赶 ✓（符合你的观察）
- **排队** → 长按会积压成一串动画 ✗

**所以这一条要先用后端单测/实测确认，它决定了长按的手感对不对。**

## 4. 更新后的实现清单

1. **确认后端 `AnimateTo` 的替换语义**（决定长按手感）—— 优先级最高
2. **键盘缩放**：移除上一轮加的 `setViewportImmediately`，改发 `AnimateTo { duration_ms: 100 }`
3. **物理滚轮**：由现在的瞬时 `Zoom` 改为 `AnimateTo { duration_ms: 100 }`，步长保持 √2
4. **触摸板**：**保持立即**（不发 `AnimateTo`），但**把步长调大**（对齐 Saleae 的"连续输入走大步长"）
   - pxlogic 已有 `wheelZoomFactor` 区分输入类型，在它里面调整指数即可
5. **时长不要硬编码**：照 Saleae 的做法留一个 `animationDurationScale` 常量（默认 1 → 100ms）

**验证口径（沿用上一轮的教训）**：
- 键盘单按：从"瞬时"变为可感知的 ~100ms 平滑滑行
- 长按：**连续追赶**，不是一串积压的动画
- 触摸板：**保持立即**，手感不应变"粘"
- `missedFrameRatio` **不应上升**
- **必须在接近真实规模（带解码分析器）的负载上验收，不能只用 demo 小采集**
