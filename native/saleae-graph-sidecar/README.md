# PXLogic Saleae Graph Sidecar

This macOS arm64 sidecar dynamically loads a user-provided Saleae Logic 2
runtime and exposes the original GraphServer JSON protocol outside the Tauri
process. Saleae binaries are not copied into this repository or linked into
PXLogic.

Build and verify against an installed or extracted Logic 2.4.43 runtime:

```sh
export PXLOGIC_SALEAE_RUNTIME_ROOT="/path/to/Saleae Logic.app/Contents/Resources/macos-arm64"
native/saleae-graph-sidecar/verify.sh
native/saleae-graph-sidecar/verify-sal-roundtrip.sh
```

`--relay` accepts one original GraphServer request envelope on stdin and emits
the resulting response envelopes as NDJSON. The first consumer is the `.sal`
capture importer, which asks the original `DigitalStore` implementation to
deserialize Logic 2 capture data without expanding the complete sample stream.

Convert a `.sal` capture to a sparse transition manifest:

```sh
target/native/saleae-graph-sidecar/pxlogic-saleae-graph-sidecar \
  --runtime-root "$PXLOGIC_SALEAE_RUNTIME_ROOT" \
  --convert-sal input.sal output-directory
```

The output directory contains `manifest.json` and one public Saleae digital
binary per captured channel. The Tauri host deletes this conversion directory
after parsing the transition indexes.

Create a Logic 2 `.sal` from a PXLogic transition manifest:

```sh
target/native/saleae-graph-sidecar/pxlogic-saleae-graph-sidecar \
  --runtime-root "$PXLOGIC_SALEAE_RUNTIME_ROOT" \
  --create-sal input-manifest.json output.sal
```

The sidecar validates PXLogic's private seed stores with the original
`DigitalStore`, asks the original runtime to serialize each store, writes a
Logic 2 version-16 `meta.json`, and packages the result. Constant channels are
preserved during import even though Logic's `ExportNode` reports no data range
for stores without transitions.
