# Validation status

## What is proven now

The standalone path is real and end to end:

1. The official Saleae I2C and SPI analyzer sources are rebuilt as plugins
   against `libsaleae_compat`.
2. The Rust host loads that plugin through the stable C ABI.
3. Rust supplies independently generated edges or sparse edges read from a
   Logic 2 `.sal` capture.
4. The official analyzer runs its unchanged `WorkerThread` implementation.
5. Rust receives both FrameV2 fields and the analyzer's legacy `Frame` bytes.

The baseline output is:

```text
start   [10..11]
address [30..200] address=0x50 read=false ack=true
data    [210..380] data=0x3c ack=true
stop    [395..396]
```

## Logic 2 golden comparison

The supplied captures were decoded by Logic 2 and exported as CSV. The runtime
opens the matching `.sal`, restores all saved analyzer settings, decodes the
complete capture, and compares every CSV row after converting time back to
sample indexes. Protocol fields are compared exactly in both directions: a
blank CSV value must also be absent from the runtime frame.

| Capture | Official rows | Compared fields | Result |
| --- | ---: | --- | --- |
| `demo-i2c.sal` | 65,843 | type, start, duration, ACK, address, read, data | exact match |
| `demo-spi.sal` | 96,849 | type, start, duration, MOSI, MISO | exact match |
| `simple-parallel.sal` | 64,630 | type, start, duration, data | exact match |

The Logic 2.4.46 demo batches add 18 analyzers and 1,771,857 golden rows.
All analyzers run to completion. Sixteen have exactly the same frame count as
Logic 2; MIDI produces one extra legacy frame (2,087 vs 2,086), and Atmel SWI
produces one fewer (321 vs 322), so those two are known failures rather than
passing baselines. FrameV2 protocols Async Serial, SPI, I2C, CAN, LIN, and
Simple Parallel were additionally checked row-by-row for type and sample-exact
start/duration. SPI alone covers 1,202,806 rows.

The new captures use private DigitalStore v4, which Logic 2.4.43 cannot read.
`scripts/export_sal_v4.py` launches official Logic 2.4.46 through its stable
Automation API and asks it to export public digital binaries; the Rust runtime
then consumes the generated sparse manifest. This preserves the rule that the
project does not guess or reimplement Saleae's private storage codec.

Run the full comparisons with:

```sh
cargo test --manifest-path runtime/rust/Cargo.toml \
  official_csv_golden_tests -- --ignored
```

## Automated checks

The seven normal Rust tests cover:

| Check | Expected result |
| --- | --- |
| I2C write | START, address `0x50`, write, ACK, data `0x3c`, ACK, STOP |
| Exact ranges | Frame start and end samples match the constructed waveform |
| Timing scale | Semantic output is unchanged at 2x timing and sample rate |
| Address NAK | Address remains `0x50` and `ack=false` |
| Repeated START/read | Second address has `read=true`; data is `0x5a`, NAK |
| Missing ACK | STOP in the ACK slot produces `missing ack/nak` |
| Legacy/FrameV2 | Raw bytes `0xa0, 0x3c` agree with typed fields |

Run them with:

```sh
cargo test --manifest-path runtime/rust/Cargo.toml
```

There is also an ignored differential test. It feeds the exact same raw
samples to sigrok's separately implemented Python I2C decoder. It verifies
address `0x50`, write direction, byte `0x3c`, and two ACKs:

```sh
cargo test --manifest-path runtime/rust/Cargo.toml -- --ignored
```

On 2026-07-31, all normal tests, the sigrok differential test, `.sal` reader
test, and both full CSV golden comparisons passed on macOS arm64. `cargo
clippy --all-targets -- -D warnings` and both Debug and Release CMake builds
also passed. The C++ warnings are deprecations and string-literal warnings in
the unchanged official analyzer sources.

## Important observed behavior

For a STOP inside the ACK slot, the official analyzer submits the STOP frame
before submitting the malformed data frame. The runtime preserves plugin
submission order; it does not sort frames because other protocols can contain
intentional overlaps.

START and STOP FrameV2 ranges are always one sample wide. When a waveform is
scaled, their start samples scale but their `end = start + 1` convention does
not become two samples wide. Data and address ranges scale normally.

## What is not proven yet

This does not yet establish compatibility with every SDK method. The batch
captures substantially broaden settings, channel cursor, results, packet, and
helper coverage, but MIDI and Atmel SWI still have one-frame boundary
differences. Legacy-only analyzers also need field-aware CSV normalization
before their values and timing can be called exact golden matches.

Each additional analyzer needs its own independent protocol vectors and Logic
golden output. Passing I2C and SPI is evidence that the selected C++/C/Rust
boundary works; it is not evidence that the SDK surface is complete.
