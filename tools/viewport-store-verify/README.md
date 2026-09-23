# viewport-store-verify

Verifies the render-isolation claim behind `src/lib/viewportStore.ts` and
`src/lib/useSessionViewport.ts`.

## The claim

A live viewport change must re-render only the components that subscribe to it,
and must never re-render the workbench component that owns all the other state.
That is the entire reason the store exists: overlays used to depend on the
workbench re-rendering, so every wheel tick reconciled the whole application.

## Why this is not a `node --test` case

- `useSyncExternalStore`'s subscription path needs a real DOM. `node --test` has
  none, and no test renderer is installed.
- `react-dom/server` only exercises `getServerSnapshot`, i.e. the fallback
  branch. It never subscribes, so it cannot observe a post-mount write.

The store's own semantics (per-session isolation, no-op on unchanged values,
listener release) *are* covered by `tests/viewport-store.test.ts`, and the
fallback branch by `tests/use-session-viewport.test.ts`.

## What this harness adds

`entry.ts` mounts a probe shaped like the real workbench: a `Parent` that owns
unrelated state, and a `Child` that subscribes through the real hook. Writes go
through `flushSync` so each assertion observes a settled tree, and the parent and
child render counts are compared.

## Running

```sh
tools/viewport-store-verify/run.sh
```

Requires Chrome (override with `CHROME_BIN`) and `python3`.

## Expected output

```
PASS initial child uses the parent fallback
PASS initial parent renders once
PASS child follows the published viewport
PASS child re-rendered
PASS parent did NOT re-render          <- the point
PASS child follows a second publish
PASS parent still did NOT re-render
PASS parent re-renders on its own state
PASS child keeps the published viewport
PASS child ignores other sessions
ALL CHECKS PASSED
```

If `parent did NOT re-render` ever fails, the store has been wired back through
React state and the optimisation is gone.
