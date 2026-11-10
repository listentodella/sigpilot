import assert from "node:assert/strict";
import test from "node:test";
import { ANALYZER_TABLE_PAGE_SIZE, AnalyzerTableRequestQueue, visitAnalyzerTablePages } from "../src/lib/analyzerTableRequests.ts";
import type { AnalyzerFrameTableWindow } from "../src/lib/api.ts";

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function harness() {
  const queue = new AnalyzerTableRequestQueue<string>();
  const started: string[] = [];
  const accepted: string[] = [];
  const errors: unknown[] = [];
  const pending = new Map<string, { resolve: (value: string) => void; reject: (error: unknown) => void }>();
  const request = (key: string) => queue.request({
    key,
    run: () => new Promise<string>((resolve, reject) => {
      started.push(key);
      pending.set(key, { resolve, reject });
    }),
    accept: (result) => accepted.push(result),
    reject: (error) => errors.push(error),
  });
  return { queue, request, started, accepted, errors, pending };
}

test("scroll bursts keep only one active call and the latest pending window", async () => {
  const h = harness();
  h.request("initial");
  await settle();
  for (let index = 0; index < 100; index++) h.request(`scroll-${index}`);
  assert.deepEqual(h.started, ["initial"]);
  h.pending.get("initial")!.resolve("stale");
  await settle();
  assert.deepEqual(h.started, ["initial", "scroll-99"]);
  assert.deepEqual(h.accepted, []);
  h.pending.get("scroll-99")!.resolve("latest");
  await settle();
  assert.deepEqual(h.accepted, ["latest"]);
});

test("reselecting an in-flight window does not issue a duplicate", async () => {
  const h = harness();
  h.request("a");
  await settle();
  h.request("b");
  h.request("a");
  h.pending.get("a")!.resolve("a");
  await settle();
  assert.deepEqual(h.started, ["a"]);
  assert.deepEqual(h.accepted, ["a"]);
});

test("unmount or disabled pane drops pending work and rejects stale results", async () => {
  const h = harness();
  h.request("a");
  await settle();
  h.request("b");
  h.queue.clear();
  h.pending.get("a")!.resolve("a");
  await settle();
  assert.deepEqual(h.started, ["a"]);
  assert.deepEqual(h.accepted, []);
});

test("failure releases the queue without retrying the failed request", async () => {
  const h = harness();
  h.request("a");
  await settle();
  h.pending.get("a")!.reject("failed");
  await settle();
  assert.deepEqual(h.started, ["a"]);
  assert.deepEqual(h.errors, ["failed"]);
  h.request("b");
  await settle();
  assert.deepEqual(h.started, ["a", "b"]);
  h.pending.get("b")!.resolve("b");
  await settle();
});

test("copy reads all results in bounded sequential pages, including a short final page", async () => {
  const total = ANALYZER_TABLE_PAGE_SIZE * 2 + 7;
  const calls: number[][] = [];
  const positions: number[] = [];
  await visitAnalyzerTablePages(async (start, end) => {
    calls.push([start, end]);
    return {
      roles: [], row_count: total,
      rows: Array.from({ length: Math.min(total, end) - start }, (_, offset) => ({ frame_number: start + offset + 1 })),
    } as AnalyzerFrameTableWindow;
  }, (page) => positions.push(...page.rows.map((row) => row.frame_number)));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([start, end]) => end - start <= ANALYZER_TABLE_PAGE_SIZE));
  assert.deepEqual(positions, Array.from({ length: total }, (_, index) => index + 1));
});

test("copy does not keep chasing results added after its first page", async () => {
  let calls = 0;
  let visited = 0;
  await visitAnalyzerTablePages(async (start, end) => {
    calls++;
    return { roles: [], row_count: calls === 1 ? 1_100 : 100_000, rows: new Array(end - start).fill({}) };
  }, (page) => { visited += page.rows.length; });
  assert.equal(calls, 2);
  assert.equal(visited, 1_100);
});

test("copy stops on an empty inconsistent page instead of looping forever", async () => {
  await assert.rejects(visitAnalyzerTablePages(async () => ({ roles: [], row_count: 5, rows: [] }), () => {}));
});
