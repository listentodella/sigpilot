# HLA sidecar benchmark

Measured on macOS 26.5.1 arm64 with the packaged shared CPython 3.14.6:

```sh
resources/native/python-runtime/bin/python3 -I -B native/hla-analyzer-sidecar/benchmark.py
```

Original MIT echo fixture, 1 MHz, one Unsigned field per frame, 1,000 frames per
batch. Each row uses a fresh sidecar process; no complete trace is retained.
This is one local run, not a statistically controlled comparison. Processing is
end-to-end generation, JSON encoding, pipe exchange, decode and result checks.

| Frames | Startup s | Processing s | Frames/s | Batch round-trip s | Child CPU s | Child peak RSS bytes | Driver cumulative peak RSS bytes | Sent bytes | Received bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 0.032203 | 0.173765 | 57,549 | 0.158878 | 0.191876 | 23,166,976 | 31,555,584 | 887,118 | 1,026,833 |
| 100,000 | 0.030251 | 1.718400 | 58,194 | 1.581476 | 1.612395 | 23,560,192 | 31,621,120 | 9,169,459 | 10,568,004 |
| 1,000,000 | 0.030272 | 17.347322 | 57,646 | 15.935635 | 15.952088 | 23,429,120 | 31,637,504 | 94,692,860 | 108,679,705 |

Round-trip includes sidecar computation, transport and flushing but excludes
parent JSON encoding/decoding; it is not pure IPC overhead. RSS is the child
peak and the driver's cumulative high-water mark. These numbers do not predict
arbitrary plugins, payload expansion, a single huge batch, or the full SigPilot
application cache.
