import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { AnalyzerBubblesOverlay } from "../../src/components/AnalyzerBubblesOverlay";
import type { AnalyzerBubble, AnalyzerTrackWindow, WaveformTile } from "../../src/lib/api";
import { analyzerBubbleRoles, createAnalyzerInstance } from "../../src/lib/analyzers";
import type { UiAnalyzerInstance } from "../../src/lib/analyzers";

const VIEWPORT_SAMPLES = 1_350;
const TRACK_CHANNELS = [0, 1];
const TRACK_SPAN_SAMPLES = VIEWPORT_SAMPLES * 3;

function makeBubbles(count: number, startSample: number, spanSamples: number): AnalyzerBubble[] {
  const step = spanSamples / Math.max(1, count);
  const bubbles: AnalyzerBubble[] = [];
  for (let index = 0; index < count; index += 1) {
    const begin = startSample + index * step;
    bubbles.push({
      display_text: [`0x${(index & 0xff).toString(16).toUpperCase().padStart(2, "0")}`],
      end_sample: begin + step * 0.6,
      frame_id_interval: { begin: index, end: index + 1 },
      result_count: 1,
      start_sample: begin,
      type: "SingleBubble",
    });
  }
  return bubbles;
}

function makeTrack(channel: number, role: string, bubbles: AnalyzerBubble[]): AnalyzerTrackWindow {
  return {
    bubbles,
    channel,
    frame_refs: [],
    frames: [],
    next_frame: null,
    next_frame_ref: null,
    previous_frame: null,
    previous_frame_ref: null,
    protocol_markers: [],
    role,
  };
}

function buildAnalyzers(bubblesPerTrack: number, startSample: number, spanSamples: number) {
  return TRACK_CHANNELS.map((channel, index) => {
    const analyzer: UiAnalyzerInstance = createAnalyzerInstance("SPI", [], channel);
    analyzer.id = `probe-analyzer-${index}`;
    // Roles only exist once the channels are assigned; an unconfigured SPI has
    // no bubble tracks at all and the fixture would silently render nothing.
    analyzer.spiMosiChannel = channel;
    analyzer.spiClockChannel = (channel + 1) % 32;
    const roles = analyzerBubbleRoles(analyzer);
    analyzer.renderedTracks = roles.map((role) =>
      makeTrack(role.channel, role.title, makeBubbles(bubblesPerTrack, startSample, spanSamples)),
    );
    return analyzer;
  });
}

interface Measurement {
  /** Bubble elements present at the end of the timed region. */
  elements: number;
  /** Milliseconds for one commit, averaged over the batch. */
  perCommitMs: number;
  /** Milliseconds for the whole batch, so the resolution floor is visible. */
  totalMs: number;
  iterations: number;
  /** Overlay renders observed during the batch. Proves the work was not bailed out. */
  renders: number;
  /** DOM nodes React added during the batch. Proves elements were really built. */
  nodesAdded: number;
  /** Attribute writes during the batch; the imperative geometry pass lands here. */
  attributeWrites: number;
}

interface ProbeHandle {
  describe: () => string;
  /** Milliseconds the clock needs to tick; anything faster reads as 0. */
  clockResolutionMs: () => number;
  /** Milliseconds for a fixed busy loop, proving the clock advances at all. */
  busyLoopMs: () => number;
  /** Cost of building the synthetic fixture, excluded from the commit timing. */
  fixtureBuildMs: (bubblesPerTrack: number, iterations: number) => number;
  /** Width the component measured for itself; 1 means its effects never ran. */
  overlayWidth: () => number;
  /** Commit twice at a size so the element window settles, then report the count. */
  settle: (bubblesPerTrack: number) => number;
  /** New track data every commit — the pan/zoom re-aggregation case. */
  measureRebuild: (bubblesPerTrack: number, iterations: number) => Measurement;
  /** New viewport, identical tracks — the pure pan case. */
  measureViewportOnly: (iterations: number) => Measurement;
  unmount: () => void;
}

/** Analyzer set for one commit. Pre-built so the timing covers React, not the fixture. */
interface Variant {
  analyzers: UiAnalyzerInstance[];
}

export function mountBubbleProbe(container: HTMLElement): ProbeHandle {
  let setVariantRef: (value: Variant) => void = () => {};
  let setViewportRef: (value: { start: number; samples: number }) => void = () => {};
  let renderCount = 0;

  function Probe() {
    renderCount += 1;
    const [variant, setVariant] = useState<Variant>(() => ({
      analyzers: buildAnalyzers(40, 0, TRACK_SPAN_SAMPLES),
    }));
    const [viewport, setViewport] = useState({ samples: VIEWPORT_SAMPLES, start: 0 });
    setVariantRef = setVariant;
    setViewportRef = setViewport;

    return createElement(AnalyzerBubblesOverlay, {
      analyzers: variant.analyzers,
      onGoToFrame: () => {},
      onOpenTableFrame: () => {},
      onSelectFrame: () => {},
      onZoomBubble: () => {},
      rowHeights: [200, 200],
      rowTopInsets: [0, 0],
      sessionId: "probe",
      tile: null as WaveformTile | null,
      viewportSamples: viewport.samples,
      viewportStart: viewport.start,
      visibleChannelIndexes: TRACK_CHANNELS,
    });
  }

  const root = createRoot(container);
  flushSync(() => root.render(createElement(Probe)));

  const countElements = () => container.querySelectorAll(".analyzerBubble").length;

  /**
   * MutationObserver callbacks are microtasks, so records raised by a synchronous
   * batch are still pending when the batch returns. takeRecords() reads them out
   * without yielding, which keeps the counts attributable to the timed region.
   */
  function observe<T>(run: () => T) {
    const observer = new MutationObserver(() => {});
    observer.observe(container, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const value = run();
    const records = observer.takeRecords();
    observer.disconnect();

    let nodesAdded = 0;
    let attributeWrites = 0;
    for (const record of records) {
      nodesAdded += record.addedNodes.length;
      if (record.type === "attributes") attributeWrites += 1;
    }
    return { value, nodesAdded, attributeWrites };
  }

  return {
    describe() {
      const analyzers = buildAnalyzers(10, 0, TRACK_SPAN_SAMPLES);
      const roles = analyzers.map((analyzer) => analyzerBubbleRoles(analyzer).length);
      const tracks = analyzers.reduce((total, analyzer) => total + analyzer.renderedTracks.length, 0);
      return `analyzers=${analyzers.length} bubbleRolesPerAnalyzer=[${roles.join(",")}] renderedTracks=${tracks}`;
    },

    clockResolutionMs() {
      // Spin on the clock until it has advanced enough times to expose its
      // granularity. A measurement below this floor is indistinguishable from 0.
      let last = performance.now();
      let smallest = Number.POSITIVE_INFINITY;
      let advances = 0;
      while (advances < 200) {
        const now = performance.now();
        const delta = now - last;
        if (delta > 0) {
          if (delta < smallest) smallest = delta;
          last = now;
          advances += 1;
        }
      }
      return smallest;
    },

    busyLoopMs() {
      const started = performance.now();
      let sink = 0;
      for (let index = 0; index < 3_000_000; index += 1) sink += index;
      const ms = performance.now() - started;
      // Keep the loop from being optimised away.
      if (sink === Number.MIN_SAFE_INTEGER) throw new Error("unreachable");
      return ms;
    },

    fixtureBuildMs(bubblesPerTrack, iterations) {
      const started = performance.now();
      for (let index = 0; index < iterations; index += 1) {
        buildAnalyzers(bubblesPerTrack, index * 7, TRACK_SPAN_SAMPLES);
      }
      return (performance.now() - started) / iterations;
    },

    overlayWidth() {
      const overlay = container.querySelector(".analyzerBubblesOverlay");
      return overlay ? overlay.clientWidth : 0;
    },

    settle(bubblesPerTrack) {
      // Two throwaway commits at the target size. The first one flushes the
      // mount's pending passive effects, which is what widens `bubbleDomViewport`
      // from one viewport to the padded three-viewport window. Without this the
      // overlay would still be rendering a third of the bubbles and every number
      // below would understate the real tree.
      const first = { analyzers: buildAnalyzers(bubblesPerTrack, 0, TRACK_SPAN_SAMPLES) };
      flushSync(() => setVariantRef(first));
      const second = { analyzers: buildAnalyzers(bubblesPerTrack, 7, TRACK_SPAN_SAMPLES) };
      flushSync(() => setVariantRef(second));
      return countElements();
    },

    measureRebuild(bubblesPerTrack, iterations) {
      // Build every variant up front so the timed region contains only the
      // React commits. Each variant carries a different start sample, which is
      // what a backend re-aggregation after a pan would hand the overlay.
      const variants: Variant[] = [];
      for (let index = 0; index <= iterations; index += 1) {
        variants.push({ analyzers: buildAnalyzers(bubblesPerTrack, index * 7, TRACK_SPAN_SAMPLES) });
      }

      // Land on the first variant outside the timed region.
      flushSync(() => setVariantRef(variants[0]));
      const rendersBefore = renderCount;

      const observed = observe(() => {
        const started = performance.now();
        for (let index = 1; index <= iterations; index += 1) {
          flushSync(() => setVariantRef(variants[index]));
        }
        return performance.now() - started;
      });

      return {
        attributeWrites: observed.attributeWrites,
        elements: countElements(),
        iterations,
        nodesAdded: observed.nodesAdded,
        perCommitMs: observed.value / iterations,
        renders: renderCount - rendersBefore,
        totalMs: observed.value,
      };
    },

    measureViewportOnly(iterations) {
      flushSync(() => setViewportRef({ samples: VIEWPORT_SAMPLES, start: 0 }));
      const rendersBefore = renderCount;

      const observed = observe(() => {
        const started = performance.now();
        for (let index = 1; index <= iterations; index += 1) {
          flushSync(() => setViewportRef({ samples: VIEWPORT_SAMPLES, start: index * 5 }));
        }
        return performance.now() - started;
      });

      return {
        attributeWrites: observed.attributeWrites,
        elements: countElements(),
        iterations,
        nodesAdded: observed.nodesAdded,
        perCommitMs: observed.value / iterations,
        renders: renderCount - rendersBefore,
        totalMs: observed.value,
      };
    },

    unmount() {
      flushSync(() => root.unmount());
    },
  };
}
