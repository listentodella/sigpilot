# waveform-gl-verify

Verifies the WebGL2 waveform renderer (`src/workers/waveformRenderer.worker.ts`)
end to end.

## Why this exists

The renderer runs inside a Web Worker against an `OffscreenCanvas`, so
`node --test` cannot reach it and `tsc` cannot validate GLSL. That leaves the
riskiest part of the renderer — shader compilation, the fixed 30-vertex-per-bin
instancing layout, the bin texture addressing, and the GPU viewport transform —
covered by nothing.

This harness closes that gap:

1. Vite bundles the **real** production worker module into a plain ES module.
2. A page shims `self` so the worker module runs unmodified on the main thread.
3. A synthetic square wave (100 bins: low, one dense transition, high, low) is
   rendered through both the tile path and the transform path.
4. The resulting bitmap is drawn to a canvas and specific pixel columns are read
   back and printed.

## Running

```sh
tools/waveform-gl-verify/run.sh
```

Requires Chrome (override with `CHROME_BIN`) and `python3`.

## Reading the output

| column | expectation |
| --- | --- |
| `x=10` level-low | ink only at `lowY`, one pixel tall |
| `x=51` dense fill | ink spanning `highY..lowY` at **alpha 255** |
| `x=100` level-high | ink only at `highY`, one pixel tall |
| `x=149` / `x=151` | partial alphas, proving multisampling is on |
| `x=150` transition | a vertical run between the two levels |
| transform `x=50` / `x=150` | the levels swap, proving the retained bins were re-rasterised at a new transform without a re-upload |
| busy region | `spread=0` — see below |

The alpha and height expectations come from Logic's own digital renderer
(`src/app/utils/DigitalCanvas.tsx` in the recovered source): a
`ONE_OR_MORE_TRANSITIONS` run is a **full-opacity** rectangle spanning the lane,
an `ALWAYS_HIGH` / `ALWAYS_LOW` run is a **1 pixel** line, and there are no
per-transition strokes. Deviating from any of those makes a busy region look
washed out or striped.

## The busy region check

The last phase renders 100 bins that all carry both levels and change level at
every boundary — what a signal faster than one pixel looks like — and measures
the total alpha of every interior column.

```
busy region column ink min=21440 max=21440 spread=0
  -> uniform block
```

`spread` is the whole point. A dense region must read as one solid block. If the
renderer draws a riser at every bin boundary the interior becomes striped and
`spread` jumps by an order of magnitude (measured at 1162 before the rule was
added). A non-zero spread here means someone reintroduced per-bin transitions
next to dense bins.

**This check only discriminates if the bins actually change level at every
boundary.** An earlier version used `flags = FIRST|LAST|HIGH|LOW`, where
`prevLast == isFirst` means no riser was ever drawn — it passed with `spread=0`
while proving nothing. The bins now use `FIRST|HIGH|LOW` (first=high, last=low)
so every boundary differs. If you change this fixture, verify it still fails
against the broken rule before trusting it.

## Failure modes

A failing shader compile shows up as `FAIL <shader> :: <info log>`, and a failing
link as `FAIL link <program>`. `NO_WEBGL2` means the Chrome launch is missing
`--enable-unsafe-swiftshader`.
