import assert from "node:assert/strict";
import test from "node:test";
import { MAX_VIRTUAL_LIST_ROWS, virtualListWindow } from "../src/lib/virtualList.ts";

test("virtual lists expose all rows through scroll windows", () => {
  const first = virtualListWindow(10_000, 28, 0, 280, 28, 2);
  assert.deepEqual(first, {
    start: 0,
    end: 12,
    startPaddingPx: 0,
    endPaddingPx: 279_664,
  });

  const middle = virtualListWindow(10_000, 28, 140_028, 280, 28, 2);
  assert.equal(middle.start, 4_998);
  assert.equal(middle.end, 5_012);
  assert.equal(middle.startPaddingPx + (middle.end - middle.start) * 28 + middle.endPaddingPx, 280_000);
});

test("virtual list windows clamp empty and trailing ranges", () => {
  assert.deepEqual(virtualListWindow(0, 28, 0, 0), {
    start: 0,
    end: 0,
    startPaddingPx: 0,
    endPaddingPx: 0,
  });
  const last = virtualListWindow(25, 18, 10_000, 180, 0, 3);
  assert.equal(last.end, 25);
  assert.equal(last.endPaddingPx, 0);
});

test("a content-sized viewport cannot expand into all rows and keeps the tail reachable", () => {
  const count = 100_000;
  for (const scrollTop of [0, 28_000, (count - 20) * 28]) {
    const window = virtualListWindow(count, 28, scrollTop, count * 28 + 28, 28, 12);
    assert.ok(window.end - window.start <= MAX_VIRTUAL_LIST_ROWS);
    assert.equal(window.startPaddingPx + (window.end - window.start) * 28 + window.endPaddingPx, count * 28);
  }
  const last = virtualListWindow(count, 28, count * 28 - 400, 400, 28, 12);
  assert.equal(last.end, count);
});

test("nonfinite viewport measurements remain bounded", () => {
  for (const height of [NaN, Infinity, -Infinity]) {
    const window = virtualListWindow(100_000, 28, 0, height, 28, 12);
    assert.ok(Number.isFinite(window.end));
    assert.ok(window.end - window.start <= MAX_VIRTUAL_LIST_ROWS);
  }
});
