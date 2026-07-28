# GitHub Workflows

`build-cross-platform.yml` is the active desktop build. It runs workspace and
UI tests, then produces these artifacts:

- macOS arm64/x64: `.app.zip`
- Windows x64: NSIS `.exe` and WiX `.msi`
- Linux x64: `.AppImage` and `.deb`

Checks, Windows and Linux run on the repository's `self-hosted` `X64` runners.
macOS continues to use GitHub-hosted Apple Silicon and Intel runners.

Windows and Linux build the vendored PXView sigrok sidecar and its C decoder
modules on the target runner. The workflow bundles the required shared
libraries, Python standard library, Python decoder catalog, FPGA bitstreams and
native C decoder modules. It probes the prepared resources before packaging;
Linux additionally extracts the finished AppImage and probes the sidecar from
inside its payload.

The cross-platform acceptance scope is USB discovery/capture, `.pxl` and
`.pxcap` open/save, supported base imports, and the verified native sigrok
runner (UART, I2C, SPI, I2S, CAN, CAN-FD, LIN and Simple Parallel). Saleae
GraphServer/analyzer runtimes remain macOS-only and are not required by the
Windows or Linux jobs. `.sal` import/export is therefore macOS-only.

Pushes and pull requests for `codex/graph-server-32ch`, `main` and `master`
trigger the workflow. A `v*` tag publishes all successful artifacts to a GitHub
release.
