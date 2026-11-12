import type { AnalyzerProtocolMarker } from "../../src/lib/api";

export type MarkerKind = AnalyzerProtocolMarker["kind"];

interface MarkerDescription {
  sdk: string;
  title: string;
  description: string;
  note: string;
}

// Record makes a missing or unsupported API kind a TypeScript error.
export const MARKER_DESCRIPTIONS: Record<MarkerKind, MarkerDescription> = {
  dot: {
    sdk: "Dot", title: "采样点",
    description: "小圆点，常用于标出数据采样位置。",
    note: "位置由解码器给出，不必位于波形跳变边沿。使用通道颜色。",
  },
  error_dot: {
    sdk: "ErrorDot", title: "错误采样点",
    description: "与 Dot 相同的圆点，使用主题中的错误颜色。",
    note: "你的 I3C 解码器用它标记 SDR 奇偶校验错误；仅凭图形无法区分具体错误原因。",
  },
  square: {
    sdk: "Square", title: "方块",
    description: "5 × 5 像素的实心方块，使用通道颜色。",
    note: "你的 I3C 解码器借用它表示 repeated START。它本身不是带语义的重启图标。",
  },
  error_square: {
    sdk: "ErrorSquare", title: "错误方块",
    description: "与 Square 相同的方块，使用错误颜色。",
    note: "例如 SPI 解码器在初始时钟极性不符时输出此标识。",
  },
  up_arrow: {
    sdk: "UpArrow", title: "上升沿箭头",
    description: "向上的三角箭头，通常标记时钟上升沿采样。",
    note: "SPI 会根据时钟极性与相位选择箭头方向；I2C 使用上升沿箭头。",
  },
  down_arrow: {
    sdk: "DownArrow", title: "下降沿箭头",
    description: "向下的三角箭头，通常标记时钟下降沿采样。",
    note: "本 Demo 的上下箭头分别放在合成时钟的上升沿和下降沿。",
  },
  x: {
    sdk: "X", title: "普通叉号",
    description: "两条交叉线，当前 SigPilot 使用通道颜色绘制。",
    note: "不等于错误：SWD 用它表示 turnaround；你的 I3C 解码器借用它表示进入 HDR-DDR 等事件。",
  },
  error_x: {
    sdk: "ErrorX", title: "错误叉号",
    description: "与 X 相同的交叉线，使用错误颜色。",
    note: "由解码器显式输出。例如 UART 的错误分支，或你的 I3C Target Reset 标注。",
  },
  start: {
    sdk: "Start", title: "开始",
    description: "7 像素直径的圆点，使用主题中的开始颜色。",
    note: "I2C 用于 START；你的 I3C 解码器也借用它表示 HDR restart。",
  },
  stop: {
    sdk: "Stop", title: "结束",
    description: "7 × 7 像素的实心方块，使用主题中的结束颜色。",
    note: "I2C 用于 STOP；你的 I3C 解码器也借用它表示 HDR exit。",
  },
  one: {
    sdk: "One", title: "方框内的 1",
    description: "13 × 13 像素的圆角方框，内部绘制数字 1。",
    note: "通常表示比特 1。你的 I3C 解码器借用它表示 IBI 接受；ACK 在线上是低电平，所以这里表达的是状态而非线值。",
  },
  zero: {
    sdk: "Zero", title: "方框内的 0",
    description: "与 One 相同的圆角方框，内部绘制数字 0。",
    note: "通常表示比特 0。你的 I3C 解码器借用它表示 IBI 拒绝；标识语义由解码器约定。",
  },
};

export const MARKER_KINDS = Object.keys(MARKER_DESCRIPTIONS) as MarkerKind[];
export const DEMO_TOTAL_SAMPLES = 1_200;
export const DEMO_SAMPLE_RATE_HZ = 1_000_000;

export interface MarkerDemoLane {
  title: string;
  channel: number;
  initialHigh: boolean;
  edges: number[];
  markers: AnalyzerProtocolMarker[];
}

/** Display fixture, not a valid transaction from any particular protocol. */
export function createMarkerDemoLanes(): MarkerDemoLane[] {
  return [
    {
      title: "采样点 / 方块", channel: 1, initialHigh: false,
      edges: [90, 270, 510, 750, 990],
      markers: [
        { sample: 180, kind: "dot" }, { sample: 420, kind: "error_dot" },
        { sample: 660, kind: "square" }, { sample: 900, kind: "error_square" },
      ],
    },
    {
      title: "时钟边沿", channel: 6, initialHigh: false,
      edges: [60, 180, 300, 420, 540, 660, 780, 900, 1_020, 1_140],
      markers: [{ sample: 300, kind: "up_arrow" }, { sample: 420, kind: "down_arrow" }],
    },
    {
      title: "控制 / 叉号", channel: 5, initialHigh: true,
      edges: [120, 330, 690, 1_080],
      markers: [
        { sample: 120, kind: "start" }, { sample: 420, kind: "x" },
        { sample: 720, kind: "error_x" }, { sample: 1_080, kind: "stop" },
      ],
    },
    {
      title: "比特 / 状态", channel: 7, initialHigh: false,
      edges: [240, 480, 600, 720, 960, 1_080],
      markers: [{ sample: 360, kind: "one" }, { sample: 840, kind: "zero" }],
    },
  ];
}
