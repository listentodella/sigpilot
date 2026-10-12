# GitHub Workflows

## Desktop packages

`build-cross-platform.yml` runs workspace Rust tests, UI logic tests, and the
frontend build, then produces these client artifacts:

- macOS arm64/x64: `.app.zip`
- Windows x64: portable `.zip` containing the application `.exe` and resources
- Linux x64: `.AppImage` and `.deb`

All jobs use standard GitHub-hosted runners: checks and Linux use `ubuntu-22.04`,
Windows uses `windows-2022`, and macOS uses `macos-15` (Apple Silicon) and
`macos-15-intel` (Intel). No persistent self-hosted machine is required.
Node 22 is installed before pnpm 11; pnpm is available before its store cache is
configured. Rust caches include compiled targets in the workspace `target`
directory, with separate debug-check and target-specific release keys.

Pushes of `v*` tags build all platforms. Manual dispatch offers `windows` (the
default, bypassing the separate checks job) or `all`. Every client job requires
successful native-runtime preparation; Windows-only dispatch does not bypass
that requirement. Manual/remote dispatch does not automatically publish a
release, even when it targets a tag. Only tag pushes publish successful client
artifacts, allowing a successful platform package through if another platform
fails. Releases download only `sigpilot-*` artifacts, never native-runtime
archives, and do not create an empty release when all client builds fail or skip.
MSI and NSIS installers are intentionally not generated.

## Separate native runtime

`native-runtime.yml` is both a reusable workflow called separately for Windows,
Linux and macOS by the desktop workflow, and an independently manually
dispatchable workflow with `windows`/`linux`/`macos`/`all` selection. A failed
native build on one OS does not block the other OS client jobs. It builds the
vendored Saleae standalone sidecar, compatibility runtime and analyzer plugins,
plus the PXView sigrok sidecar and its C/Python decoder catalogs. Native
compilation and full decoder conformance validation belong to this workflow,
not to the client packaging jobs.

Native runtime caches are keyed by native source inputs, platform, hosted
runner image identity, and macOS Homebrew runtime dependency versions. A cold
build (or a changed source/image/dependency key)
compiles and validates native code first, then caches the runtime archive. A
warm cache hit transfers the runtime and runs integrity checks/smoke tests
without recompiling native code. Client Rust/UI changes do not themselves
require a native rebuild. Caches and uploaded artifacts have finite retention:
if an artifact expires, run the workflow again to upload it from the cache;
if that cache was also evicted, the workflow rebuilds it from source.

The native workflow uploads these artifacts, each containing the matching
`native-runtime-<platform>.tar.gz`:

- `native-runtime-windows-x64`
- `native-runtime-linux-x64`
- `native-runtime-macos-arm64`
- `native-runtime-macos-x64`

Each archive contains native directories and `native-runtime-manifest.json`
relative to `resources/native`. Client jobs download their matching artifact
into the runner temporary directory and run `node scripts/native-runtime.mjs
install <archive> <platform>`. Installation validates source identity, platform,
and manifest checksums/integrity, and restores executable modes. Client jobs
set `SIGPILOT_PREBUILT_NATIVE=1`: the Tauri before-build hook verifies the manifest
and fails on a missing/stale/corrupt runtime rather than launching Bash or a
native compiler. Windows client packaging needs no MSYS2 installation; MSYS2
is confined to native-runtime production. macOS retains Homebrew dependencies
because the sigrok runtime dynamically references Homebrew libraries/Python.
Local builds without the prebuilt flag compile native code automatically when
the source fingerprint or payload changes. Unchanged resources skip both
compilation and copying, including repeated Tauri hook calls. Saleae sidecar
and runtime compilation both use Ninja; generated compatibility sources are
only rewritten when their content changes. Set `SIGPILOT_FORCE_NATIVE_BUILD=1`
to bypass local resource reuse.

## Validation and acceptance

Workspace/UI tests remain intact. Native-runtime production independently
validates full conformance. Windows repeats catalog, generic C/Python decode,
Saleae probe, and SPI fixture smoke tests from the staged portable bundle via
`scripts/smoke-native-runtime.mjs` (which sets its Python environment internally).
Linux repeats both backends from the extracted AppImage. macOS checks the
bundled Saleae probe/SPI fixture and both native backends with the same Node
smoke script. Runtime caching does not remove these final-package checks.

The cross-platform acceptance scope is USB discovery/capture, `.pxl` and
`.pxcap` open/save, supported base imports, Saleae Native, and Sigrok Native.
Saleae GraphServer is not bundled; the standalone runtime supplies the native
analyzers without requiring Logic 2.

## Measuring the migration

Run the desktop workflow with `platform=windows` twice from the same revision.
The first run populates the native runtime and Rust target caches. The second
run should report a native runtime cache hit, skip MSYS2 installation and native
compilation, and reuse compiled Rust dependencies. Compare job/step durations;
do not compare a cold hosted run to a warm self-hosted build. Runner image,
toolchain or native dependency changes intentionally trigger a cold rebuild.
This configuration uses standard hosted runners, not paid larger runners.
GitHub's public-repository standard-runner policy still has concurrency,
cache/artifact retention and storage limits; free compute is not unlimited
artifact storage.
