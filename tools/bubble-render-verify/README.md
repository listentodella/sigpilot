# bubble-render-verify

Measures the cost of rebuilding the analyzer bubble element list
(`src/components/AnalyzerBubblesOverlay.tsx`).

## Why this exists

Removing the canvas preview path left the DOM elements as the **only** bubble
rendering path. Every pan or zoom makes the backend re-aggregate, which hands the
overlay a new track array, which makes React rebuild the bubble list. Before this
harness there was no number for that rebuild, so there was no way to tell whether
the change was safe or needed an element-reuse scheme on top.

It also exists to answer a question that is easy to get wrong by reading code:
whether the per-frame bubble work is actually significant next to the waveform
draw and the backend render.

## Running

```sh
tools/bubble-render-verify/run.sh
```

Requires Chrome (override with `CHROME_BIN`) and `python3`.

## How it avoids lying to itself

Three guards, each added after a real false reading:

| guard | what it catches |
| --- | --- |
| clock-resolution probe | a `0.00 ms` reading that means "below the clock's floor", not "fast" |
| busy-loop probe | a frozen or virtual clock, which silently reports everything as 0 |
| `MutationObserver` count | a commit that was bailed out or produced no DOM |

Two further details are load-bearing:

- **The page does all its work synchronously inside a deferred module.** A
  deferred module runs before `DOMContentLoaded`, so `--dump-dom` captures the
  finished result and no `--virtual-time-budget` is needed. That matters because
  the virtual clock interacts badly with the component's self-rescheduling
  `requestAnimationFrame` loops: an earlier version of this harness hung for
  minutes and had to be killed.
- **The element window is settled before timing.** `bubbleDomViewport` starts at
  one viewport wide and widens to a padded three-viewport window when the mount's
  passive effects flush. Timing before that settles measures a third of the tree.
  `settle()` performs two throwaway commits to force the flush.

`fixture-build` is reported separately because the fixture arrays are built
outside the timed region — otherwise the number would partly describe the
harness.

## Reading the output

`rebuild` is the case that matters: new track data every commit, which is what a
pan or zoom produces.

Measured on an M-series Mac, headless Chrome, 1350 px viewport, 2 tracks:

| bubbles/track | elements | per commit |
| --- | --- | --- |
| 25 | 16 | 0.13 ms |
| 100 | 60 | 0.45 ms |
| 400 | 256 | 1.53 ms |
| 800 | 520 | 3.10 ms |
| 1600 | 1052 | 6.03 ms |
| 3200 | 2114 | 12.95 ms |

Two things to take from this:

1. **The cost is linear at ~6.9 µs per element.** No cliff, no superlinear
   behaviour — so the budget is simply an element count.
2. **A realistic dense decode fits.** The element window is three viewports wide.
   When the track window is the same width, only the ~2/3 of its bubbles that fall
   inside the element window get an element — which is why 800 bubbles/track
   produces 520 elements, not 800. A few hundred elements lands at 1-3 ms against
   a 16.67 ms frame, next to a backend `analyzer_render` that already costs ~8 ms.
   The budget only breaks past roughly 2000 elements, which needs an implausibly
   dense decode.

`viewport only` is the pure pan case, where the tracks do not change and React
reuses every element (`nodes added/commit=0`). It costs about 4x less per element
than a rebuild — 0.93 ms at 532 elements versus 3.10 ms — which is what makes the
windowed rebuild strategy worthwhile.

## What this means for the code

The numbers say **not to add element reuse keyed on `analyzerBubbleKey`**. That
refactor was the contingency for a rebuild that did not fit the frame budget; at
realistic element counts it does. Revisit only if a real capture shows the
rebuild crossing roughly 1000 elements, which the `elements` column here gives a
way to predict from the decode density.
