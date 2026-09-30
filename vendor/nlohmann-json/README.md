# nlohmann/json (vendored)

The single-header JSON library the native sidecars use for their stdin/stdout IPC
protocol with the Rust host. Rust talks to them through `serde`; this is the C++
side of the same protocol.

## What is here

```
single_include/nlohmann/json.hpp   the only file the sidecars include
LICENSE.MIT                        upstream licence
```

## Provenance

| | |
| --- | --- |
| Upstream | https://github.com/nlohmann/json |
| Version | 3.11.3 |
| Commit | `9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03` |
| Licence | MIT (see `LICENSE.MIT`) |

The header is byte-for-byte the file at that commit. Verify with:

```sh
git -C <a clone of nlohmann/json> rev-parse HEAD   # 9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03
cmp <clone>/single_include/nlohmann/json.hpp vendor/nlohmann-json/single_include/nlohmann/json.hpp
```

## Why it is vendored rather than fetched

Both sidecar build scripts used to clone the upstream repository into
`target/native-cache/json` and check out the pinned commit. That put a
network-fetched dependency inside `target/`, which is meant to be disposable:

* `cargo clean` deleted the clone, so the next build re-fetched it — 304 MB of
  clone (287 MB of it git history) to obtain this one 900 KB header, and a build
  that fails without network access.
* The clone bypassed Cargo's own vendoring and lockfile, so nothing recorded or
  verified the dependency.

Vendoring the header costs 900 KB in the repository and removes the fetch
entirely. It is also the same file either way — the commit is unchanged, so the
code the sidecars compile against is byte-identical to what they compiled against
before.

## Updating

Replace `single_include/nlohmann/json.hpp` and `LICENSE.MIT`, then update the
commit in the table above and in the `NLOHMANN_JSON_COMMIT` note in
`native/saleae-analyzer-sidecar/build.sh`. Check `single_include` — that is the
generated amalgamation, not the split headers under `include/`.

## Overriding

Set `SIGPILOT_NLOHMANN_JSON_INCLUDE` to point at a different `single_include`
directory (for example a full clone) if you need to build against another
version:

```sh
set -x SIGPILOT_NLOHMANN_JSON_INCLUDE /path/to/json/single_include
```
