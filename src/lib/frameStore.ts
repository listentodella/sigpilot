// Per-session frame pipeline registry.
//
// The loop itself lives in `frameLoop.ts`; this module is what lets components
// consume it without the workbench re-rendering. That is the whole point: a pan
// or zoom frame must reach the waveform canvas and the analyzer overlay directly,
// not by way of a React state update on the component that owns everything else.
//
// The workbench creates one loop per session and hands over the pieces only it
// knows (which channels are visible, which analyzers are configured). Everything
// after that is driven by the loop.

import type { AnalyzerRenderRequest, GraphFrameResponse, ViewIntent } from "./api.ts";
import { SessionFrameLoop, type FrameLoopState } from "./frameLoop.ts";

export interface SessionFrameLoopConfig {
  analyzers: () => AnalyzerRenderRequest[];
  channels: () => number[];
  onError?: (error: unknown) => void;
  request: (
    intent: ViewIntent,
    frameId: number,
    state: FrameLoopState,
  ) => Promise<GraphFrameResponse>;
  widthPx: () => number;
}

type FrameStateListener = (state: FrameLoopState) => void;

interface FrameEntry {
  config: SessionFrameLoopConfig | null;
  listeners: Set<FrameStateListener>;
  loop: SessionFrameLoop | null;
  state: FrameLoopState | null;
}

const entries = new Map<string, FrameEntry>();

// Health is tracked separately from frame state on purpose: the workbench needs
// to know the loop is broken without subscribing to every frame, which is the
// one thing this whole arrangement exists to avoid.
const healthValues = new Map<string, boolean>();
const healthListeners = new Map<string, Set<(healthy: boolean) => void>>();

function publishHealth(sessionId: string, healthy: boolean) {
  if (healthValues.get(sessionId) === healthy) return;
  healthValues.set(sessionId, healthy);
  for (const listener of healthListeners.get(sessionId) ?? []) listener(healthy);
}

/**
 * Whether the loop is actually driving this session. False when there is no
 * loop at all — that is the signal the workbench gates its own pipeline on, so
 * reporting "healthy" for an absent loop would leave the graph with no source.
 */
export function readFrameHealth(sessionId: string): boolean {
  const entry = entries.get(sessionId);
  if (!entry?.loop) return false;
  return healthValues.get(sessionId) ?? true;
}

export function subscribeFrameHealth(sessionId: string, listener: (healthy: boolean) => void) {
  let listeners = healthListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    healthListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A consumer can subscribe before the workbench has wired the session up: React
// runs child effects before parent effects, so the canvas always gets there
// first. Entries therefore exist independently of the loop.
function entryFor(sessionId: string): FrameEntry {
  const existing = entries.get(sessionId);
  if (existing) return existing;
  const created: FrameEntry = { config: null, listeners: new Set(), loop: null, state: null };
  entries.set(sessionId, created);
  return created;
}

/**
 * Creates the loop for a session if it does not exist yet. The config is
 * re-read on every frame, so a caller can pass closures over refs and never
 * needs to recreate the loop when channel or analyzer selection changes.
 */
export function ensureSessionFrameLoop(sessionId: string, config: SessionFrameLoopConfig) {
  const entry = entryFor(sessionId);
  entry.config = config;
  if (entry.loop) return entry.loop;
  const loop = new SessionFrameLoop({    analyzers: () => entry.config?.analyzers() ?? [],
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    channels: () => entry.config?.channels() ?? [],
    now: () => performance.now(),
    onError: (error) => entry.config?.onError?.(error),
    onHealthChange: (healthy) => publishHealth(sessionId, healthy),
    onState: (state) => {
      entry.state = state;
      for (const listener of entry.listeners) listener(state);
    },
    request: (intent, frameId, state) => {
      if (!entry.config) return Promise.reject(new Error("frame loop has no request handler"));
      return entry.config.request(intent, frameId, state);
    },
    scheduleFrame: (callback) => window.requestAnimationFrame(callback),
    widthPx: () => entry.config?.widthPx() ?? 1,
  });
  entry.loop = loop;
  // A loop that exists is healthy until it says otherwise, so the workbench can
  // hand the waveform over the moment it is wired up.
  publishHealth(sessionId, true);
  loop.start();
  return loop;
}

export function releaseSessionFrameLoop(sessionId: string) {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.loop?.dispose();
  entry.loop = null;
  entry.config = null;
  // Publish unhealthy, not healthy: the workbench gates its own pipeline on this
  // signal, so reporting a released loop as healthy would leave the session with
  // neither source running. A later `ensureSessionFrameLoop` re-arms it.
  publishHealth(sessionId, false);
  if (entry.listeners.size === 0) entries.delete(sessionId);
}

export function readFrameState(sessionId: string): FrameLoopState | null {
  return entries.get(sessionId)?.state ?? null;
}

export function subscribeFrameState(sessionId: string, listener: FrameStateListener) {
  const entry = entryFor(sessionId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function dispatchSessionViewIntent(sessionId: string, intent: ViewIntent) {
  entries.get(sessionId)?.loop?.dispatch(intent);
}

export function invalidateSessionFrame(sessionId: string) {
  entries.get(sessionId)?.loop?.invalidate();
}

export function setSessionFrameLive(sessionId: string, live: boolean) {
  entries.get(sessionId)?.loop?.setLive(live);
}

/** True once the workbench has wired a session into the backend frame loop. */
export function hasSessionFrameLoop(sessionId: string) {
  return Boolean(entries.get(sessionId)?.loop);
}

// Dev-only inspection hook. The frame pipeline is deliberately outside React, so
// there is otherwise no way to see what it is holding from the console.
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __PXLOGIC_FRAMES__?: unknown }).__PXLOGIC_FRAMES__ = {
    health: () => Object.fromEntries(healthValues),
    sessions: () => [...entries.keys()],
    state: (sessionId: string) => {
      const state = entries.get(sessionId)?.state;
      if (!state) return null;
      return {
        analyzers: state.analyzers.length,
        dataView: state.dataView,
        ready: state.ready,
        tileChannels: state.tile?.channels.length ?? 0,
        tilePixels: state.tile?.pixels ?? null,
        tileSampleCount: state.tile?.sample_count ?? null,
        tileSamplesPerPixel: state.tile?.samples_per_pixel ?? null,
        tileStart: state.tile?.start_sample ?? null,
        tileWidthPx: state.tileWidthPx,
        view: state.view,
      };
    },
  };
}
