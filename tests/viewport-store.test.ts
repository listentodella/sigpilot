import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSessionViewport,
  readSessionViewport,
  subscribeSessionViewport,
  writeSessionViewport,
} from "../src/lib/viewportStore.ts";

test("a written viewport is readable per session", () => {
  writeSessionViewport("a", 100, 50);
  writeSessionViewport("b", 7, 3);

  assert.deepEqual(readSessionViewport("a"), { start: 100, samples: 50 });
  assert.deepEqual(readSessionViewport("b"), { start: 7, samples: 3 });
  assert.equal(readSessionViewport("missing"), null);
});

test("listeners only see their own session", () => {
  const seen: string[] = [];
  const unsubscribe = subscribeSessionViewport("a", (viewport) => {
    seen.push(`${viewport.start}:${viewport.samples}`);
  });

  writeSessionViewport("b", 1, 1);
  writeSessionViewport("a", 2, 2);
  writeSessionViewport("a", 3, 3);

  assert.deepEqual(seen, ["2:2", "3:3"]);
  unsubscribe();
});

test("writing an unchanged viewport does not notify", () => {
  writeSessionViewport("a", 10, 10);
  let calls = 0;
  const unsubscribe = subscribeSessionViewport("a", () => {
    calls += 1;
  });

  writeSessionViewport("a", 10, 10);
  assert.equal(calls, 0);

  writeSessionViewport("a", 10, 11);
  assert.equal(calls, 1);
  unsubscribe();
});

test("subscribing does not fabricate a value", () => {
  // A reader must fall back to its own props until something real is published,
  // so subscribing alone has to leave the store empty.
  const unsubscribe = subscribeSessionViewport("fresh", () => {});
  assert.equal(readSessionViewport("fresh"), null);
  unsubscribe();
});

test("unsubscribing removes the last listener and drops the entry", () => {
  const unsubscribe = subscribeSessionViewport("a", () => {});
  unsubscribe();

  // With no listeners left the entry is released, so a later clear is a no-op
  // and a fresh subscription starts from an empty value.
  clearSessionViewport("a");
  assert.deepEqual(readSessionViewport("a"), null);
});

test("clearing keeps an entry that still has listeners", () => {
  writeSessionViewport("a", 4, 4);
  const unsubscribe = subscribeSessionViewport("a", () => {});

  clearSessionViewport("a");
  assert.deepEqual(readSessionViewport("a"), { start: 4, samples: 4 });

  unsubscribe();
  clearSessionViewport("a");
  assert.equal(readSessionViewport("a"), null);
});
