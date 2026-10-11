# Tree retrieval for very large repositories

The git tree is read with one recursive request. When GitHub truncates it, or the response exceeds the size limit (kubernetes, linux, nixpkgs, flink), a bounded multi-pass walk runs instead of raising limits forever. The result is never presented as a complete tree.

## Passes

| Pass | Reads |
| ---- | ----- |
| `root` | the root listing |
| `ci_build` | `.github`, CI, build, installer and tooling directories (small, high value) |
| `hinted` | directories that workspace/build manifests near the root NAME: `package.json` workspaces, `pnpm-workspace.yaml`, `Cargo.toml` `[workspace] members`, `go.work`, Gradle `include`, Maven `<module>`, CMake `add_subdirectory`, `Makefile.am` `SUBDIRS`, `meson.build` `subdir`, Kbuild `*-y += dir/` lists, and every directory on the way to a named one |
| `source_roots` | `src`, `packages`, `crates`, `cmd`, `lib`, ... |
| `breadth` | everything else, shallow directories first |

Priorities are recomputed after every listing because each new listing can teach new hints. A directory with more sub-directories than `wideFanout` (120) is "wide" (`drivers/`, `pkgs/by-name`): its children rank low unless a hint names them. Documentation, tests, examples, generated and vendored code rank low but are NOT forbidden; only dependency, VCS and cache directories (`node_modules`, `.git`, `.venv`, ...) are never read and are counted in `skipped_by_rule`. Hint files are read as text under a request budget; their contents are patterns, never evaluated, and every named path passes the tree path safety check.

## Budget (explicit, finite, reported)

`maxRequests 90`, `maxNodes 200 000`, `maxBytes 32 MiB`, `maxMillis 120 000`, `maxDepth 4`, `maxHintReads 16`. The first limit reached ends the walk and is recorded in `retrieval.stopped_by`; `coverage_map` states per evidence class whether it is `complete`, `targeted`, `sampled`, `partial` or `none`. Within a run, file contents are reused by git blob SHA and manifest parses by blob SHA + parser id + parser version.

## Probes (default-branch heads on 2026-10-11; `calibration/results/retrieval-probe-v2b.md`)

| Repository | Tree | Listed / unread | Hints | Manifests / workflows / build projects | Requests |
| ---------- | ---- | --------------- | ----- | -------------------------------------- | -------- |
| apache/flink | targeted, partial | 74 / 170 (request budget) | 16 files, 85 dirs | 10 / 10 / 11 | 163 |
| kubernetes/kubernetes | targeted, partial | 88 / 311 | `go.work`: 34 dirs | 1 / 0 / 0 | 151 |
| torvalds/linux | targeted, partial | 76 / 651 | 14 files (Kbuild) : 71 dirs | 0 / 0 / 0 | 143 |
| NixOS/nixpkgs | targeted, partial | 90 / 1298 | none found | 1 / 17 / 0 | 161 |
| astral-sh/ruff, django/django, mongodb/node-mongodb-native | recursive, complete | - | - | 10 / 23 / 1, 2 / 16 / 1, 1 / 12 / 0 | 106, 71, 74 |

Success here means high-value structure found within a bounded budget, not full-source parsing.

## Remaining blind spots

- Manifests deeper than three path segments are not picked even when a hint named their directory (kubernetes `staging/src/k8s.io/*/go.mod`); the walk lists those directories but manifest selection is depth-limited.
- Source coverage on the largest trees stays low (sampled; linux 0%): capability absence there is unobserved, not absent.
- Repositories with no declared structure (nixpkgs) get breadth-first coverage only.
