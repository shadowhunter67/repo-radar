# Cost and limits of the 0.7 subsystems

Numbers come from `scripts/probe-performance.mjs`, `probe-retrieval.mjs`, `probe-crypto.mjs` and `probe-dep-registry.mjs` (results in `calibration/results/`, 2026-10-13, one Windows machine, real network). Wall-clock time includes the network and varies between runs; request counts, bytes and caps are exact. Nothing here is a benchmark of the machine-independent kind.

## Ordinary repositories

Cost of the new defaults, measured as a difference on the same repository in one run (`performance-probe.md`):

| Repository | 0.7 defaults | `--no-dep-registry --no-domains` | Extra HTTP requests | Dependency registry | Domains | Trust graph |
| ---------- | ------------ | -------------------------------- | ------------------- | ------------------- | ------- | ----------- |
| sharkdp/fd | 14.7 s, 76 requests | 10.1 s, 51 | +25 | 25 of 126 packages, 2.9 MiB | 4 hosts | 392 nodes / 478 edges (was 238 / 246) |
| BurntSushi/ripgrep | 28.0 s, 116 | 23.4 s, 91 | +25 | 25 of 53, 2.4 MiB | 8 hosts | 461 / 594 (was 309 / 354) |
| expressjs/express | 14.8 s, 56 | 9.3 s, 31 | +25 | 25 of 44, 1.9 MiB | 7 hosts | 255 / 408 (was 74 / 79) |

The dependency registry adds one request per queried package (25 by default, four in parallel; crates.io owners are not requested for dependencies) and about 4-6 s; domain extraction is local and takes tens of milliseconds. The first probe run, before owners were skipped, cost 50 requests and ~15 s on the Rust repositories.

## Large repositories (retrieval v3, `retrieval-v3.md`)

Pinned kubernetes / flink / linux / nixpkgs: 214-261 requests and 80-144 s with v3, against 143-168 requests and 37-86 s for the 0.6 retrieval; linux now ends on the 120 s time budget. Details and what was gained for the cost: [retrieval.md](retrieval.md).

## Cryptographic verification (`crypto-probe.md`)

With `--verify-crypto` (and asset checks): goreleaser 18 s (Sigstore TUF root, one blob bundle, four attestations), cli/cli 12.6 s (including five large bundles downloaded and decompressed), restic 10 s with OpenPGP, dnscrypt-proxy 18.7 s with minisign (the time is the 24 MiB of archives it downloads). A single verification has a 20 s timeout; the Sigstore library loads lazily, only when a bundle is met.

## Dependency registry (`dep-registry-probe.md`)

16 real packages: 19 requests (three of them deps.dev), 11.4 MB, 2.5 s. npm packuments are the large ones (express 290 versions, react ~3,000: the 8 MiB response cap exists for them); only the newest 20 versions are kept per package.

## Synthetic, at the caps

| What | Input | Time |
| ---- | ----- | ---- |
| domain extraction | 40 files x 6,000 lines (9.7 MiB of text) | ~0.1 s; the per-file, per-run and distinct-host caps all trigger and are reported |
| event correlation | 200 events x 8 patterns | ~3 ms (the search budget is 200,000 steps per pattern) |
| dependency priority ranking | 5,000 dependencies | ~9 ms |
| trust graph | 5,000 domains offered | ~2 ms; 365 nodes, 370 edges (domain limit 300), 0.1 MiB serialized, ~2 MiB of heap |

## Caps (all reported when hit)

Dependency registry: 25 packages, 60 requests, 45 s, 20 versions per package, 48 MiB, 4 parallel. Retrieval pools: generic 90 requests, declared 60 (400 paths, depth 8), seek 24 (24 subtrees, 600,000 entries scanned), shared 32 MiB / 200,000 nodes / 120 s. Domains: 80 references per file, 3,000 observations, 600 tracked and 300 reported hosts. Signatures: 6 per release, 8 MiB per artifact, 24 MiB total, bundle 256 KiB / 8 certificates / 4 log entries / 64 subjects. Large bundles: five per release, 512 KiB compressed, 1 MiB decompressed. Trust graph: 3,000 nodes, 9,000 edges, 100 dependency packages, 300 domains. Timeline: 200 events. The pathological cases (huge URL literals, thousands of declared modules, a 30,000-line CMake file, a 40,000-version packument, a decompression bomb) are in the test suite with time bounds.
