# PXLogic Logic 2 Bridge

This tool feeds live PXLogic samples into an unmodified official Saleae Logic
application. It keeps Logic 2's GraphServer, renderer, digital trigger, glitch
filter, analyzers, measurements, markers, and `.sal` session handling intact.

The bridge is intentionally outside `saleae-priv` and has no npm dependencies.
It reuses the PXLogic `usb_smoke` binary, bitstreams, and firmware from this
repository, and loads `libgraph_server_shared.dylib` and `pythonlibs` directly
from the official Logic app.

## Support boundary

The native callback hook is currently verified for the official macOS arm64
Logic `2.4.46` GraphServer. The hook checks the GraphServer Mach-O UUID and
function prologue before patching; an unknown version is refused instead of
being patched optimistically. Supporting another Logic version requires a new
verified hook record and a separate validation run.

| Layer | macOS arm64 | macOS x64 | Windows x64 | Linux x64 |
| --- | --- | --- | --- | --- |
| WebSocket proxy and data conversion | Tested | Tested in CI | Tested in CI | Tested in CI |
| PXLogic `usb_smoke` helper | Supported by the PXLogic workspace | Supported by the PXLogic workspace | Supported by the PXLogic workspace | Supported by the PXLogic workspace |
| Logic 2.4.46 GraphServer injection | Verified | Not implemented | Not implemented | Not implemented |
| Complete live bridge | **Supported** | Not supported | Not supported | Not supported |

Building the portable JavaScript and PXLogic USB layers on another operating
system does not make its native injection path compatible. Each Logic build has
a platform-specific module format, binary fingerprint, calling convention, and
code-patching implementation. A platform is listed as supported only after
those details and a real capture have been verified.

## Prerequisites

- macOS arm64
- Node.js 18 or newer (no third-party Node packages)
- The official Logic app, version `2.4.46`
- A built PXLogic helper:

  ```sh
  cargo build --release --bin usb_smoke
  ```

- Xcode Command Line Tools (`xcrun clang`) for the first native-host build

No `npm install` is required. The native host is compiled into `tools/logic2-bridge/build`
on first run and the official app supplies the GraphServer runtime.

## Continuous integration

`.github/workflows/build-logic2-bridge.yml` checks the portable bridge layer and
builds the PXLogic `usb_smoke` helper on GitHub-hosted Windows, Linux, macOS
Intel, and macOS Apple Silicon runners. The helper jobs publish prerequisite
artifacts with the hardware resources for platform-porting and diagnostics.
They are not complete Logic bridges. The workflow also builds a runnable
`pxlogic-logic2-bridge-macos-arm64` artifact containing:

- the bridge source and prebuilt native GraphServer host;
- the release `usb_smoke` capture helper;
- the PXLogic FPGA bitstreams and MCU firmware used by that helper.

The archive deliberately does not contain Saleae binaries. At runtime it loads
GraphServer and the Python runtime from the user's official Logic 2.4.46 app.
Windows and Linux artifacts will be added only after their native GraphServer
hooks have independent fingerprints and live-capture validation.

## Start

From the PXLogic repository:

```sh
node tools/logic2-bridge/index.cjs \
  --app "/Applications/Saleae Logic.app" \
  --screen-quadrant 3
```

The launcher starts a private GraphServer, exposes the Logic-facing endpoint
at `ws://127.0.0.1:12472/saleae`, then launches the official app with
`--useExistingGraph`. In Logic 2 select the Demo Logic Pro 16 device as the
session device. When capture starts, the bridge follows the channel, sample
rate, and voltage settings sent by Logic 2 and starts PXLogic automatically.

For the local app used during development:

```sh
node tools/logic2-bridge/index.cjs \
  --app "/Volumes/tp7100s/work/logic2-anti/Saleae Logic.app" \
  --screen-quadrant 3 \
  --remote-debugging-port 9227
```

Use `--enabled-channels 0,1,2,3` only as the initial fallback. The Logic UI
selection is authoritative after the session sends `EnableChannels`.

## Data and control semantics

- PXLogic always receives `--glitch-filter` (one hardware sample period).
- Logic 2's Glitch Filter remains GraphServer software post-processing.
- Logic 2 digital triggers remain GraphServer real-time processing. Trigger
  conditions are deliberately not sent to PXLogic hardware.
- PXLogic Cross stripes are converted to the Logic Pro 16 callback layout
  before they enter the native GraphServer callback.
- The bridge uses `stream` mode and continuously forwards samples; GraphServer
  decides trigger time and Logic 2 decides when the post-trigger interval ends.

## Diagnostics

`--dry-run` validates the app version, GraphServer resources, PXLogic helper,
firmware, bitstreams, and native host build without launching Logic:

```sh
node tools/logic2-bridge/index.cjs \
  --app "/Applications/Saleae Logic.app" \
  --dry-run
```

GraphServer logs are written under:

```text
~/Library/Application Support/PXLogic/logic2-bridge/graphio.log
```

## Verified live path

The standalone bridge was verified with the official Logic `2.4.46` app and a
PX-Logic U3 device at 50 MS/s with eight enabled digital channels. A Logic UI
D4 rising-edge trigger with a one-second post-trigger duration produced:

```text
Logic digital-trigger=D4 rising (GraphServer only)
pxlogic-hardware-glitch-filter=1T pxlogic-hardware-trigger=off
[capture:info] ... trigger=false ... glitch_filter=true
StopCapture
```

This proves that the PXLogic hardware streams continuously while the unmodified
GraphServer detects the edge and Logic 2 ends the capture after its configured
post-trigger interval.
