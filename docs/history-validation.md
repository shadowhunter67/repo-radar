# Dependency-history validation

The dependency-history engine was validated on 2026-10-24 using a large budget and
an independent, local-git reference model. `scripts/build-history-ground-truth.mjs`
uses parent-diff presence and the TREESAME merge rule with independent JSON,
smol-toml, and go.mod-line parsers. `scripts/validate-history.mjs` compares that
ground truth with the engine under test. This is a technical validation, not human
review or an accuracy claim.

The corpus contains 80 dependencies from ten repositories: expressjs/express,
chalk/chalk, sindresorhus/got, psf/requests, pallets/flask, BurntSushi/ripgrep,
serde-rs/serde (workspace member), tokio-rs/axum (monorepo member), spf13/cobra,
and gin-gonic/gin. Each repository has five hash-sampled dependencies plus cases
with non-simple history.

## Final measured results

| Dimension | exact | correct within defined window | correct abstention | partial | unknown | incorrect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Introduction commit | 65 | 11 | 1 | — | 3 | 0 |
| Event sequence | 65 | 9 | — | 5 | 1 | 0 |
| Manifest path | 80 | 0 | — | 0 | 0 | 0 |

Final run: 2026-10-24 (eight repositories) and 2026-10-25 (serde and express, rerun after the window-start change and a correction of the
validator's window rule). The first live run of the same engine scored introduction commit exact 51 / incorrect 26 / unknown 3 and event sequence
exact 38 / incorrect 42; the defects listed below account for the difference. The 3 `unknown` introductions are abstentions (express `ejs`, serde
`serde_macros` and `rustc-serialize`, where the true introduction predates the scanned window); in the last two the engine abstained but did not set
`present_at_window_start`, a reporting gap that remains. The 5 `partial` event sequences omit `introduced_again_other_line` duplicates from side
branches. The validator's window rule was itself wrong once (it excluded the transition at the oldest scanned commit) and a substring match once
attributed `mime-types` to `mime`; both were validator defects, not engine defects, and are fixed.

Classification vocabulary is `exact`, `correct_within_defined_window`, `partial`,
`unknown`, and `incorrect`. The final numbers are measured on this corpus only and
do not generalise.

| Repository | requests | commits scanned | seconds |
| --- | ---: | ---: | ---: |
| requests | 35 | 17 | 16 |
| flask | 133 | 64 | 56 |
| cobra | 58 | 31 | 22 |
| chalk | 212 | 128 | 85 |
| gin | 275 | 154 | 110 |
| ripgrep | 445 | 242 | 188 |
| axum | 398 | 210 | 160 |
| serde | 790 | 410 | 312 |
| got | 873 | 515 | 335 |
| express | 1862 | 1289 | 718 |

The validation found and fixed, in order: monotonic bisection over non-linear
history; the difference between GitHub's path-filtered list and first-parent
semantics; merge all-parent handling; HTTP 403/5xx being read as an empty complete
history; a parent-path 404 being read as unknown; valid manifests without dependency
sections being read as unknown; substring matching in the validator (`mime` versus
`mime-types`, a validator defect); and window-start representation.

Limitations remain. The corpus checks direct manifest dependencies and one manifest
path per repository; it does not validate lockfile/transitive history. It contains
only the rename cases present in the corpus (one serde case). Ground truth is
git-derived and not human-reviewed. GitHub path filtering can omit old commits
(express returned 1289 versus git's 1375), so old introductions remain partial.
The API quota requires two batches; a rate-limited observation is invalid rather
than a negative result.
