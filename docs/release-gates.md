# Public release gates

repo-radar stays **private** until every gate below is met. Gates that can be checked mechanically are checked by
`node scripts/check-release-gates.mjs` (offline) and `node scripts/check-release-gates.mjs --online` (also asks GitHub
about CI and real-repository runs). A gate that needs a person is marked `manual` and must be confirmed in the release
issue; the script prints it as `MANUAL`, never as passed.

| #   | Gate                                                       | Check                                                                                          |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | CI is green on a GitHub-hosted runner                      | `--online`: latest `ci` run on the default branch concluded `success`                          |
| 2   | The Action works on at least 3 real repositories           | CI `action-matrix` lists >= 3 real repositories (offline); `--online` needs it green           |
| 3   | The `dist/action` release path is verified                 | `release-action.yml` exists, is dispatch-only with a dry-run default; packaging test exists    |
| 4   | Calibration corpus has at least 30 pinned repositories     | corpus loads cleanly, >= 30 labels, every commit is a 40-hex SHA                               |
| 5   | Holdout evaluated once for the current methodology         | a `final-*` result for the current methodology version exists (`holdout_evaluated: true`)      |
| 6   | Identity quality audited                                   | a calibration result includes artifact/domain accuracy and the abstention counts               |
| 7   | Capability false positives audited                         | the result lists per-capability precision with its disagreements                               |
| 8   | The secret scanner provably does not leak values           | test that no report field contains the secret literal exists and passes (`npm test`)           |
| 9   | Score and confidence disclaimers are present               | the text report and README carry the "heuristic, not a verdict" disclaimer                     |
| 10  | Schema compatibility tests are green                       | `schemas/` is in sync with the zod schemas (`docs-sync` / schema tests exist)                  |
| 11  | SECURITY.md and the threat model are current              | files exist and mention the analyzer's current supported version; manual review confirms scope |
| 12  | Third-party Actions are pinned to full SHAs                | every `uses:` in `.github/workflows` and `action.yml` is a 40-hex SHA or a local path          |
| 13  | Commit identity is the project identity                    | no commit identity other than `repo-radar dev <dev@repo-radar.invalid>`, GitHub's web-merge committer and `[bot]` accounts                   |
| 14  | Label review is upgraded from single AI to human           | `manual`: calibration labels reviewed by at least one human before claims are made publicly    |

Notes

- **Methodology 0.3 (2026-10-11):** gate 5 is expected to FAIL until a fresh holdout is evaluated for methodology 0.3; the 0.2 holdout (`final-methodology-0.2`) was already observed once and does not validate 0.3. The gate is deliberately not relaxed.

- The script reports `PASS`, `FAIL`, `MANUAL` and `SKIP` (online gates when offline). Exit code 0 only when no gate is
  `FAIL`; use `--strict` to also fail on `MANUAL`/`SKIP` (this is what a release must run).
- Gates are intentionally conservative: a missing artifact is a `FAIL`, never a pass.
- Passing the gates does not make scores correct; it only means the known evidence-quality prerequisites exist.

## Methodology 0.4 (2026-10-11)

Gate 5 now requires a result with `fresh_holdout: true`, `for_methodology` equal to the current methodology and `methodology_version` matching: `calibration/results/fresh-holdout-0.4-methodology-0.4.json`. It fails until that single run has been made and is never satisfied by an older methodology's holdout. Gate 14 (human label review) remains **manual**: the 0.4 labels were produced by one AI-assisted reviewer and a blind-review workflow exists (`calibration/review/README.md`) but no human has signed off, so the gate is not marked as passed.


## 0.5 (2026-10-11)

Methodology is unchanged (0.4), so the fresh holdout `fresh-holdout-0.4` still validates gate 5. A second fresh holdout, `identity-holdout-0.5`, evaluated Identity v2 once; gate 6 (identity quality audited) now includes its result, which is weaker than the tuned dev/validation numbers and is reported as such. Gate 14 remains manual: no human has reviewed any label.
