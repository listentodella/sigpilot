import assert from "node:assert/strict";
import test from "node:test";
import { clampTerminalRect, terminalInputChunks } from "../src/lib/floatingTerminal.ts";

test("terminal geometry remains reachable after moving from a larger screen", () => {
  const rect = clampTerminalRect({ x: 1900, y: 1000, width: 1100, height: 600 }, { width: 1024, height: 680 });
  assert.equal(rect.x, 8);
  assert.ok(rect.y >= 36);
  assert.ok(rect.x + rect.width <= 1016);
  assert.ok(rect.y + rect.height <= 640);
  const small = clampTerminalRect({ x: -500, y: -100, width: 20, height: 10 }, { width: 1320, height: 840 });
  assert.deepEqual(small, { x: 8, y: 36, width: 380, height: 220 });
});

test("large terminal paste chunks preserve Chinese, astral Unicode and escape sequences", () => {
  const data = "a".repeat(8191) + "😀中文" + "\x1b[200~" + "x".repeat(30000) + "\x1b[201~";
  const chunks = terminalInputChunks(data);
  assert.equal(chunks.join(""), data);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 8193);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk));
  }
});
