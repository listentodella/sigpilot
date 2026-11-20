# Protocol trigger panel verification

Build and run from the repository root:

```sh
pnpm exec vite build --config tools/protocol-trigger-verify/vite.config.ts
node tools/protocol-trigger-verify/run.mjs
```

The fixture renders the production `ProtocolTriggerPanel`, analyzer settings and
configuration validator in Chromium. It explicitly supplies desktop component
props; it does not emulate a Tauri runtime, execute a device acquisition, or
claim capture end-to-end coverage. The Rust Demo/controller tests cover capture
execution separately.

The runner uses a temporary loopback HTTP server, an isolated browser profile
and one headless browser, and cleans them up on exit. On macOS it uses the
installed Google Chrome; on Linux it uses `chromium`. Browser launch and binding
to loopback require the corresponding execution permissions.

Checks cover UART/I2C/SPI conditions, timing windows, invalid inputs and modes,
busy/read-only/browser controls, English and Chinese layout, and collapse/state
preservation. Results and screenshots are written under `.verification/`.
