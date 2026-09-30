// The per-frame pipeline.
//
// Saleae drives its graph backend once per animation frame with a FrameStartEvent
// and lets the backend decide what to send back. SigPilot used to do the opposite:
// the frontend decided the level of detail, rate limited its own requests, cached
// rasters and guarded against staleness. Every one of those decisions was a place
// where the graph could end up in a state the user had to nudge back.
//
// This module is the SigPilot side of the Saleae arrangement:
//   * one request per animation frame, carrying a gesture (or "keep current"),
//   * at most one request in flight, so a slow backend throttles itself instead
//     of piling up work — back pressure replaces the frame queue,
//   * the backend's `view` and `data_view` are both adopted verbatim, and the
//     gap between them is what the residual transform stretches.
//
// It is deliberately framework-free: no React, no DOM beyond requestAnimationFrame.
// The whole point is that a pan or zoom frame must not re-render the workbench.

import type { AnalyzerRenderRequest, AnalyzerRenderResult, GraphFrameResponse, SessionView, ViewIntent, WaveformTile } from "./api";

export const KEEP_CURRENT: ViewIntent = { kind: "keep_current" };

/**
 * How long this intent's glide runs for, in milliseconds. Zero means it lands
 * immediately.
 *
 * Discrete input carries a duration — one wheel notch or one keypress is a single
 * hard step, so the backend glides to it — while continuous input (a touchpad
 * stream) leaves it at zero. Anything with a duration needs frames pumped at it
 * until it finishes, so this has to cover every intent that can glide rather than
 * just `animate_to`.
 */
function intentAnimationMs(intent: ViewIntent): number {
  switch (intent.kind) {
    case "animate_to":
      return Math.max(0, intent.duration_ms);
    case "zoom":
      return Math.max(0, intent.duration_ms ?? 0);
    case "pan_samples":
      return Math.max(0, intent.duration_ms ?? 0);
    default:
      return 0;
  }
}

export interface FrameLoopState {
  /** The authoritative viewport, straight from the backend. */
  view: SessionView;
  /** The viewport the currently held data was rendered for. Trails `view`. */
  dataView: SessionView;
  tile: WaveformTile | null;
  analyzers: AnalyzerRenderResult[];
  /** Pixel width the held tile was rendered for. */
  tileWidthPx: number;
  /** Set when the session has no capture loaded yet. */
  ready: boolean;
}

export interface FrameLoopDependencies {
  /**
   * Issues one frame request. Rejects on transport failure. The loop's current
   * state is passed along so the caller can fill in a valid range: a backend
   * that predates the intent protocol would reject an empty one.
   */
  request: (
    intent: ViewIntent,
    frameId: number,
    state: FrameLoopState,
  ) => Promise<GraphFrameResponse>;
  /** Device pixel width to render for. Read per frame so a resize is picked up. */
  widthPx: () => number;
  /** The channels to render. Read per frame so a layout change is picked up. */
  channels: () => number[];
  analyzers: () => AnalyzerRenderRequest[];
  /** Milliseconds since an arbitrary epoch. Injectable for tests. */
  now: () => number;
  scheduleFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  onState: (state: FrameLoopState) => void;
  onError?: (error: unknown) => void;
  /**
   * Called when the loop crosses between "working" and "not working". The caller
   * is expected to fall back to its own rendering path when this reports false,
   * so a broken backend degrades instead of leaving an empty graph.
   */
  onHealthChange?: (healthy: boolean) => void;
}

/** Consecutive failures before the loop declares itself unhealthy. */
const FAILURE_THRESHOLD = 3;

const DEFAULT_VIEW: SessionView = { samples: 1, start_sample: 0 };

/**
 * Why a frame is worth requesting. Requesting unconditionally at 60 Hz would
 * push a full frame every 16 ms even while the user is reading a still graph;
 * the backend answers a no-op request with the same data, which is pure waste.
 */
export type FrameDemand = "idle" | "gesture" | "animating" | "live";

export class SessionFrameLoop {
  private readonly deps: FrameLoopDependencies;
  private state: FrameLoopState = {
    analyzers: [],
    dataView: DEFAULT_VIEW,
    ready: false,
    tile: null,
    tileWidthPx: 1,
    view: DEFAULT_VIEW,
  };
  private rafHandle: number | null = null;
  private frameId = 0;
  private inFlight = false;
  private disposed = false;
  private pendingIntent: ViewIntent | null = null;
  /** The intent carried by the frame currently in flight. */
  private sentIntent: ViewIntent = KEEP_CURRENT;
  /** Keeps requesting while a backend-owned glide is running. */
  private animatingUntilMs = 0;
  private live = false;
  private revisionDirty = true;
  private lastRevision = -1;
  /** Exponential backoff so a dead backend is retried, not hammered. */
  private retryNotBeforeMs = 0;
  private consecutiveFailures = 0;
  private healthy = true;

  constructor(deps: FrameLoopDependencies) {
    this.deps = deps;
  }

  get current(): FrameLoopState {
    return this.state;
  }

  start() {
    if (this.disposed || this.rafHandle !== null) return;
    this.revisionDirty = true;
    this.rafHandle = this.deps.scheduleFrame(this.tick);
  }

  dispose() {
    this.disposed = true;
    if (this.rafHandle !== null) {
      this.deps.cancelFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.pendingIntent = null;
  }

  /** Records a gesture. Coalesces: only the newest un-sent intent survives. */
  dispatch(intent: ViewIntent) {
    this.pendingIntent = intent;
    const animationMs = intentAnimationMs(intent);
    if (animationMs > 0) {
      // The backend owns the glide; keep asking for frames until it is due to
      // finish so the animation actually advances.
      //
      // Any intent that carries a duration glides, not just `animate_to`. A glide
      // that is not registered here lets the loop fall to "idle" and stop
      // requesting frames, and since the backend only advances an animation when
      // it is asked for a frame, the view freezes part-way through. The next
      // frame then samples an animation that has been running on the clock the
      // whole time and jumps — which reads as markers and the trace disagreeing.
      this.animatingUntilMs = this.deps.now() + animationMs + 50;
    }
    if (intent.kind !== "keep_current") this.revisionDirty = true;
    this.start();
  }

  /** A live capture keeps producing new samples, so it always wants frames. */
  setLive(live: boolean) {
    if (this.live === live) return;
    this.live = live;
    if (live) this.start();
  }

  /** Something other than the viewport changed (new capture, channel layout). */
  invalidate() {
    this.revisionDirty = true;
    this.start();
  }

  private demand(): FrameDemand {
    if (this.pendingIntent && this.pendingIntent.kind !== "keep_current") return "gesture";
    if (this.deps.now() < this.animatingUntilMs) return "animating";
    if (this.revisionDirty) return "gesture";
    if (this.live) return "live";
    return "idle";
  }

  private tick = () => {
    this.rafHandle = null;
    if (this.disposed) return;

    // A frame already in flight carries the freshest intent we had. Waiting for
    // its response instead of piling on more requests is what makes a slow
    // backend throttle itself.
    if (this.inFlight) return;

    // Hold off after a failure, but keep ticking so the retry actually happens.
    if (this.deps.now() < this.retryNotBeforeMs) {
      this.rafHandle = this.deps.scheduleFrame(this.tick);
      return;
    }

    if (this.demand() === "idle") return;

    // The response (or the failure) is what schedules the next tick, so there is
    // never more than one frame outstanding and never a redundant timer.
    this.send();
  };

  private send() {
    const intent = this.pendingIntent ?? KEEP_CURRENT;
    this.pendingIntent = null;
    this.sentIntent = intent;
    this.revisionDirty = false;
    const frameId = ++this.frameId;
    this.inFlight = true;
    const widthPx = Math.max(1, Math.round(this.deps.widthPx()));
    this.deps
      .request(intent, frameId, this.state)
      .then((response) => this.accept(response, widthPx))
      .catch((error) => this.fail(error));
  }

  /**
   * Records a failed frame. The gesture that produced it is preserved — the
   * backend never saw it, so dropping it would lose the user's input — and the
   * retry is backed off so a dead backend is not hammered.
   */
  private fail(error: unknown) {
    this.inFlight = false;
    const intent = this.sentIntent;
    if (!this.pendingIntent && intent.kind !== "keep_current") {
      this.pendingIntent = intent;
    }
    this.consecutiveFailures += 1;
    this.retryNotBeforeMs = this.deps.now() + Math.min(2 ** this.consecutiveFailures * 50, 1_000);
    this.revisionDirty = true;
    if (this.healthy && this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.healthy = false;
      this.deps.onHealthChange?.(false);
    }
    this.deps.onError?.(error);
    if (!this.disposed) this.rafHandle = this.deps.scheduleFrame(this.tick);
  }

  private accept(response: GraphFrameResponse, widthPx: number) {
    if (this.disposed) return;
    this.inFlight = false;
    // A frame without a viewport cannot be drawn against anything, and adopting
    // one would put `undefined` into the canvas render and take the whole tree
    // down with it. Treat it as a failure instead.
    if (!response || !response.view || !response.data_view || !response.tile) {
      this.fail(new Error("frame response is missing its viewport"));
      return;
    }
    this.consecutiveFailures = 0;
    this.retryNotBeforeMs = 0;
    if (!this.healthy) {
      this.healthy = true;
      this.deps.onHealthChange?.(true);
    }
    // The response's own viewport wins: it is the backend's answer, not a copy
    // the frontend clamped for itself.
    this.state = {
      analyzers: response.analyzers,
      dataView: response.data_view,
      ready: true,
      tile: response.tile,
      tileWidthPx: response.tile.pixels > 0 ? response.tile.pixels : widthPx,
      view: response.view,
    };
    this.lastRevision = response.revision;
    this.deps.onState(this.state);
    // An intent that arrived while this frame was in flight should not wait for
    // the next animation frame; the user is mid-gesture.
    if (this.pendingIntent) {
      this.send();
    } else if (this.demand() !== "idle") {
      this.rafHandle = this.deps.scheduleFrame(this.tick);
    }
  }

  /** Exposed for diagnostics: the revision the held data was built from. */
  get revision() {
    return this.lastRevision;
  }
}
