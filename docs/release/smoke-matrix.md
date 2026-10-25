# Preview smoke matrix

Reviewer operational smoke results, 2026-10-25: one default `analyze` run per
repository, JSON output, Windows 11, Node 24, with `GITHUB_TOKEN`. These were
not calibration runs and no rule was tuned. All 21 runs exited 0 with valid
schema 0.16 JSON. This is one machine and one run, not a benchmark.

| Repository | Seconds | Confidence |
| --- | ---: | ---: |
| lodash | 14 | 0.80–0.91 (small-repository range) |
| express | 10 | 0.80–0.91 (small-repository range) |
| chalk | 8 | 0.80–0.91 (small-repository range) |
| p-limit | 8 | 0.80–0.91 (small-repository range) |
| requests | 11 | 0.80–0.91 (small-repository range) |
| click | 14 | 0.80–0.91 (small-repository range) |
| pip | 10 | 0.80–0.91 (small-repository range) |
| typer | 15 | 0.80–0.91 (small-repository range) |
| ripgrep | 25 | 0.80–0.91 (small-repository range) |
| serde | 17 | 0.80–0.91 (small-repository range) |
| tokio | 19 | 0.80–0.91 (small-repository range) |
| cobra | 8 | 0.80–0.91 (small-repository range) |
| gin | 10 | 0.80–0.91 (small-repository range) |
| kubernetes | 83 | 0.70 |
| guava | 8 | 0.80–0.91 (small-repository range) |
| spring-petclinic | 10 | 0.80–0.91 (small-repository range) |
| commons-lang | 8 | 0.80–0.91 (small-repository range) |
| bazel-skylib | 9 | 0.80–0.91 (small-repository range) |
| buck2 | 21 | 0.80–0.91 (small-repository range) |
| node | 67 | 0.80–0.91 (small-repository range) |
| linux | 136 | 0.60 |

Large repositories are sampled or partial by design; the lower confidence for
kubernetes and linux is retained as observed.
