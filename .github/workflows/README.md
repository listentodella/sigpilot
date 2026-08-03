# GitHub Workflows

`build-cross-platform.yml` is the active desktop build. It runs workspace and
UI tests, then produces these artifacts:

- macOS arm64/x64: `.app.zip`
- Windows x64: portable `.zip` containing the application `.exe` and resources
- Linux x64: `.AppImage` and `.deb`

Checks, Windows and Linux run on the repository's `self-hosted` `X64` runners.
macOS continues to use GitHub-hosted Apple Silicon and Intel runners.

Every platform builds the vendored Saleae standalone sidecar, compatibility
runtime, and analyzer plugins without requiring Logic 2 or Python. Windows and
Linux also build the vendored PXView sigrok sidecar and its C/Python decoder
catalog. The workflow probes prepared resources and executes real decode
fixtures before packaging. Linux repeats both backends from the extracted
AppImage, while Windows repeats them from the staged portable bundle. MSI and
NSIS installers are intentionally not generated.

The cross-platform acceptance scope is USB discovery/capture, `.pxl` and
`.pxcap` open/save, supported base imports, Saleae Native, and Sigrok Native.
Saleae GraphServer is not bundled; the standalone runtime supplies the native
analyzers on all supported platforms.

Only `v*` tags trigger the workflow. The release job publishes every artifact
that completed successfully, even when another platform build failed, and does
not create an empty release when all platform builds are skipped or fail.
