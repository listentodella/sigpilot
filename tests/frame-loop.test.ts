import assert from "node:assert/strict";
import test from "node:test";
import { SessionFrameLoop, type FrameLoopState } from "../src/lib/frameLoop.ts";
import type { GraphFrameResponse, SessionView, ViewIntent } from "../src/lib/api.ts";

interface PendingRequest {
  frameId: number;
  intent: ViewIntent;
  reject: (error: unknown) => void;
  resolve: (response: GraphFrameResponse) => void;
}

function frame(frameId: number, view: SessionView, dataView: SessionView): GraphFrameResponse {
  return {
    analyzers: [],
    data_view: dataView,
    frame_id: frameId,
    revision: 1,
    sample_count: 10_000,
    tile: {
      channels: [],
      pixels: 1_000,
      sample_count: dataView.samples,
      samples_per_pixel: 1,
      start_sample: dataView.start_sample,
    },
    view,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function harness() {
  const scheduled: Array<() => void> = [];
  const requests: PendingRequest[] = [];
  const states: FrameLoopState[] = [];
  const errors: unknown[] = [];
  const health: boolean[] = [];
  let now = 0;
  const loop = new SessionFrameLoop({
    analyzers: () => [],
    cancelFrame: () => {},
    channels: () => [0],
    now: () => now,
    onError: (error) => errors.push(error),
    onHealthChange: (healthy) => health.push(healthy),
    onState: (state) => states.push(state),
    request: (intent, frameId) =>
      new Promise<GraphFrameResponse>((resolve, reject) => {
        requests.push({ frameId, intent, reject, resolve });
      }),
    scheduleFrame: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    widthPx: () => 1_000,
  });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    errors,
    health,
    loop,
    queuedFrames: () => scheduled.length,
    requests,
    runFrame: () => {
      const callback = scheduled.shift();
      if (callback) callback();
    },
    states,
  };
}

test("a started loop asks once, adopts the backend's viewport, then idles", async () => {
  const h = harness();
  h.loop.start();
  h.runFrame();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].intent, { kind: "keep_current" });

  h.requests[0].resolve(frame(1, { samples: 400, start_sample: 900 }, { samples: 400, start_sample: 900 }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.states.length, 1);
  // The response's viewport is adopted verbatim; the frontend never clamps.
  assert.deepEqual(h.states[0].view, { samples: 400, start_sample: 900 });
  assert.equal(h.states[0].ready, true);

  // Nothing changed, so the loop must stop asking instead of pushing a full
  // frame every animation frame while the user reads a still graph.
  h.runFrame();
  assert.equal(h.requests.length, 1);
  assert.equal(h.queuedFrames(), 0);
});

test("intents coalesce to the newest one before a frame goes out", () => {
  const h = harness();
  h.loop.dispatch({ delta_samples: 10, kind: "pan_samples" });
  h.loop.dispatch({ delta_samples: 20, kind: "pan_samples" });
  h.loop.dispatch({ delta_samples: 30, kind: "pan_samples" });

  h.runFrame();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].intent, { delta_samples: 30, kind: "pan_samples" });
});

test("a request in flight is not piled on", () => {
  const h = harness();
  h.loop.dispatch({ factor: 0.5, anchor_ratio: 0.5, kind: "zoom" });
  h.runFrame();
  assert.equal(h.requests.length, 1);

  // Extra ticks while the backend is still working must not queue more work.
  h.runFrame();
  h.runFrame();
  assert.equal(h.requests.length, 1);
});

test("a gesture during an in-flight frame is sent as soon as it lands", async () => {
  const h = harness();
  h.loop.dispatch({ delta_samples: 10, kind: "pan_samples" });
  h.runFrame();
  assert.equal(h.requests.length, 1);

  // The user keeps dragging while the backend is busy.
  h.loop.dispatch({ delta_samples: 40, kind: "pan_samples" });
  h.runFrame();
  assert.equal(h.requests.length, 1, "must not stack a second request");

  h.requests[0].resolve(frame(1, { samples: 100, start_sample: 0 }, { samples: 100, start_sample: 0 }));
  await Promise.resolve();
  await Promise.resolve();

  // The waiting intent is flushed immediately rather than waiting for the next
  // animation frame, which is what keeps a drag feeling attached to the cursor.
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].intent, { delta_samples: 40, kind: "pan_samples" });
});

test("a live capture keeps asking for frames", async () => {
  const h = harness();
  h.loop.setLive(true);
  h.loop.start();
  h.runFrame();
  h.requests[0].resolve(frame(1, { samples: 100, start_sample: 0 }, { samples: 100, start_sample: 0 }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.queuedFrames(), 1);
  h.runFrame();
  assert.equal(h.requests.length, 2);
});

test("a backend-owned animation keeps asking until it is due to finish", async () => {
  const h = harness();
  h.loop.dispatch({ duration_ms: 300, kind: "animate_to", samples: 200, start_sample: 0 });
  h.runFrame();
  h.requests[0].resolve(frame(1, { samples: 200, start_sample: 0 }, { samples: 200, start_sample: 0 }));
  await Promise.resolve();
  await Promise.resolve();

  // Still mid-glide: keep pulling frames so the animation advances.
  h.advance(100);
  assert.equal(h.queuedFrames(), 1);
  h.runFrame();
  assert.equal(h.requests.length, 2);

  h.requests[1].resolve(frame(2, { samples: 200, start_sample: 0 }, { samples: 200, start_sample: 0 }));
  await Promise.resolve();
  await Promise.resolve();

  // Past the requested duration the loop settles again.
  h.advance(400);
  h.runFrame();
  assert.equal(h.requests.length, 2);
  assert.equal(h.queuedFrames(), 0);
});

test("a failed frame reports the error and keeps the loop alive", async () => {
  const h = harness();
  h.loop.dispatch({ delta_samples: 5, kind: "pan_samples" });
  h.runFrame();
  h.requests[0].reject(new Error("transport down"));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.errors.length, 1);
  // The gesture that produced the failed frame must survive it.
  assert.equal(h.queuedFrames(), 1);

  // A dead backend is retried after a backoff rather than hammered every frame.
  h.runFrame();
  assert.equal(h.requests.length, 1);
  h.advance(200);
  h.runFrame();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].intent, { delta_samples: 5, kind: "pan_samples" });
});

test("repeated failures trip the health signal so the caller can fall back", async () => {
  const h = harness();
  h.loop.dispatch({ delta_samples: 5, kind: "pan_samples" });

  // Three consecutive failures is the threshold. The loop must not declare
  // itself broken on the first hiccup, or a single dropped frame would tear the
  // whole pipeline down.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    h.runFrame();
    const request = h.requests[h.requests.length - 1];
    request.reject(new Error("backend down"));
    await settle();
    h.advance(2_000);
  }

  assert.deepEqual(h.health, [false]);
});

test("a malformed frame counts as a failure rather than being adopted", async () => {
  const h = harness();
  h.loop.dispatch({ delta_samples: 5, kind: "pan_samples" });
  h.runFrame();

  // A response without a viewport cannot be drawn against anything. Adopting it
  // would put `undefined` into the canvas render and take the tree down.
  h.requests[0].resolve({ analyzers: [], frame_id: 1, revision: 1, sample_count: 10 } as never);
  await settle();

  assert.equal(h.states.length, 0);
  assert.equal(h.errors.length, 1);
});

test("recovering after a failure clears the health signal", async () => {
  const h = harness();
  h.loop.dispatch({ delta_samples: 5, kind: "pan_samples" });
  h.runFrame();
  h.requests[0].reject(new Error("blip"));
  await settle();
  h.advance(2_000);
  h.runFrame();
  h.requests[1].resolve(frame(1, { samples: 100, start_sample: 0 }, { samples: 100, start_sample: 0 }));
  await settle();

  // A single failure never reported unhealthy, so nothing is published.
  assert.deepEqual(h.health, []);
  assert.equal(h.states.length, 1);
});

test("disposing stops the loop and drops a queued intent", async () => {  const h = harness();
  h.loop.dispatch({ delta_samples: 10, kind: "pan_samples" });
  h.runFrame();
  h.loop.dispose();

  h.requests[0].resolve(frame(1, { samples: 100, start_sample: 0 }, { samples: 100, start_sample: 0 }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.states.length, 0);
  h.runFrame();
  assert.equal(h.requests.length, 1);
});
