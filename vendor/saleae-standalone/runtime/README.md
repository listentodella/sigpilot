# Standalone compatibility runtime

This runtime runs Saleae analyzer source outside the Logic UI. It keeps the
C++ ABI inside `saleae_compat`, exposes a stable C API, and consumes that API
from Rust. See [SDK.md](SDK.md) for embedding, deployment, and compatibility
limits.

Build it with:

```sh
cmake -S runtime -B runtime/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build runtime/build
cargo test --manifest-path runtime/rust/Cargo.toml
```

The default Rust library is the acquisition-independent decoder core and has no
third-party Rust dependencies. Build the `.sal`/CSV development CLI explicitly:

```sh
cargo run --features cli --manifest-path runtime/rust/Cargo.toml -- --help
```

Feature boundaries:

- default: sparse transition decoding only;
- `capture`: transition manifests and legacy `.sal` conversion hooks;
- `cli`: capture/decode/simulation development commands;
- `validation`: Logic CSV golden comparison tests.

Logic.app, GraphServer, Automation, and Python are validation/import tools only.
They are not required by the default library or installed CMake SDK bundle.

## Decode Logic 2 captures

Inspect a `.sal` capture and its saved analyzer settings:

```sh
cargo run --manifest-path runtime/rust/Cargo.toml -- \
  inspect assets/demo-i2c.sal
```

Decode with the compatible saved analyzer (I2C for this file):

```sh
cargo run --manifest-path runtime/rust/Cargo.toml -- \
  decode assets/demo-i2c.sal --limit 20
```

Decode SPI and emit paged JSON:

```sh
cargo run --manifest-path runtime/rust/Cargo.toml -- \
  decode assets/demo-spi.sal --analyzer SPI \
  --format json --offset 1000 --limit 100
```

Saved channel and NumberList settings are restored automatically. They can be
overridden explicitly:

```sh
cargo run --manifest-path runtime/rust/Cargo.toml -- \
  decode capture.sal --analyzer SPI \
  --channel MOSI=5 --channel MISO=0 --channel Clock=3 \
  --channel Enable=4 --setting "Clock State=0" \
  --setting "Clock Phase=0"
```

Logic's internal `digital-N.bin` files are private serialized DigitalStores.
The reader follows the same sparse path as PXLogic: Logic's original
GraphServer converts them to the public Saleae digital binary format, then
Rust validates and converts transition times to absolute `u64` sample indexes.
This avoids expanding long captures into one byte per sample.

The CLI locates the Logic runtime and PXLogic Graph sidecar automatically in
this workspace. Other installations can set:

```sh
export SALEAE_LOGIC_RUNTIME_ROOT="/path/to/Logic.app/Contents/Resources/macos-arm64"
export SALEAE_GRAPH_SIDECAR="/path/to/pxlogic-saleae-graph-sidecar"
```

The test waveforms are generated independently in Rust. The current suite
covers a normal write, NAK, repeated START followed by a read, a STOP in the
ACK slot, exact sample ranges, timing-scale invariance, and agreement between
legacy `Frame` bytes and structured FrameV2 fields.

An optional differential test expands the same edge arrays into raw samples
and decodes them with sigrok's unrelated Python I2C implementation:

```sh
cargo test --manifest-path runtime/rust/Cargo.toml -- --ignored
```

That test requires `sigrok-cli` on `PATH`. See [VALIDATION.md](VALIDATION.md)
for the evidence, limitations, and the next validation stage.

This runtime is not yet a drop-in replacement for the complete Saleae host.
The SDK compatibility surface grows analyzer by analyzer under protocol
fixtures and Logic-exported golden files.
