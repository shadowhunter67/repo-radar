# Calibration corpus v0

A small, pinned, labelled set of real repositories used to **measure** where repo-radar is right and wrong. It is a
measurement tool, not a source of truth: read [Limitations](#limitations) before quoting any number.

## Contents

| Path                         | What                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `dataset.yaml`               | The 48 repositories, why each is included (categories), `tuned_on` flags and review defaults.            |
| `pins.json`                  | The commit SHA each repository is analysed at (`calibration/tools/fetch-corpus.mjs` writes it).          |
| `labels/<owner>__<repo>.yaml`| Judgements only: artifact type, domain, capabilities (yes/no/unknown/disputed), hooks, persistence, secrets. |
| `tools/dossier.mjs`          | Builds an evidence dossier from crude patterns (grep-style, **not** the analyzer) for the labeller.      |
| `results/`                   | Committed evaluation outputs (`tuning-*.md/json`). `runs/` is a git-ignored per-repository report cache. |

The loader (`src/calibration/load.ts`) merges dataset + pins + labels and refuses inconsistent corpora (missing label,
missing pin, commit mismatch). `tests/unit/calibration-corpus.test.ts` enforces size (30-50), SHA pins, split
population, category coverage and label sanity.

## Splits and discipline

`dev`, `validation`, `holdout` are assigned by hash of the repository name (about 40/30/30 %); repositories flagged
`tuned_on` (looked at while building the analyzer) are forced into `dev`.

- Fix the analyzer using **dev** failures; use **validation** to check a fix generalises.
- **Holdout** is evaluated only with `--final`, once per methodology version, at the end of a tuning cycle. The runner
  refuses it otherwise (exit 64). Never tune on holdout results.
- Validation stops being independent after it has been used to choose fixes; the result files say which run is which.
- Only generalisable defects are fixed (a rule that is wrong for a class of repositories). A repository-specific tweak is
  overfitting and is not accepted.
- Every fix found by calibration gets a small, synthetic regression test (not the real repository).

## Running

```
npm run build
GITHUB_TOKEN=... node scripts/calibrate.mjs                    # dev + validation
GITHUB_TOKEN=... node scripts/calibrate.mjs --splits dev --only owner/repo --refresh
GITHUB_TOKEN=... node scripts/calibrate.mjs --final            # holdout too; once per methodology version
```

The analyzer is run with `--ref <pinned sha>`: files, tree and commits are the pinned revision, while API-derived
metadata (issues, releases, contributors, branch protection) is current and is **not** used by the metrics. Scorecard and
OSV are disabled for calibration (non-deterministic, network).

## Metrics

Artifact type and domain: accuracy over the labels that are decided (`unknown`/`disputed` are excluded), split into
answered vs abstained (the analyzer answering `unknown` is neither right nor wrong, and is reported on its own),
"correct including alternatives", a confusion matrix and ECE. Binary detectors (each capability, automatic install hooks,
persistence, hard-coded secrets): TP/FP/FN/TN, precision, recall, with `unknown` labels excluded; capability recall is
also split by how much of the source was actually scanned. Confidence calibration: bins, expected calibration error,
Brier score. Disagreements are listed so each can be inspected.

## Limitations

- Labels come from **one AI-assisted reviewer** (`review.kind: ai-assisted-single`), not independent human review, and
  were produced from crude-pattern dossiers rather than a full code read. Treat metrics as indicative, with the label
  noise as an unmeasured error term. The corpus is meant to be re-labelled by humans.
- 48 repositories, mostly npm / Python / Go / Rust; Java, C/C++ and shell are thin. Per-capability cells have small n;
  one repository can move a percentage by 10 points or more.
- Capability labels are about observable code behaviour, not intent. Static analysis only sees what fits the scan
  budget (40 files); recall is therefore reported against scan coverage.
- Ordinal judgements (security maturity etc.) are **not** labelled yet, so scores are not calibrated here.
- Dev contains repositories the analyzer was built against, so dev numbers are optimistic by construction.

See also [docs/limitations.md](../docs/limitations.md) and [docs/roadmap.md](../docs/roadmap.md).
