import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useSessionViewport } from "../../src/lib/useSessionViewport";
import { writeSessionViewport } from "../../src/lib/viewportStore";

interface ProbeStats {
  childRenders: number;
  parentRenders: number;
}

interface ProbeHandle {
  forceParentRender: () => void;
  stats: ProbeStats;
}

// Mirrors the real shape of the workbench: a parent that owns a lot of state and
// a child overlay that has to track the live viewport. The whole point of the
// store is that a viewport write updates the child without the parent rendering.
export function mountProbe(container: HTMLElement): ProbeHandle {
  const stats: ProbeStats = { childRenders: 0, parentRenders: 0 };
  let forceParentRender = () => {};

  function Child(props: { samples: number; sessionId: string; start: number }) {
    stats.childRenders += 1;
    const viewport = useSessionViewport(props.sessionId, props.start, props.samples);
    return createElement(
      "span",
      { id: "child" },
      `${viewport.start}:${viewport.samples}`,
    );
  }

  function Parent() {
    stats.parentRenders += 1;
    const [tick, setTick] = useState(0);
    forceParentRender = () => setTick((current) => current + 1);
    return createElement(
      "div",
      null,
      createElement(Child, { samples: 20, sessionId: "verify", start: 10 }),
      createElement("span", { id: "tick" }, String(tick)),
    );
  }

  const root = createRoot(container);
  flushSync(() => root.render(createElement(Parent)));

  return {
    forceParentRender: () => flushSync(() => forceParentRender()),
    stats,
  };
}

export function publishViewport(sessionId: string, start: number, samples: number) {
  flushSync(() => writeSessionViewport(sessionId, start, samples));
}
