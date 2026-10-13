# Performance probe: performance-probe

Run 2026-10-13T15:58:56.016Z on win32, Node v24.16.0. Wall-clock times include the network and vary; request counts are exact.

## Real repositories: cost of the 0.7 additions

| repository | configuration | time | HTTP requests | dep. registry (queried/eligible, requests) | domains | graph nodes/edges |
| --- | --- | --- | --- | --- | --- | --- |
| sharkdp/fd | 0.7 defaults | 14698 ms | 76 | 25/126, 25 req, 2.9 MiB | 4 hosts | 392/478 |
| sharkdp/fd | --no-dep-registry --no-domains | 10148 ms | 51 | disabled | disabled | 238/246 |
| sharkdp/fd | --no-registry --no-domains | 5633 ms | 49 | disabled | disabled | 231/239 |
| BurntSushi/ripgrep | 0.7 defaults | 27967 ms | 116 | 25/53, 25 req, 2.4 MiB | 8 hosts | 461/594 |
| BurntSushi/ripgrep | --no-dep-registry --no-domains | 23438 ms | 91 | disabled | disabled | 309/354 |
| BurntSushi/ripgrep | --no-registry --no-domains | 16026 ms | 83 | disabled | disabled | 296/335 |
| expressjs/express | 0.7 defaults | 14778 ms | 56 | 25/44, 25 req, 1.9 MiB | 7 hosts | 255/408 |
| expressjs/express | --no-dep-registry --no-domains | 9316 ms | 31 | disabled | disabled | 74/79 |
| expressjs/express | --no-registry --no-domains | 6594 ms | 30 | disabled | disabled | 65/70 |

## Synthetic: the documented caps

- domain extraction, 40 files x 6,000 lines (9.7 MiB of text): 113 ms; 600 hosts kept (cap 300 reported), limits hit: per-file reference limit reached; distinct host limit reached; observation limit reached
- correlation, 200 events x 8 patterns: 3 ms; 4 correlations (the search budget is 200,000 steps per pattern)
- dependency priority ranking, 5,000 dependencies: 9 ms; 5000 candidates
- trust graph, 5,000 domains offered (limit 300): 2 ms; 365 nodes, 370 edges, truncated=false, 0 edges dropped for lack of evidence, 0.1 MiB serialized, heap +2.0 MiB
