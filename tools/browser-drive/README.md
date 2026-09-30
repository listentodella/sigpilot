# browser-drive

Drives the running dev server in headless Chrome over the DevTools Protocol and
reports what the app actually rendered. No dependencies: it uses Node's global
`fetch` and `WebSocket`.

## Why this exists

The desktop app is a Tauri window, but its frontend is served by the same Vite
dev server the browser uses. When something "looks wrong" there is no substitute
for loading it, driving the flow, and measuring the result — reasoning about a
2,500-line canvas component from source is how you end up fixing the wrong thing.

This tool answers questions like:

- Is the waveform canvas drawing anything, or is it a flat line?
- What viewport and tile is the frame pipeline actually holding?
- What did the console say?

## Running

The dev server has to be up first (`pnpm dev`).

```sh
node tools/browser-drive/drive.mjs
```

Environment overrides: `APP_URL` (default `http://127.0.0.1:1420/`),
`CDP_PORT` (default 9336), `CHROME_BIN`.

It writes `/tmp/pxgl/app-capture.png` (full window) and
`/tmp/pxgl/app-clip.png` (the first channel rows, cropped) and prints JSON with
the console log and the ink measured on every canvas.

## Reading the output

`ink` is the count of sampled pixels that differ from the graph background. A
waveform canvas with an ink count in the low thousands is drawing gridlines and
separators only — that is what "the waveform is invisible" looks like
numerically.

The `frame state` step reads `window.__SIGPILOT_FRAMES__`, a dev-only hook
installed by `src/lib/frameStore.ts`. It reports the viewport, the tile range and
the tile pixel width the frame pipeline is holding, which is the fastest way to
tell a wrong viewport from a broken renderer. The same hook is available in the
Tauri devtools console:

```js
__SIGPILOT_FRAMES__.sessions()
__SIGPILOT_FRAMES__.state("session-...")
__SIGPILOT_FRAMES__.health()
```

## Limits

The browser path uses the preview backend, not Rust. It exercises the whole
frontend — viewport protocol, frame loop, canvas — but it cannot tell you
anything about the desktop backend. Use it to rule the frontend in or out, then
confirm on the real thing.

## gesture.mjs — which draw path a real gesture takes

```sh
node tools/browser-drive/gesture.mjs
```

`drive.mjs` answers "is anything on screen". This answers a different question:
`drawCachedWaveLayer` chooses between six ways of producing pixels, and the choice
depends on runtime state — how coarse the retained tile is, whether the worker's
viewport raster happens to cover the current viewport, and which caches are still
on hand. **Which branch a gesture actually takes cannot be read off the source**,
so this drives real wheel-zoom and drag-pan input through the DevTools Protocol
and reports what each frame did.

It needs the probe in `src/lib/waveformDrawProbe.ts`, which installs
`window.__SIGPILOT_DRAW__` in dev builds only.

### Reading the output

Per phase, per draw path: `median`, `p90` and `max` of the **magnification** the
blit applied. 1.0 is pixel exact; above 1 every stroke on screen is that much too
thick, which is what "the edges look unclear while zooming" is numerically.

Report the distribution, not just the max. A `max` far above `p90` means one bad
frame while a render was in flight — a different problem from every frame being
wrong.

`steady state` should report **zero** draws. If it does not, the draw loop is
doing work while nothing has changed.

### What it found

Two things the source did not make obvious:

- `rasterCoversViewport` checked coverage but its comment claimed the raster
  "can be blitted 1:1". Those are different questions: a raster rendered for a
  *wider* range still covers a viewport that has since been zoomed into. Because
  using it short-circuited the request for a fresh one, a zoom-in reused a single
  raster for the whole gesture, magnifying it **up to 30x**. Fixed by adding the
  scale half (`rasterServesViewport`), which drops the zoom-in magnification to a
  bounded ~1.2-1.4x — the one-frame residual a backend-driven viewport would give.
- `blitAnyCachedRaster` tried the **tile** raster before the **viewport** raster.
  In the branch that reaches it the tile raster is by construction the coarser of
  the two, so it was picking the more magnified source. Reordered.

Still present and deliberately not changed: a pan that crosses a tile boundary
shows one frame of the previous tile's raster at up to **36x**. It is 1 frame in
26, and the alternative is a synchronous view-space render of the whole viewport.
Whether one smear frame is worse than one blank frame is a judgement to make on
real hardware, not from a number.

