# Saleae Logic 2.4.43 analyzer runtime

This directory vendors the macOS arm64 analyzer runtime subset used by PXLogic's Saleae Native decoder backend.

Source: Saleae Logic 2.4.43, `Contents/Resources/macos-arm64`.

Included files:

- `libAnalyzer.dylib`
- `Analyzers/libserial_analyzer.so`
- `Analyzers/libi2c_analyzer.so`
- `Analyzers/libspi_analyzer.so`
- `Analyzers/libi2s_analyzer.so`
- `Analyzers/libcan_analyzer.so`
- `Analyzers/liblin_analyzer.so`
- `Analyzers/libsimple_parallel_analyzer.so`

This is the minimal runtime needed for protocol decode.

Saleae `.sal` graph import/export also needs `libgraph_server_shared.dylib` plus a Python runtime subset. PXLogic vendors that part as `../saleae-runtime-graph-2.4.43-macos-arm64.tar.gz`; `scripts/prepare-tauri-resources.sh` extracts it into the same runtime directory during dev and packaging.
