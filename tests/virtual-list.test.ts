import assert from "node:assert/strict";
import test from "node:test";
import { virtualListWindow } from "../src/lib/virtualList.ts";

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
