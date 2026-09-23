import assert from "node:assert/strict";
import test from "node:test";
import type { GraphFrameResponse, SessionView, ViewIntent } from "../src/lib/api.ts";

// `frameStore` drives the loop with the real animation-frame API, which does not
// exist in Node. Stub it before importing so the module can be exercised as-is.
const scheduled: Array<() => void> = [];
(globalThis as unknown as { window: unknown }).window = {
  cancelAnimationFrame: () => {},
  requestAnimationFrame: (callback: () => void) => {
    scheduled.push(callback);
    return scheduled.length;
  },
};

const {
  dispatchSessionViewIntent,
  ensureSessionFrameLoop,
  hasSessionFrameLoop,
  invalidateSessionFrame,
  readFrameHealth,
  readFrameState,
  releaseSessionFrameLoop,
  setSessionFrameLive,
  subscribeFrameState,
  subscribeFrameHealth,
} = await import("../src/lib/frameStore.ts");

interface PendingRequest {
  intent: ViewIntent;
  resolve: (response: GraphFrameResponse) => void;
}

const requests: PendingRequest[] = [];

function frame(view: SessionView, dataView: SessionView): GraphFrameResponse {
  return {
    analyzers: [],
    data_view: dataView,
    frame_id: 1,
    revision: 1,
    sample_count: 1_000,
    tile: {
      channels: [],
      pixels: 400,
      sample_count: dataView.samples,
      samples_per_pixel: 1,
      start_sample: dataView.start_sample,
    },
    view,
  };
}

function config() {
  return {
    analyzers: () => [],
    channels: () => [0],
    request: (intent: ViewIntent) =>
      new Promise<GraphFrameResponse>((resolve) => {
        requests.push({ intent, resolve });
      }),
    widthPx: () => 400,
  };
}

function runFrame() {
  const callback = scheduled.shift();
  if (callback) callback();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("a session has no frame state until the loop produces one", () => {
  assert.equal(hasSessionFrameLoop("s1"), false);
  assert.equal(readFrameState("s1"), null);
  // Dispatching before the workbench has wired the session up must be harmless.
  dispatchSessionViewIntent("s1", { delta_samples: 5, kind: "pan_samples" });
  invalidateSessionFrame("s1");
  setSessionFrameLive("s1", true);
});

test("subscribing before the loop exists still receives frames", async () => {
  // React runs child effects before parent effects, so the canvas always
  // subscribes first. The registry has to survive that ordering.
  const seen: number[] = [];
  const unsubscribe = subscribeFrameState("s2", (state) => seen.push(state.view.samples));
  assert.equal(readFrameState("s2"), null);

  ensureSessionFrameLoop("s2", config());
  assert.equal(hasSessionFrameLoop("s2"), true);

  runFrame();
  assert.equal(requests.length, 1);
  requests[0].resolve(frame({ samples: 250, start_sample: 0 }, { samples: 250, start_sample: 0 }));
  await settle();

  assert.deepEqual(seen, [250]);
  assert.equal(readFrameState("s2")?.view.samples, 250);
  unsubscribe();
});

test("the loop adopts the backend's two viewports verbatim", async () => {
  ensureSessionFrameLoop("s3", config());
  runFrame();
  requests[requests.length - 1].resolve(
    frame({ samples: 100, start_sample: 900 }, { samples: 400, start_sample: 500 }),
  );
  await settle();

  const state = readFrameState("s3");
  assert.deepEqual(state?.view, { samples: 100, start_sample: 900 });
  assert.deepEqual(state?.dataView, { samples: 400, start_sample: 500 });
  assert.equal(state?.tileWidthPx, 400);
});

test("health reports whether the loop is actually driving the session", () => {
  // No loop yet: the workbench must keep its own pipeline, so this is false.
  assert.equal(readFrameHealth("s5"), false);

  ensureSessionFrameLoop("s5", config());
  assert.equal(readFrameHealth("s5"), true);

  // Releasing must report false. Reporting true here is what left a session with
  // neither source running: the circuit breaker tore the loop down, the health
  // flag stayed optimistic, and the workbench kept its own pipeline disabled.
  releaseSessionFrameLoop("s5");
  assert.equal(readFrameHealth("s5"), false);
});

test("health changes are published to subscribers", () => {
  const seen: boolean[] = [];
  const unsubscribe = subscribeFrameHealth("s6", (healthy) => seen.push(healthy));

  ensureSessionFrameLoop("s6", config());
  releaseSessionFrameLoop("s6");
  ensureSessionFrameLoop("s6", config());

  assert.deepEqual(seen, [true, false, true]);
  unsubscribe();
});

test("releasing disposes the loop but keeps the entry while it is still read", () => {
  ensureSessionFrameLoop("s4", config());
  const unsubscribe = subscribeFrameState("s4", () => {});
  releaseSessionFrameLoop("s4");

  assert.equal(hasSessionFrameLoop("s4"), false);
  // The entry survives for its listener, and dispatching to a released session
  // must not throw.
  dispatchSessionViewIntent("s4", { delta_samples: 1, kind: "pan_samples" });
  unsubscribe();
});
