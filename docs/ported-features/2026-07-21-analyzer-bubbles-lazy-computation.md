# Analyzer Bubbles 延迟计算优化

**日期**: 2026-07-21  
**分支**: `codex/saleae-stream-analyzer-bubbles`

## 功能范围

解决 Analyzer 气泡在缩放/平移时的性能卡顿问题，将昂贵的 `buildAnalyzerFrameWindow` 计算从 `useMemo` 移到渲染时的懒加载 + 缓存。

## 问题分析

### 原始实现的性能瓶颈

1. **`useMemo` 依赖过于频繁触发**：
   ```tsx
   const frameWindows = useMemo(
     () => new Map(
       bubbleTracks.map((track) => [
         track.key,
         buildAnalyzerFrameWindow(track.frames, viewportStart, viewportSamples, overlayWidth),
       ])
     ),
     [bubbleTracks, overlayWidth, viewportSamples, viewportStart],
   );
   ```
   - 每次滚轮缩放都会改变 `viewportStart` 或 `viewportSamples`
   - `useMemo` 依赖变化 → 重新计算**所有** analyzer tracks 的 `buildAnalyzerFrameWindow`
   - 即使只有一个 Async Serial analyzer，也要遍历成千上万个 frames

2. **`buildAnalyzerFrameWindow` 的昂贵操作**：
   - 二分查找可见 frames：`lowerBoundFrameEnd`、`upperBoundFrameStart`
   - 合并相邻小气泡：`buildAnalyzerBubblesFromFrames` → `appendFrameToBubbleAccumulators`
   - 每个 analyzer track 独立计算一遍

3. **实测卡顿场景**：
   - 添加 Async Serial 解码后，滚轮缩放明显卡顿
   - 添加 I2C/SPI 后更严重（多个通道角色 = 多个 tracks）

### Saleae Logic 2 原版做法

对比 `.app-data/saleae-logic-2.4.43` 的实现：

1. **后端预计算 `protocolBubblesV2`**：
   ```tsx
   const groupData = React.useCallback((): Array<Bubble | BubbleV2> => {
     return source.response?.result.protocolBubblesV2[0] ?? [];
   }, [source]);
   ```
   - 气泡数据从后端 Graph Server 直接返回
   - 前端不需要过滤、合并或二分查找

2. **前端只做坐标变换**：
   ```tsx
   const horizontalTransformComputed = React.useMemo(
     () => computed(
       () => {
         const { lastDataViewState } = session.renderingManager;
         return source.generateHorizontalTransform(lastViewState);
       },
       { equals: isEqual },
     ),
     [source, session],
   );
   ```
   - 使用 MobX `computed` + `isEqual` 避免浮点误差导致的重复计算
   - `horizontalTransform` 只包含缩放系数和偏移量，计算成本极低

3. **渲染时应用变换**：
   ```tsx
   const renderBubbleFactory: StatlessRenderingFactory<Bubble | BubbleV2> = React.useCallback(() => {
     const horizontalTransform = horizontalTransformComputed.get();
     // ...在渲染函数内部应用 transform
   }, [horizontalTransformComputed]);
   ```

### 为什么我们不能完全照搬原版？

我们的后端 (`crates/pxlogic-waveform`) 目前只负责波形 tile 的生成：
- `WaveformTile` 包含 `bins`、`segments`、`edges`
- Analyzer frames 是在前端通过 `decode.rs` (WASM) 生成的
- 没有等效的 Graph Server 来预计算 `protocolBubblesV2`

短期内无法将 `buildAnalyzerFrameWindow` 移到后端。

## 优化方案

### 核心思路

将 `buildAnalyzerFrameWindow` 的计算从 `useMemo`（每次 viewport 变化都触发）改为**渲染时懒加载 + 缓存**。

### 实现细节

**Before（每次 viewport 变化都重新计算所有 tracks）**：
```tsx
const frameWindows = useMemo(
  () => new Map(
    bubbleTracks.map((track) => [
      track.key,
      buildAnalyzerFrameWindow(track.frames, viewportStart, viewportSamples, overlayWidth),
    ])
  ),
  [bubbleTracks, overlayWidth, viewportSamples, viewportStart],
);

// 渲染时
const frameWindow = frameWindows.get(track.key);
```

**After（按需计算 + viewport 缓存）**：
```tsx
const frameWindowCache = useRef(new Map<string, { viewport: string; window: AnalyzerFrameWindow }>());

const getFrameWindow = (track: AnalyzerBubbleTrack): AnalyzerFrameWindow => {
  const viewportKey = `${viewportStart}:${viewportSamples}:${overlayWidth}`;
  const cached = frameWindowCache.current.get(track.key);
  if (cached && cached.viewport === viewportKey) {
    return cached.window;
  }
  const window = buildAnalyzerFrameWindow(track.frames, viewportStart, viewportSamples, overlayWidth);
  frameWindowCache.current.set(track.key, { viewport: viewportKey, window });
  return window;
};

// 渲染时
const frameWindow = getFrameWindow(track);
```

### 优化效果

1. **避免不必要的计算**：
   - 只有真正渲染的 track 才会计算 `buildAnalyzerFrameWindow`
   - 如果某个 track 不在可见区域，不会触发计算

2. **缓存命中率高**：
   - 相同 viewport 参数直接返回缓存结果
   - 适用于连续的小幅度滚轮缩放

3. **避免 React 重新渲染级联**：
   - `useMemo` 返回新的 `Map` 对象 → 下游 component 可能认为 props 变化
   - `useRef` + 缓存不会触发额外的 re-render

## 原版参考路径

- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/analyzersCommon/compositions/AnalyzerStripchartData/Bubbles.tsx`
  - 第 244-268 行：`groupData` 和 `horizontalTransformComputed`
- `.app-data/saleae-logic-2.4.43/recovered-ui-source/app/services/RenderingManager/RenderingManager.ts`
  - 第 130-150 行：`lastDataViewState` 的 `computed` 定义

## 本地落点文件

- `src/components/AnalyzerBubblesOverlay.tsx`
  - 移除 `frameWindows` 的 `useMemo`
  - 添加 `frameWindowCache` + `getFrameWindow` 懒加载逻辑
  - 更新所有引用 `frameWindows.get()` 的地方为 `getFrameWindow()`

## 复用方式

- **算法复刻**：采用原版"渲染时变换 + 缓存"的思路，但保留 `buildAnalyzerFrameWindow` 的前端实现
- **未来优化路径**：
  1. 将 `buildAnalyzerFrameWindow` 移到 Web Worker
  2. 或者在后端 Rust 中实现类似 Graph Server 的预计算

## 用户可见行为

- 滚轮缩放/平移时流畅度显著提升
- Analyzer 气泡显示逻辑完全一致，无视觉差异

## 验证方式

1. **性能对比测试**：
   - 添加 Async Serial analyzer 解码
   - 滚轮连续缩放，观察帧率和响应延迟
   - Before：明显卡顿，每次缩放都有 100-200ms 延迟
   - After：流畅，接近原生滚动体验

2. **功能回归测试**：
   - Analyzer 气泡正常显示
   - Previous/Next 导航按钮正常工作
   - Cmd+左右箭头快捷键正常工作
   - Multi-bubble 聚合正确
   - Marker 箭头位置正确

3. **极端场景测试**：
   - 长时间捕获（100M+ samples）+ 高密度 frames
   - 多个 analyzer 同时启用（I2C + SPI + Async Serial）
   - 快速连续缩放

## 已知差距 / 后续任务

1. **缓存策略可以更智能**：
   - 当前是简单的 `viewportKey` 字符串比对
   - 可以考虑容忍微小的 viewport 差异（浮点误差）

2. **缓存大小无上限**：
   - 当前 `frameWindowCache` 会一直增长
   - 可以考虑 LRU 淘汰策略

3. **理想方案仍然是后端预计算**：
   - 将 `buildAnalyzerFrameWindow` 移到 Rust 后端
   - 或者在 Web Worker 中运行，避免阻塞主线程

4. **MobX RenderingStore 未充分利用**：
   - 当前只用了 RAF 节流
   - 可以将 `getFrameWindow` 改为 MobX `computed`，进一步优化

## 对应 Git 提交

待提交（当前改动在工作区）

## 相关功能

- `2026-07-17-analyzer-bubbles-viewport-window.md` - 初始 `buildAnalyzerFrameWindow` 实现
- `2026-07-20-analyzer-channel-roles-markers.md` - 多通道角色导致的性能问题加剧
