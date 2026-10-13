# Tree retrieval for very large repositories

The git tree is read with one recursive request. When GitHub truncates it, or the response exceeds the size limit (kubernetes, linux, nixpkgs, flink), a bounded multi-pass walk runs instead of raising limits forever. The result is never presented as a complete tree.

## Passes

| Pass | Reads |
| ---- | ----- |
| `root` | the root listing |
| `ci_build` | `.github`, CI, build, installer and tooling directories (small, high value) |
| `hinted` | directories that workspace/build manifests NAME: `package.json` workspaces, `pnpm-workspace.yaml`, `Cargo.toml` `[workspace] members`, `go.work`, Gradle `include`, Maven `<module>`, CMake `add_subdirectory`, `Makefile.am` `SUBDIRS`, `meson.build` `subdir`, Kbuild `*-y += dir/` lists, and every directory on the way to a named one |
| `declared_deep` | the same, when the declared path lies deeper than the generic depth budget (0.7) |
| `source_roots` | `src`, `packages`, `crates`, `cmd`, `lib`, ... |
| `breadth` | everything else, shallow directories first |
| `manifest_seek` | bounded recursive listings of selected subtrees that keep ONLY manifest and build-definition files (0.7) |

Priorities are recomputed after every listing because each new listing can teach new hints. A directory with more sub-directories than `wideFanout` (120) is "wide" (`drivers/`, `pkgs/by-name`): its children rank low unless a hint names them. Documentation, tests, examples, generated and vendored code rank low but are NOT forbidden; only dependency, VCS and cache directories (`node_modules`, `.git`, `.venv`, ...) are never read and are counted in `skipped_by_rule`. Hint files are read as text under a request budget; their contents are patterns, never evaluated, and every named path passes the tree path safety check.

## Budget (explicit, finite, reported)

`maxRequests 90`, `maxNodes 200 000`, `maxBytes 32 MiB`, `maxMillis 120 000`, `maxDepth 4`, `maxHintReads 16` - the GENERIC pool. Since 0.7 two more pools exist beside it (below); `retrieval.requests` is their sum. The first limit reached ends the walk and is recorded in `retrieval.stopped_by`; `coverage_map` states per evidence class whether it is `complete`, `targeted`, `sampled`, `partial` or `none`. Within a run, file contents are reused by git blob SHA and manifest parses by blob SHA + parser id + parser version.

## Retrieval v3 (0.7): declared paths and manifest seeking

**Declared paths.** A path that the project's own build files name (`go.work` `use`, workspaces, Cargo members, Maven modules, Gradle includes, CMake `add_subdirectory`, Meson `subdir`, `Makefile.am`, Kbuild `obj-y`, `rush.json`, `.sln`, uv workspaces) is followed even when it lies deeper than the generic `maxDepth`, paid from a SEPARATE pool: `declared = { maxPaths 400, maxDepth 8, maxRequests 60, maxHintReads 24 }`. The generic traversal is not widened. Inside a declared directory the walk also reads hint files (nested workspaces). Declared paths are attacker-controlled text: each is normalized and must pass the tree path check; traversal (`..`), absolute paths, drive letters, backslashes and template variables (`${HOME}`) are never followed and are counted (`declared_paths.rejected_unsafe`); paths beyond the depth cap, or beyond 400 per run, are counted too (`rejected_depth`, `rejected_over_limit`); a directory is listed at most once, so recursive or self references cannot loop.

**Manifest seeking.** For directories the walk could not afford to list level by level, ONE recursive listing returns every path in the subtree. Only manifest and build-definition files are kept (`package.json`, `pyproject.toml`, `setup.py`, `requirements.txt`, `Cargo.toml`, `go.mod`, `pom.xml`, `settings.gradle(.kts)`, `build.gradle(.kts)`, `libs.versions.toml`, `CMakeLists.txt`, `meson.build`); the rest of the subtree is not stored. Budget: `seek = { enabled, maxRequests 24, maxSubtrees 24, maxEntriesScanned 600 000 }`; documentation, tests, examples, vendored and generated directories are not worth a request. A subtree GitHub truncated is *partial* (its manifests are kept, the repository is never complete). The shared limits (time, bytes, nodes) end the seeking too; `retrieval.manifest_seek.stopped_by` says which.

**Manifests in the tree vs read.** A targeted tree accepts package manifests up to depth 8 (a complete tree keeps depth 2 so buried examples do not become packages) and reads up to 24 of them (`retrieval.manifest_paths = { in_tree, read, cap }`). Before this change the walk listed kubernetes' `staging/src/k8s.io/*` and then ignored their `go.mod` files because of the depth-2 acceptance rule.

`--v2` in `scripts/probe-retrieval.mjs` reproduces the 0.6 retrieval (`declared: { maxRequests: 0, maxHintReads: 0 }, seek: { enabled: false }`); budgets written before 0.7 (no `declared` / `seek` keys) get these defaults.

## Probes (pinned revisions, 2026-10-13; `calibration/results/retrieval-v3*.md`)

Same revisions, three runs: **0.6** (the 0.6 code), **depth only** (0.6 retrieval, manifests accepted to depth 8) and **v3** (everything). Nothing is tuned on these repositories.

| Repository | Run | Manifests in tree / read | Dependencies | Build projects | Dirs listed / unread | Requests | Time | Stopped by |
| ---------- | --- | ------------------------ | ------------ | -------------- | -------------------- | -------- | ---- | ---------- |
| kubernetes | 0.6 | 1 (depth-2 rule) / 1 | 250 | 0 | 88 / 311 | 151 | 48 s | request budget |
| kubernetes | depth only | 38 / 24 | 1,212 | 0 | 88 / 311 | 173 | 60 s | request budget |
| kubernetes | v3 | 38 / 24 | 1,212 | 0 | 149 / 501 | 234 | 80 s | request budget |
| flink | 0.6 | (10 read) | 64 | 11 | 74 / 170 | 163 | 37 s | request budget |
| flink | depth only | 73 / 24 | 197 | 21 | 74 / 170 | 177 | 67 s | request budget |
| flink | v3 | **121** / 24 | 197 | 21 | 148 / 165 | 261 | 85 s | request budget |
| linux | 0.6 | (0) | 0 | 0 | 74 / 619 | 143 | 86 s | request budget |
| linux | v3 | 2 / 2 | 5 | 0 | 129 / 740 | 224 | 144 s | **time budget** |
| nixpkgs | 0.6 | (1) | 7 | 0 | 90 / 1,297 | 168 | 58 s | request budget |
| nixpkgs | depth only | 3 / 3 | 14 | 0 | 90 / 1,297 | 184 | 62 s | request budget |
| nixpkgs | v3 | 4 / 4 | 19 | 0 | 114 / 1,273 | 215 | 101 s | request budget |

What this says, honestly:

- Most of the kubernetes and flink gain is the manifest-depth fix, not the new pools: kubernetes goes from 1 manifest to 24 read (38 in the tree) and from 250 to 1,212 dependencies with the 0.6 retrieval. flink's build projects double (11 -> 21).
- The new pools add reach where manifests are scattered: flink goes from 73 to 121 manifests in the tree (48 extra found by seeking); nixpkgs from 3 to 4. For kubernetes (the 14 remaining manifests are beyond the read cap of 24) and linux (no package manifests exist) they add cost and nothing else.
- Cost: +30-60% requests and +30-70% time. linux now ends on the 120 s time budget in the seeking pass. The workflow count (kubernetes uses Prow, nixpkgs 17, flink 10), `source` coverage (known source files grow, the scanned sample does not: flink 76% -> 32%, kubernetes 14% -> 9%) and the primary identity (`cli`, `library`, `unknown`, `unknown`) did not change. Identity was not tuned and `unknown` for linux/nixpkgs stays `unknown`.
- Nothing is complete: every row is `complete=false`.

## Remaining blind spots

- The manifest read cap (24) hides some of what the walk finds (kubernetes 38, flink 121).
- Source coverage on the largest trees stays low (sampled; linux 0%): capability absence there is unobserved, not absent.
- Repositories with no declared structure (nixpkgs) get breadth-first coverage only; Bazel, Nix and Buck build files are not read.
- The seeking pass picks subtrees by the same name-based priority as the walk; a manifest in a low-priority directory name (`docs/`, `tests/`, `vendor/`) is not sought.
