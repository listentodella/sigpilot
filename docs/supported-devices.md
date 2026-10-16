# Supported device models

> **Generated file — do not edit by hand.**
>
> Source of truth: `PXLOGIC_DEVICE_PROFILES` in
> `crates/sigpilot-core/src/pxview_profile.rs`.
>
> Regenerate with:
>
> ```sh
> PXLOGIC_UPDATE_SUPPORTED_DEVICES=1 cargo test -p sigpilot-core supported_devices
> ```
>
> A test fails when this file is out of date, so a model added to the table
> cannot be merged without appearing here.

## Models

| Vendor | Model | VID | PID | USB | Digital channels | Analog channels | Depth (samples) | Modes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PX_Tool | PX-Logic U3 channel 32 | `1A86` | `5237` | USB 3.0 Super | 32 | 0 | 4000000000 | 8 |
| PX_Tool | PX-Logic U2 channel 32 | `1A86` | `5237` | USB 2.0 High | 32 | 0 | 4000000000 | 9 |
| PX_Tool | PX-Logic U3 channel 32 | `16C0` | `05DC` | USB 3.0 Super | 32 | 0 | 4000000000 | 8 |
| PX_Tool | PX-Logic U2 channel 32 | `16C0` | `05DC` | USB 2.0 High | 32 | 0 | 4000000000 | 9 |
| PX_Tool | PX-Logic U3 channel 16 Pro | `16C0` | `05DC` | USB 3.0 Super | 16 | 0 | 4000000000 | 6 |
| PX_Tool | PX-Logic U2 channel 16 Pro | `16C0` | `05DC` | USB 2.0 High | 16 | 0 | 4000000000 | 7 |
| PX_Tool | PX-Logic U3 channel 16 Plus | `16C0` | `05DC` | USB 3.0 Super | 16 | 0 | 2000000000 | 4 |
| PX_Tool | PX-Logic U2 channel 16 Plus | `16C0` | `05DC` | USB 2.0 High | 16 | 0 | 2000000000 | 6 |
| PX_Tool | PX-Logic U3 channel 16 Base | `16C0` | `05DC` | USB 3.0 Super | 16 | 0 | 1000000000 | 3 |
| PX_Tool | PX-Logic U2 channel 16 Base | `16C0` | `05DC` | USB 2.0 High | 16 | 0 | 1000000000 | 6 |

Depth is the hardware sample memory, so the longest capture at a given
rate is `depth / sample_rate`. A device reporting `0` analog channels has
none; the demo device is the one that does.

## Capture modes per model

### PX_Tool — PX-Logic U3 channel 32

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC250x32` | Buffer | 32 | 250000000 Hz | 250000000 Hz | Use 32 Channels (Max 250MHz) (default) |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) |
| `BUFFER_LOGIC1000x8` | Buffer | 8 | 1000000000 Hz | 1000000000 Hz | Use 8 Channels (Max 1000MHz) |
| `STREAM_LOGIC50x32` | Stream | 32 | 50000000 Hz | 50000000 Hz | Use 32 Channels (Max50MHz) |
| `STREAM_LOGIC125x16` | Stream | 16 | 125000000 Hz | 125000000 Hz | Use 16 Channels (Max 125MHz) |
| `STREAM_LOGIC250x8` | Stream | 8 | 250000000 Hz | 250000000 Hz | Use 8 Channels (Max 250MHz) |
| `STREAM_LOGIC500x4` | Stream | 4 | 500000000 Hz | 500000000 Hz | Use 4 Channels (Max 500MHz) |
| `STREAM_LOGIC1000x2` | Stream | 2 | 1000000000 Hz | 1000000000 Hz | Use 2 Channels (Max 1000MHz) |

### PX_Tool — PX-Logic U2 channel 32

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC250x32` | Buffer | 32 | 250000000 Hz | 250000000 Hz | Use 32 Channels (Max 250MHz) |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) (default) |
| `BUFFER_LOGIC1000x8` | Buffer | 8 | 1000000000 Hz | 1000000000 Hz | Use 8 Channels (Max 1000MHz) |
| `STREAM_LOGIC200x1` | Stream | 1 | 200000000 Hz | 200000000 Hz | Use 1 Channels (Max200MHz) |
| `STREAM_LOGIC100x2` | Stream | 2 | 100000000 Hz | 100000000 Hz | Use 2 Channels (Max100MHz) |
| `STREAM_LOGIC50x4` | Stream | 4 | 50000000 Hz | 50000000 Hz | Use 4 Channels (Max50MHz) |
| `STREAM_LOGIC25x8` | Stream | 8 | 25000000 Hz | 25000000 Hz | Use 8 Channels (Max25MHz) |
| `STREAM_LOGIC10x16` | Stream | 16 | 10000000 Hz | 10000000 Hz | Use 16 Channels (Max10MHz) |
| `STREAM_LOGIC5x32` | Stream | 32 | 5000000 Hz | 5000000 Hz | Use 32 Channels (Max5MHz) |

### PX_Tool — PX-Logic U3 channel 32

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC250x32` | Buffer | 32 | 250000000 Hz | 250000000 Hz | Use 32 Channels (Max 250MHz) (default) |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) |
| `BUFFER_LOGIC1000x8` | Buffer | 8 | 1000000000 Hz | 1000000000 Hz | Use 8 Channels (Max 1000MHz) |
| `STREAM_LOGIC50x32` | Stream | 32 | 50000000 Hz | 50000000 Hz | Use 32 Channels (Max50MHz) |
| `STREAM_LOGIC125x16` | Stream | 16 | 125000000 Hz | 125000000 Hz | Use 16 Channels (Max 125MHz) |
| `STREAM_LOGIC250x8` | Stream | 8 | 250000000 Hz | 250000000 Hz | Use 8 Channels (Max 250MHz) |
| `STREAM_LOGIC500x4` | Stream | 4 | 500000000 Hz | 500000000 Hz | Use 4 Channels (Max 500MHz) |
| `STREAM_LOGIC1000x2` | Stream | 2 | 1000000000 Hz | 1000000000 Hz | Use 2 Channels (Max 1000MHz) |

### PX_Tool — PX-Logic U2 channel 32

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC250x32` | Buffer | 32 | 250000000 Hz | 250000000 Hz | Use 32 Channels (Max 250MHz) |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) (default) |
| `BUFFER_LOGIC1000x8` | Buffer | 8 | 1000000000 Hz | 1000000000 Hz | Use 8 Channels (Max 1000MHz) |
| `STREAM_LOGIC200x1` | Stream | 1 | 200000000 Hz | 200000000 Hz | Use 1 Channels (Max200MHz) |
| `STREAM_LOGIC100x2` | Stream | 2 | 100000000 Hz | 100000000 Hz | Use 2 Channels (Max100MHz) |
| `STREAM_LOGIC50x4` | Stream | 4 | 50000000 Hz | 50000000 Hz | Use 4 Channels (Max50MHz) |
| `STREAM_LOGIC25x8` | Stream | 8 | 25000000 Hz | 25000000 Hz | Use 8 Channels (Max25MHz) |
| `STREAM_LOGIC10x16` | Stream | 16 | 10000000 Hz | 10000000 Hz | Use 16 Channels (Max10MHz) |
| `STREAM_LOGIC5x32` | Stream | 32 | 5000000 Hz | 5000000 Hz | Use 32 Channels (Max5MHz) |

### PX_Tool — PX-Logic U3 channel 16 Pro

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) (default) |
| `BUFFER_LOGIC1000x8` | Buffer | 8 | 1000000000 Hz | 1000000000 Hz | Use 8 Channels (Max 1000MHz) |
| `STREAM_LOGIC125x16` | Stream | 16 | 125000000 Hz | 125000000 Hz | Use 16 Channels (Max 125MHz) |
| `STREAM_LOGIC250x8` | Stream | 8 | 250000000 Hz | 250000000 Hz | Use 8 Channels (Max 250MHz) |
| `STREAM_LOGIC500x4` | Stream | 4 | 500000000 Hz | 500000000 Hz | Use 4 Channels (Max 500MHz) |
| `STREAM_LOGIC1000x2` | Stream | 2 | 1000000000 Hz | 1000000000 Hz | Use 2 Channels (Max 1000MHz) |

### PX_Tool — PX-Logic U2 channel 16 Pro

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) (default) |
| `BUFFER_LOGIC1000x8` | Buffer | 8 | 1000000000 Hz | 1000000000 Hz | Use 8 Channels (Max 1000MHz) |
| `STREAM_LOGIC200x1` | Stream | 1 | 200000000 Hz | 200000000 Hz | Use 1 Channels (Max200MHz) |
| `STREAM_LOGIC100x2` | Stream | 2 | 100000000 Hz | 100000000 Hz | Use 2 Channels (Max100MHz) |
| `STREAM_LOGIC50x4` | Stream | 4 | 50000000 Hz | 50000000 Hz | Use 4 Channels (Max50MHz) |
| `STREAM_LOGIC25x8` | Stream | 8 | 25000000 Hz | 25000000 Hz | Use 8 Channels (Max25MHz) |
| `STREAM_LOGIC10x16` | Stream | 16 | 10000000 Hz | 10000000 Hz | Use 16 Channels (Max10MHz) |

### PX_Tool — PX-Logic U3 channel 16 Plus

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) (default) |
| `STREAM_LOGIC125x16` | Stream | 16 | 125000000 Hz | 125000000 Hz | Use 16 Channels (Max 125MHz) |
| `STREAM_LOGIC250x8` | Stream | 8 | 250000000 Hz | 250000000 Hz | Use 8 Channels (Max 250MHz) |
| `STREAM_LOGIC500x4` | Stream | 4 | 500000000 Hz | 500000000 Hz | Use 4 Channels (Max 500MHz) |

### PX_Tool — PX-Logic U2 channel 16 Plus

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC500x16` | Buffer | 16 | 500000000 Hz | 500000000 Hz | Use 16 Channels (Max 500MHz) (default) |
| `STREAM_LOGIC200x1` | Stream | 1 | 200000000 Hz | 200000000 Hz | Use 1 Channels (Max200MHz) |
| `STREAM_LOGIC100x2` | Stream | 2 | 100000000 Hz | 100000000 Hz | Use 2 Channels (Max100MHz) |
| `STREAM_LOGIC50x4` | Stream | 4 | 50000000 Hz | 50000000 Hz | Use 4 Channels (Max50MHz) |
| `STREAM_LOGIC25x8` | Stream | 8 | 25000000 Hz | 25000000 Hz | Use 8 Channels (Max25MHz) |
| `STREAM_LOGIC10x16` | Stream | 16 | 10000000 Hz | 10000000 Hz | Use 16 Channels (Max10MHz) |

### PX_Tool — PX-Logic U3 channel 16 Base

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC250x16` | Buffer | 16 | 250000000 Hz | 250000000 Hz | Use 16 Channels (Max 250MHz) (default) |
| `STREAM_LOGIC125x16` | Stream | 16 | 125000000 Hz | 125000000 Hz | Use 16 Channels (Max 125MHz) |
| `STREAM_LOGIC250x8` | Stream | 8 | 250000000 Hz | 250000000 Hz | Use 8 Channels (Max 250MHz) |

### PX_Tool — PX-Logic U2 channel 16 Base

| Mode | Kind | Channels | Default rate | Max rate | Notes |
| --- | --- | --- | --- | --- | --- |
| `BUFFER_LOGIC250x16` | Buffer | 16 | 250000000 Hz | 250000000 Hz | Use 16 Channels (Max 250MHz) (default) |
| `STREAM_LOGIC200x1` | Stream | 1 | 200000000 Hz | 200000000 Hz | Use 1 Channels (Max200MHz) |
| `STREAM_LOGIC100x2` | Stream | 2 | 100000000 Hz | 100000000 Hz | Use 2 Channels (Max100MHz) |
| `STREAM_LOGIC50x4` | Stream | 4 | 50000000 Hz | 50000000 Hz | Use 4 Channels (Max50MHz) |
| `STREAM_LOGIC25x8` | Stream | 8 | 25000000 Hz | 25000000 Hz | Use 8 Channels (Max25MHz) |
| `STREAM_LOGIC10x16` | Stream | 16 | 10000000 Hz | 10000000 Hz | Use 16 Channels (Max10MHz) |
