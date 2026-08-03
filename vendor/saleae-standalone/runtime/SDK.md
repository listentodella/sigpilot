# Standalone SDK integration

## Status

This repository is usable as a source-distributed preview SDK. It exposes:

- a C ABI in `include/saleae_compat.h`;
- a Rust library crate in `rust/`;
- Saleae analyzer plugins built from the official open-source sources;
- sparse-transition decoding independent of any capture driver or file format.

It is not yet a versioned binary SDK. The verified target is macOS arm64. Keep
`libsaleae_compat.dylib` and the selected `lib*_analyzer.so` files together at
runtime. Linux and Windows require build-system and ABI validation.

An installed bundle contains the C header in `include/` and the compatibility
library plus selected plugins in `Analyzers/`.

## Build

Requirements: CMake 3.20+, Ninja, a C++17 compiler, and Rust.

```sh
cmake -S runtime -B runtime/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build runtime/build
cargo test --manifest-path runtime/rust/Cargo.toml
```

Build and install only the analyzers used by a product:

```sh
cmake -S runtime -B runtime/build-core -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DSALEAE_ANALYZERS='i2c;spi;can' \
  -DCMAKE_INSTALL_PREFIX="$PWD/runtime/dist"
cmake --build runtime/build-core
cmake --install runtime/build-core
```

For the example above, the installed runtime contains only the compatibility
library and I2C/SPI/CAN plugins. `SALEAE_ANALYZERS=all` remains available for a
development build that exercises the complete analyzer catalog.

The CMake project expects this repository layout because it consumes
`sdk/AnalyzerSDK` and `analyzers/*` as source dependencies.

## Use from Rust

Add the crate as a path or Git dependency. Until the repository is packaged,
set the native library directory while building the consumer:

```toml
[dependencies]
saleae-runtime = { path = "/path/to/saleae/runtime/rust" }
```

```sh
export SALEAE_COMPAT_LIB_DIR=/path/to/saleae/runtime/build/lib
export SALEAE_ANALYZER_PLUGIN_DIR=/path/to/saleae/runtime/build/lib
export DYLD_LIBRARY_PATH=/path/to/saleae/runtime/build/lib
cargo run
```

The Rust library has no default Cargo features and no third-party Rust
dependencies. Enable `capture` only for transition-manifest/legacy `.sal`
ingestion. Enable `cli` for the development command-line and `validation` for
CSV golden tests. Product integrations that feed acquisition transitions
should leave all features disabled.

`SALEAE_COMPAT_LIB_DIR` is a link-time setting. Cargo does not propagate a
dependency crate's rpath to the consumer executable, so development runs on
macOS also need `DYLD_LIBRARY_PATH`. For packaged applications, copy
`libsaleae_compat.dylib` beside the executable and add an `@loader_path` rpath,
or use the application's normal dylib bundling/signing process.

Decode the sparse output of any capture source:

```rust
use saleae_runtime::{decode_transitions, default_plugin, InputChannel};

let channels = vec![
    InputChannel {
        setting_title: "SDA".into(),
        channel_index: 0,
        initial_high: true,
        transitions: sda_edges,
    },
    InputChannel {
        setting_title: "SCL".into(),
        channel_index: 1,
        initial_high: true,
        transitions: scl_edges,
    },
];
let decoded = decode_transitions(
    &default_plugin("I2C")?,
    sample_rate_hz,
    &channels,
    &[],
)?;
```

Each transition is an absolute sample index at which the digital level
toggles. Values must be strictly increasing within each channel. Channel
setting titles must match those exposed by the analyzer, such as `SDA` and
`SCL` for I2C. Use `Session::channel_setting_titles()` to discover them.

For analyzer options, pass `AnalyzerSettingValue` values before decoding. Use
`Session` directly when incremental control is needed.

## Use from C or C++

Link against `libsaleae_compat` and include `include/saleae_compat.h`. The C API
owns a session and returns borrowed frame views. Copy returned strings and byte
slices before destroying the session. Load one analyzer plugin per session with
`sr_session_create`, configure channels/settings, commit, run, then enumerate
FrameV2 and legacy frames.

## Optional capture tooling

`decode_transitions` has no Logic dependency. The `.sal` convenience reader has
separate constraints:

- older DigitalStore captures use the private Logic Graph sidecar path;
- current DigitalStore v4 captures must first be exported through Logic 2's
  Automation API with `scripts/export_sal_v4.py`;
- a generated `manifest.json` can be opened with
  `sal::open_transition_manifest` without Logic installed.

These dependencies are development/validation tools and are not part of the
core SDK bundle. Do not enable them in a decoding product unless proprietary
Logic capture ingestion is explicitly required.

## Confidence and limits

Golden captures contain 1,771,857 Logic 2 CSV rows across 18 analyzer
configurations. Sixteen analyzers match Logic 2 frame counts exactly; MIDI has
one extra terminal frame and Atmel SWI has one missing terminal frame. Strict
field/time comparisons currently cover Simple Parallel, SPI, Async Serial,
I2C, CAN, and LIN. See `VALIDATION.md` for the detailed evidence.

Treat the runtime as suitable for integration experiments and controlled use,
not as a compatibility guarantee for every analyzer or platform. Pin the
repository revision and run a protocol-specific golden test in the consumer.
