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

## Fresh holdout 0.4 and review workflow

`calibration/fresh-holdout-0.4/` (14 repositories, none from the earlier corpora, pinned commits in `pins.json`) is the holdout for methodology 0.4. Repositories whose analyzer output had been inspected during development were excluded. Run it once: `node scripts/calibrate.mjs --corpus calibration/fresh-holdout-0.4 --final`; a second final run of the same (corpus, methodology) is refused, and a corpus whose `for_methodology` differs from the analyzer is refused. No tuning on its result in this cycle.

Labels come from one AI-assisted reviewer, not a human. The blind-review workflow (`scripts/make-review-packets.mjs`, `scripts/compare-reviews.mjs`, `calibration/review/README.md`) lets independent reviewers label packets without seeing analyzer output and reports disagreements; release gate 14 stays manual until that has been done by people.


## Identity holdout 0.5

`calibration/identity-holdout-0.5/` (16 repositories, all pinned by commit) evaluates Identity v2, which was tuned only on the dev and validation splits above. Only identity fields (artifact type, packaging, domain) are labelled; everything else is `unknown`. It was run once (`--final`); the result is in `calibration/results/identity-holdout-0.5-methodology-0.4.md` and must not be used for tuning, so the next identity iteration needs a new corpus. Labels are AI-assisted single review; the blind packets in `calibration/review/` apply to this corpus too. The label schema now also supports `packaging`, `field_status` and per-reviewer `opinions`, so disagreement is stored instead of forced into consensus.


## Identity holdout 0.6

`calibration/identity-holdout-0.6/` (18 repositories, pinned by commit) was created after the structural Identity v2 rules of cycle 0.6 were frozen and run once (`--final`): `calibration/results/identity-holdout-0.6-methodology-0.4.md`. It must not be used for tuning. Labels cover artifact type, packaging, domain, interfaces and deployment form; everything else is `unknown`. Result: primary artifact 67% overall / 75% answered (legacy single label 50% / 56%), top-2 83%, packaging 80%, interfaces precision 63% / recall 81%, ECE 0.33. The single AI-assisted reviewer means these are upper bounds; the blind-review packets apply to this corpus too.
