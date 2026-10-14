# Native HLA Python host

Original stdlib-only implementation of a limited public `saleae.analyzers` /
`saleae.data` compatibility interface. No proprietary source was copied.
Requires CPython 3.9+ (benchmark uses POSIX `wait4`). Launch:

```sh
python3 -I native/hla-analyzer-sidecar/main.py
python3 -I -B native/hla-analyzer-sidecar/tests/test_host.py -v
python3 -I -B native/hla-analyzer-sidecar/benchmark.py
```

## Protocol

One UTF-8 JSON object per stdin line; one compact JSON object per stdout line.
Initial request requires `op` (`inspect` or `start`), `manifest_path`,
`entry_point`, `settings` object and positive u64 `sample_rate_hz`.
Optional `time_origin` is `{ "numerator": i64, "denominator": positive_u64 }`,
defaulting to 0/1 seconds. The manifest is canonicalized and its `extensions`
object must contain a feature with `type: "HighLevelAnalyzer"` and matching
`entryPoint: "module.Class"` before any extension import occurs.
The module must resolve within the canonical manifest directory.

`inspect` returns `settings` descriptors and class-level `result_types` without
constructing an instance. `start` constructs one instance and returns
`{"ready":true}`. Settings are assigned before `__init__`; inherited and
shadowed descriptors follow Python MRO. Unknown settings, incorrect scalar
kinds, invalid choices, nonfinite numbers and values outside inclusive bounds
are rejected. Defaults: string `""`, choices first entry, number zero clamped to
declared bounds. Explicit defaults must be valid. These are documented host rules.

`batch` takes `frames`, each with string `type`, u64 `start_sample` and
`end_sample` (end >= start), and a `data` object of recursively tagged values.
Tags are Text, Signed, Unsigned, Float, Boolean, Bytes, Null, List and Map as
specified by the parent IPC contract. Plugin values are Python strings, int
subclasses, floats, bools, bytes, None, lists and dictionaries. Echoed integers
preserve Signed/Unsigned tags; arithmetic produces ordinary Python ints,
encoded as Signed when within i64, otherwise Unsigned when within u64.
Out-of-range integers and unsupported Python objects are rejected.

Decode returns None, a single AnalyzerFrame, or a list of AnalyzerFrames.
Ordering and state are retained across batches. Each output has `type`, exact
sample coordinates, tagged `data`, and `text`. `finish` returns `{"done":true}`
and exits zero; it does not invoke a plugin flush callback. Exceptions produce
`{"error":"ExceptionType: message"}` and exit 1. EOF before finish is an error,
including after inspect; clients must send finish. A batch failure is fatal
and never returns partial output (prior plugin state changes are not rolled
back). Extra request fields are ignored.

## Time and display support

GraphTime and GraphTimeDelta store exact Fractions. The public constructor units
are `GraphTime(datetime, millisecond=0, *, microsecond=0, nanosecond=0, picosecond=0)`
and `GraphTimeDelta(second=0, millisecond=0, *, microsecond=0, nanosecond=0, picosecond=0)`.
GraphTime accepts timezone-aware datetimes (naive inputs use UTC), emits ISO UTC
strings at picosecond precision and supports `as_datetime()`. Numeric/Fraction
GraphTime construction and plural keyword units are host conveniences.
Time +/- delta, time - time, delta arithmetic, ordering and float conversion are
supported. Delta strings are decimal seconds; repeating rationals are rounded
to at least 40 decimal digits. Internal arithmetic is exact. Output GraphTimes
must lie exactly on `origin + sample / rate` and within u64; no rounding occurs.

Result formats support only `{{type}}` and `{{data.field}}` with dotted
identifier paths through dictionaries (whitespace around tokens allowed).
Helpers, blocks, comments, triple braces and malformed expressions are rejected
on inspect/start. Missing referenced fields are errors. Null renders empty,
bools lowercase, other values via Python str. No HTML escaping is performed.
Only absent formats fall back to the frame type; an empty format stays empty.

## Trust boundary and limitations

**This is not a sandbox. Run only trusted extensions.** The process has the
caller's filesystem, networking and OS privileges. Python isolation excludes
PYTHONPATH and user packages; the host explicitly retains only stdlib paths,
its own path, and the canonical extension directory. Ordinary local auxiliary
imports work, but third-party dependencies and complete Saleae API coverage are
not supported. `-I` still runs system Python site initialization before this
script; the host then removes site-package paths. Host namespace takes priority
above extension modules. Builtin/frozen/previously loaded module names cannot
be used as extension entry modules.

Ordinary plugin prints, including import-time output, are redirected to stderr.
Parents should continuously drain stderr. Direct writes to fd 1, `sys.__stdout__`,
subprocess stdout, or deliberate stream replacement are outside this trusted
plugin convention. There are no execution timeouts, frame-count limits or
resource quotas in this host. Memory is bounded by one requested batch and its
outputs, not by all prior batches; plugins may independently retain state.
Inspect cannot discover instance-only dynamically created result types.

## Performance

`benchmark.py` streams 10k/100k/1m frames in 1,000-frame batches, receiving and
checking each response immediately rather than storing the entire trace. It
reports wall processing time, summed batch pipe round-trip time (includes
sidecar compute and transport, not a pure IPC measurement), CPU usage, per-child
peak RSS, cumulative driver peak RSS, and exact IPC byte counts. Stderr is
discarded for the echo fixture. Results and platform details: PERFORMANCE.md.
