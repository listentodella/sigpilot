# PXLogic Logic 2 Bridge

This tool feeds live PXLogic samples into an unmodified official Saleae Logic
application. It keeps Logic 2's GraphServer, renderer, digital trigger, glitch
filter, analyzers, measurements, markers, and `.sal` session handling intact.

The bridge is intentionally outside `saleae-priv`. The desktop client contains
its own Electron/Node runtime, the PXLogic `usb_smoke` binary, bitstreams,
firmware, and the version-locked native host. It loads
`libgraph_server_shared.dylib` and `pythonlibs` directly from the user's
official Logic app.

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
- The official Logic app, version `2.4.46`

The packaged desktop client does not require Node.js, npm, Rust, Cargo, or the
Xcode Command Line Tools on the user's machine. Those tools are build-time
dependencies only.

## Continuous integration

`.github/workflows/build-logic2-bridge.yml` checks the portable bridge layer and
builds the PXLogic `usb_smoke` helper on GitHub-hosted Windows, Linux, macOS
Intel, and macOS Apple Silicon runners. The helper jobs publish prerequisite
artifacts with the hardware resources for platform-porting and diagnostics.
They are not complete Logic bridges. The workflow also builds a runnable
`pxlogic-logic2-bridge-client-macos-arm64` artifact containing a DMG and ZIP.
The application bundle contains:

- the desktop launcher and its private Electron/Node runtime;
- the bridge source and prebuilt native GraphServer host;
- the release `usb_smoke` capture helper;
- the PXLogic FPGA bitstreams and MCU firmware used by that helper.

The archive deliberately does not contain Saleae binaries. At runtime it loads
GraphServer and the Python runtime from the user's official Logic 2.4.46 app.
Windows and Linux artifacts will be added only after their native GraphServer
hooks have independent fingerprints and live-capture validation.

## Desktop client

Open the DMG, move `PXLogic Bridge.app` to Applications, and launch it normally.
The client searches `/Applications`, `~/Applications`, and Spotlight for Saleae
Logic. It displays the detected version, accepts a manually entered or selected
`.app` path, remembers the settings, and remains available from the macOS menu
bar while its window is hidden.

Click `Start Logic 2` after a compatible Logic `2.4.46` installation is shown.
The client launches Logic with the required `--useExistingGraph` and
`--graphPort` arguments. In Logic 2 select the Demo Logic Pro 16 device as the
session device.

Automatic port mode asks macOS for a free loopback TCP port, then passes the
actual value to Logic 2. The port is not fixed by Logic. In fixed mode the
selected value is preferred; if it is occupied, the bridge falls back to an
available port and reports the actual endpoint in the client.

CI builds are unsigned unless Apple signing credentials are provided. For an
unsigned downloaded build, macOS may require the first launch through Finder's
`Open` context-menu action. Public distribution without that prompt requires
Developer ID signing and Apple notarization.

## Command-line development

The bridge core has no third-party Node package dependencies. From a source
checkout with Node.js 18 or newer, a built PXLogic helper, and Xcode Command
Line Tools, it can still be started directly:

```sh
node tools/logic2-bridge/index.cjs \
  --app "/Applications/Saleae Logic.app" \
  --screen-quadrant 3
```

The launcher starts a private GraphServer, exposes an automatically allocated
Logic-facing endpoint, then launches the official app with `--useExistingGraph`.
When capture starts, the bridge follows the channel, sample rate, and voltage
settings sent by Logic 2 and starts PXLogic automatically. Use `--port 12472`
to request a fixed port or `--port auto` explicitly.

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
