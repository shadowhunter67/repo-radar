# Performance probe: performance-probe

Run 2026-10-13T15:43:56.134Z on win32, Node v24.16.0. Wall-clock times include the network and vary; request counts are exact.

## Real repositories: cost of the 0.7 additions

| repository | configuration | time | HTTP requests | dep. registry (queried/eligible, requests) | domains | graph nodes/edges |
| --- | --- | --- | --- | --- | --- | --- |
| sharkdp/fd | 0.7 defaults | 22800 ms | 101 | 25/126, 50 req, 3.0 MiB | 4 hosts | 420/520 |
| sharkdp/fd | --no-dep-registry --no-domains | 8051 ms | 51 | disabled | disabled | 238/246 |
| sharkdp/fd | --no-registry --no-domains | 5950 ms | 49 | disabled | disabled | 231/239 |
| BurntSushi/ripgrep | 0.7 defaults | 28043 ms | 141 | 25/53, 50 req, 2.4 MiB | 8 hosts | 483/639 |
| BurntSushi/ripgrep | --no-dep-registry --no-domains | 14249 ms | 91 | disabled | disabled | 309/354 |
| BurntSushi/ripgrep | --no-registry --no-domains | 13476 ms | 83 | disabled | disabled | 296/335 |
| expressjs/express | 0.7 defaults | 9812 ms | 56 | 25/44, 25 req, 1.9 MiB | 7 hosts | 255/408 |
| expressjs/express | --no-dep-registry --no-domains | 7652 ms | 31 | disabled | disabled | 74/79 |
| expressjs/express | --no-registry --no-domains | 6008 ms | 30 | disabled | disabled | 65/70 |

## Synthetic: the documented caps

- domain extraction, 40 files x 6,000 lines (9.7 MiB of text): 97 ms; 600 hosts kept (cap 300 reported), limits hit: per-file reference limit reached; distinct host limit reached; observation limit reached
- correlation, 200 events x 8 patterns: 3 ms; 4 correlations (the search budget is 200,000 steps per pattern)
- dependency priority ranking, 5,000 dependencies: 6 ms; 5000 candidates
- trust graph, 5,000 domains offered (limit 300): 2 ms; 365 nodes, 370 edges, truncated=false, 0 edges dropped for lack of evidence, 0.1 MiB serialized, heap +2.0 MiB
