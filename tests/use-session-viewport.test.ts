import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSessionViewport } from "../src/lib/useSessionViewport.ts";
import { writeSessionViewport } from "../src/lib/viewportStore.ts";

function Probe({ sessionId, start, samples }: { sessionId?: string; start: number; samples: number }) {
  const viewport = useSessionViewport(sessionId, start, samples);
  return createElement("span", null, `${viewport.start}:${viewport.samples}`);
}

test("falls back to the parent viewport before anything is published", () => {
  const html = renderToStaticMarkup(createElement(Probe, { sessionId: "hook-fresh", start: 12, samples: 34 }));
  assert.equal(html, "<span>12:34</span>");
});

test("prefers the published viewport over the parent viewport", () => {
  writeSessionViewport("hook-live", 99, 7);
  const html = renderToStaticMarkup(createElement(Probe, { sessionId: "hook-live", start: 12, samples: 34 }));
  assert.equal(html, "<span>99:7</span>");
});

test("without a session id the parent viewport always wins", () => {
  const html = renderToStaticMarkup(createElement(Probe, { start: 5, samples: 6 }));
  assert.equal(html, "<span>5:6</span>");
});
