# Incident calibration (0.8, phase 1)

Phase 1 measures registry-history observations and the dependency takeover patterns against a pinned, offline corpus. It changes no score, rule, shipped profile or trust root (methodology stays 0.4). Raw npm packuments and crates.io responses saved on 2026-10-15 in `calibration/incidents/raw/` are the only registry evidence; the production parsers, event analysis and correlation engine are used.

## Corpus (`calibration/incidents/cases.json`, schema in the README there)

31 cases over 27 packages: 12 incident-labelled (10 npm packages involved in public incidents) and 19 benign handoffs/controls (npm and crates.io). Each case has hand-written `expected_events` read from the raw file, per-label observations (`true` / `false` / `unknown`), an incident window and a known-good window, a conclusion kept separate from the observations, and sources.

**Splits are decided by package (ecosystem + name), not by case id.** A first version split by case id and put the same registry history in development and in the holdout (event-stream, express, ua-parser-js); that leak was found in review and removed. Resulting split: development 21 cases (9 incident), validation 6 (1 incident), holdout 4 (2 incident, 2 benign). Validation therefore has a single incident case: validation numbers for incident detection are not meaningful. This is stated rather than re-rolled after looking at results.

Labels are single AI-assisted and **not independently validated**; no reviewer is recorded. Blind review packets (`calibration/incidents/review/`) hide labels and conclusions for a future human reviewer; gate 14 stays MANUAL.

## What registry history can and cannot show

Malicious npm versions are usually removed after an incident, so the pinned packument often does not list them. `install_script_introduced`, `external_domain_introduced` and cadence cannot be decided for most incidents: those labels abstain. Pattern expectations for incident cases are therefore `null` (abstention) and are **not** counted in precision or recall: the patterns need an install script or a domain that registry metadata cannot show for these incidents.

## Measured results (development + validation; holdout not evaluated)

Raw observation labels (n = cases with a decided label; accuracy / precision / recall / benign FPR):

| Observation | n | Accuracy | Precision | Recall | Benign FPR |
| ----------- | - | -------- | --------- | ------ | ---------- |
| publisher change | 27 | 0.70 | 0.65 | 0.85 | 0.35 |
| maintainer change | 27 | 0.96 | 1.00 | 0.95 | 0.00 |
| repository change | 27 | 0.48 | 0.86 | 0.32 | 0.06 |
| dormancy end | 27 | 0.74 | 1.00 | 0.68 | 0.00 |
| install script introduced | 27 | 1.00 | 1.00 | 1.00 | 0.00 |
| provenance changed | 27 | 0.89 | 1.00 | 0.25 | 0.00 |
| cadence change, external domain | 0 | - | - | - | - |

Patterns (the real correlation engine over the events inside each case window; 17 decided benign cases, 10 incident cases abstain):

| Pattern | Benign false-positive rate | Incident cases fired |
| ------- | -------------------------- | -------------------- |
| `dependency-takeover-indicators` | **5 of 17 (29%)**: chalk, left-pad (twice), minimist, mkdirp | 0 of 10 |
| `dependency-dormancy-publisher-hook` | 0 of 17 | 0 of 10 (needs an install script the registry cannot show) |

Window sensitivity (`within_days` 7 to 180): no change in either pattern. The false positives come from the second step alternatives `dependency_repository_changed` and `dependency_provenance_removed`, which occur in benign histories after a dormancy or maintainer change; the window is not the problem.

## Decisions

No threshold was changed: no window shows a stable validation gain. Dormancy, cadence and new-publisher thresholds were not gridded because the event-level expectations were authored against the current definitions (a grid would be circular). **Finding to act on, not hidden:** the `dependency-takeover-indicators` pattern is too weak when its second step is a repository change or lost provenance without an install script; it fires on legitimate maintainer handoffs. It remains an indicator ("intent undetermined"), is not enabled by any shipped profile, and should be narrowed (an install script or new domain required) in a later change measured on fresh cases. The publisher-change observation has a 35% benign false-positive rate, consistent with legitimate hand-overs being common.

## Limits

27 packages, mostly npm; one validation incident; incident versions removed from registries; benign-labelled cases are labelled from the raw history only where confident; labels are single AI-assisted. The numbers describe this corpus, not the world. `--final` evaluates the holdout once and writes `calibration/incidents/results/final-holdout.json`; it has not been run.

## Final holdout (run once, 2026-10-16)

`node scripts/calibrate-incidents.mjs --final` was run exactly once at HEAD 146f7ce, after the incident-related code, thresholds and corpus were frozen. The result file `calibration/incidents/results/final-holdout.json` is checked in and a second final run refuses to overwrite it. **Nothing was tuned after observing it, and nothing may be in this cycle.**

Holdout split (by `ecosystem:package`): 3 packages, 4 cases (npm express twice: history and control window, npm faker, npm flatmap-stream).

## Corpus v2 (0.11.x; holdout not run)

Evaluation results record `incident_model_version: 0.11.0`, independently of the report schema and methodology version.

## Metric recalculation (holdout files immutable)

`final-holdout.json` and `final-holdout-v2.json` are spent and were not modified or rerun. `scripts/recalculate-incident-metrics.mjs` reads each original by-case result, joins its pinned case labels, and writes `results/metric-recalculation-v2.json` with the source SHA-256 and separate development, validation, holdout, and overall blocks. The recalculation is not a fresh evaluation.

The root cause of the historical `dormancy_end.false_positive_rate = 1.5` was the old denominator: it divided FP by all non-incident rows rather than by `FP + TN`. The corrected module uses `false_positive_rate = FP/(FP+TN)`, `false_negative_rate = FN/(FN+TP)`, precision, recall, specificity, accuracy, coverage, and abstention rate. Zero denominators are `null`; abstentions are counted separately and excluded from confusion-matrix rates. Every rate is accompanied by explicit counts and no aggregate block is labeled as a holdout.

Corpus v2 is frozen at 62 cases: 40 development, 10 validation, and 12 holdout cases. It adds 25 histories (7 incident candidates and 18 benign controls) and 8 incident-window cases. The v1 holdout cases for `express`, `faker`, and `flatmap-stream` remain in the corpus with `holdout_spent: true` and are excluded from v2 holdout metrics. Review packets cover all 33 new v2 cases. Labels remain AI-assisted and unreviewed; Gate 14 remains MANUAL.

The non-final evaluator was run offline after corpus authoring. It evaluated 50 development/validation cases; the v2 holdout was not selected and `results/final-holdout-v2.json` does not exist.

Raw observation metrics (decided n / abstentions):

| Observation | n | Abstentions | Accuracy | Precision | Recall | Benign FPR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| publisher change | 47 | 3 | 0.745 | 0.800 | 0.800 | 0.207 |
| maintainer change | 47 | 3 | 0.894 | 1.000 | 0.865 | 0.000 |
| repository change | 47 | 3 | 0.404 | 0.909 | 0.270 | 0.034 |
| dormancy end | 47 | 3 | 0.617 | 0.577 | 0.682 | 0.379 |
| install script introduced | 47 | 3 | 0.979 | 1.000 | 0.800 | 0.000 |
| provenance changed | 47 | 3 | 0.830 | 1.000 | 0.500 | 0.000 |
| release cadence / external domain | 0 | 50 | — | — | — | — |

Pattern metrics over development/validation: `dependency-takeover-indicators` decided 32, abstained 18, fired on 0 decided incident cases and 5 benign cases (benign FPR 5/32); `dependency-dormancy-publisher-hook` decided 32, abstained 18, fired on 0 incident and 0 benign cases. Abstained incident cases are excluded from the denominator. These are descriptive results only; no threshold or pattern was changed.

The v2 final output is intentionally a separate, write-once `results/final-holdout-v2.json`. It must contain only non-spent holdout cases and holdout-only metrics when the reviewer authorizes the manual final run. The old v1 final result is spent and is not evidence for v2.

K3 pattern replay: `dependency-control-change-then-install-capability` was evaluated on development/validation only and abstained on all 50 cases (0/0 decided benign, 0/0 decided incident). The registry-only corpus has no verified artifact pairs, so behavior/domain events cannot be replayed; no detection claim is made. The existing pattern remains comparable at 5 benign fires / 32 decided benign cases and 0 decided incident fires / 0 decided incident cases (18 incident cases abstained). Holdout was not inspected or run.

| Measure | Count |
| --- | --- |
| Benign controls (express x2) | 2; temporal patterns fired on 0/2 (benign false positives 0/2) |
| Known compromise (flatmap-stream) | 1; patterns fired on 0/1 (recall 0/1); the registry history of the package itself shows no publisher, maintainer or repository event, so the signal was not observable in this evidence |
| Insufficient evidence (faker) | 1; excluded from precision and recall; no pattern fired |
| Precision of `dependency-takeover-indicators` | undefined (0 true positives, 0 false positives on holdout) |

Caveats, stated plainly: four cases cannot support a rate; the incident case is one package whose compromise was delivered through a newly added dependency rather than a change of control of the package itself; the aggregate block of the result file mixes all three splits (the file lists every case with its `split`), so only the per-case rows above are holdout evidence. The development and validation finding is unchanged: `dependency-takeover-indicators` fired on 5 of 17 benign controls and on 0 of 10 incident cases. Labels remain single-reviewer, AI-assisted and are internal engineering evidence only; Gate 14 stays MANUAL.

Weakness recorded for future work (not acted on here): the takeover pattern needs narrowing (for example requiring an install hook or a new external domain) and the corpus needs incidents that are visible in package registry history.

## Final holdout v2 (run once, 2026-10-21)

`node scripts/calibrate-incidents.mjs --final` was run once on corpus v2 at HEAD 32a66aa after code, thresholds and corpus were frozen; `calibration/incidents/results/final-holdout-v2.json` holds the result and a second run refuses to overwrite it. Nothing is tuned from it. It contains only holdout-split cases (8 cases over 6 packages: xrpl and @ctrl/tinycolor as incidents, rand-user-agent as insufficient evidence, commander, cross-env and regex as benign controls).

Result: no temporal pattern fired on any of the 8 cases. Benign false positives 0/3. Incident recall is not measurable: `dependency-takeover-indicators` and `dependency-dormancy-publisher-hook` decided 3 and abstained 5, `dependency-control-change-then-install-capability` abstained on all 8 because the corpus has registry history only and no verified artifact pairs. Precision and recall are therefore undefined, not zero. With 3 benign controls this says little about false positives. The result mainly shows what the corpus cannot test: the redesigned pattern has never been exercised on an incident.

Future work (not done here): add incidents with pinned artifact pairs so behavioral patterns can decide; labels remain single-reviewer, AI-assisted; Gate 14 stays MANUAL.
M3/M4 incident model version is 0.12.0 for future non-holdout evaluations; spent v1/v2 result files are immutable and were not rerun.
## Corpus v3 freeze (2026-10-21)

Corpus v3 freezes the case schema, package-to-split assignment, labels, artifact-pair paths and integrity strings,
inspector/delta code, pattern data, and threshold definitions. Freeze commit placeholder: `<reviewer fills this after
manual Gate 14 review>`. The fresh holdout has two packages (`@ctrl/tinycolor`, `faker`) and was not evaluated.

The non-final development/validation run covered 9 cases total: 6 development, 1 validation, and 2 holdout-assigned;
5 known-benign, 1 ambiguous, 1 known-incident, and 2 insufficient-evidence. Six non-holdout cases were considered,
five had verified artifact pairs, and five produced behavior-delta coverage. History-introduction coverage was 0 because
these are artifact-pair cases without repository lineages. Synthetic plumbing cases are excluded from accuracy metrics.
No holdout result was generated. These labels remain AI-assisted and unreviewed; Gate 14 is MANUAL.

## Final holdout v3 (2026-10-21)

Freeze commit: `896d2e1` (corpus v3, evaluator, inspector/delta code, patterns and thresholds frozen). `calibration/incidents-v3/results/final-holdout-v3.json` holds the holdout-only result and the evaluator refuses to overwrite it (`wx`).

Process disclosure: the evaluator's `--final` branch was first mis-wired and wrote the holdout output into `development-validation.json` instead of the final file (this happened on two invocations; the output is deterministic and identical). The reviewer saw only coverage counts at that time; the content was then preserved as `final-holdout-v3.json`, `development-validation.json` was restored from git and the write path fixed. The holdout was therefore evaluated more than once mechanically, with no code, label or threshold change between runs.

Result (2 real artifact-pair cases: faker 5.5.3 -> 6.6.6 labeled known_incident, @ctrl/tinycolor 4.1.0 -> 4.2.0 labeled insufficient_evidence): both pairs had verified digests and a behavior delta was computed; no behavior change was observed on either. TP 0, FP 0, TN 1, FN 1 (recall 0/1, specificity 1/1); precision undefined. The evaluator counts insufficient_evidence as a negative here, which is a questionable choice for tinycolor and should be revisited. The faker 6.6.6 sabotage is a code-level change with no install hook, so the install-time behavior detectors correctly observe nothing: this documents a limit of the detector set, not a tuning target. The tinycolor 4.2.0 provenance gain is registry metadata and is not part of the artifact delta, so it is invisible to this evaluation. Two cases cannot support any rate. Nothing is tuned from this result.
