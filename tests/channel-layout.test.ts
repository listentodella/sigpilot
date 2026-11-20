import assert from "node:assert/strict";
import test from "node:test";
import { fitChannelRowsToViewport, fitSaleaeDigitalRowsToViewport, saleaeChannelContentHeight } from "../src/lib/saleaeChannelLayout.ts";

test("eight digital rows reserve decoder strips before fitting the window", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ minHeight: 28, topInset: index < 2 ? 20 : 0 }));
  const fitted = fitChannelRowsToViewport(600, rows);
  assert(fitted.every((height) => height >= 28 && height < 100));
  assert(saleaeChannelContentHeight(fitted.map((height, index) => height + rows[index].topInset)) <= 600);
});

test("mixed rows shrink analog defaults and fit when their minimums fit", () => {
  const rows = [...Array.from({ length: 8 }, () => ({ minHeight: 28 })), { minHeight: 160 }, { minHeight: 160 }];
  const fitted = fitChannelRowsToViewport(700, rows);
  assert(saleaeChannelContentHeight(fitted) <= 700);
  assert(fitted.slice(8).every((height) => height >= 160 && height < 280));
  const small = fitChannelRowsToViewport(200, rows);
  assert.deepEqual(small, rows.map((row) => row.minHeight));
  assert(saleaeChannelContentHeight(small) > 200);
});

test("manual sizing preserves individual heights and a small channel set stays capped", () => {
  assert.deepEqual(fitSaleaeDigitalRowsToViewport({ availableHeight: 300, channelIndexes: [3, 1], storedHeights: [100, 180, 100, 60], manualLayout: true }), [60, 180]);
  assert.deepEqual(fitChannelRowsToViewport(800, [{ minHeight: 28, maxHeight: 400 }]), [400]);
  assert.deepEqual(fitChannelRowsToViewport(800, []), []);
});
