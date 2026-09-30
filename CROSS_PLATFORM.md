# Cross-Platform Build Configuration

## Platform-Specific Feature Flags

To handle platform differences, this project uses conditional compilation:

```rust
// macOS-only features
#[cfg(target_os = "macos")]
fn macos_specific_function() {
    // Uses objc2, block2, etc.
}

// Non-macOS fallback
#[cfg(not(target_os = "macos"))]
fn macos_specific_function() {
    // Stub or alternative implementation
}
```

## Cargo Features

The project uses feature flags to control platform-specific dependencies:

- `rusb-transport`: Enables USB device support (enabled by default on all platforms)

## Platform-Specific Dependencies

### macOS Only
These dependencies are only compiled on macOS:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
block2 = "0.6"
objc2 = "0.6"
objc2-app-kit = "0.3"
objc2-foundation = "0.3"
objc2-web-kit = "0.3"
```

### All Platforms
Core dependencies available on all platforms:

- `rusb`: USB device access
- `tauri`: Cross-platform desktop framework
- `serde`, `serde_json`: Serialization
- All `sigpilot-*` workspace crates

## Platform Feature Matrix

| Feature | Implementation | Platform Support |
|---------|----------------|------------------|
| USB Device Detection | `rusb` | All |
| Capture | `sigpilot-core` | All |
| Sigrok Decoders | Native sidecar | All |
| Saleae native runtime | macOS dylib | macOS only |
| Native Screenshot | WKWebView API | macOS only |
| File I/O | Standard Rust | All |

## Building for Different Platforms

### macOS
```bash
# Apple Silicon
cargo build --release --target aarch64-apple-darwin

# Intel
cargo build --release --target x86_64-apple-darwin
```

### Windows
```bash
cargo build --release --target x86_64-pc-windows-msvc
```

### Linux
```bash
cargo build --release --target x86_64-unknown-linux-gnu
```

## Testing Cross-Platform Code

When adding new features, ensure they work on all platforms:

1. Use `#[cfg(target_os = "...")]` for platform-specific code
2. Provide stubs or fallbacks for unsupported platforms
3. Test compilation on all target platforms before merging
4. Document platform limitations in user-facing documentation

## CI/CD Integration

The `build-cross-platform.yml` workflow builds all supported desktop targets.
Windows and Linux use the repository's self-hosted x64 runners. Windows uses an
MSYS2 UCRT64 toolchain for the native sigrok sidecar while the Tauri application
itself uses the Rust MSVC target. Linux bundles the sidecar's non-system shared
libraries. Both packages include the Python standard library, decoder catalog,
native C decoder modules and FPGA bitstreams, so target machines do not need a
separate sigrok or Python installation.
