# Scoring methodology (version 0.2)

repo-radar evaluates **observed evidence** against **published rules**. Everything below is implemented in
[src/scoring/engine.ts](../src/scoring/engine.ts); the rules are data in [standards/](../standards).
The report records the methodology version and a SHA-256 digest of all rules (`methodology.rules_digest`), so two
reports are comparable only if both match.

## 1. Rules

A rule reads one or more evidence ids and maps the value to a score from 0 to 10:

| Type         | Meaning                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| `map`        | exact value (`true`, `false`, `none`, ...) to score, with optional `default`           |
| `thresholds` | numeric value, first step (highest `gte` first) that matches wins, else `otherwise`    |
| `linear`     | clamp((value - min) / (max - min)) x 10, optionally inverted                           |

Other rule fields: `weight`, `group` (correlation budget), `applies_when` (applicability), `combine`
(`first | min | max | mean` over several evidence ids), `informational` (reported, never scored), `warn`
(message when the score is below a level), `rationale`, `limitations`.

A rule ends in exactly one **status**:

- `scored`: evidence was observed.
- `not_observed`: no usable evidence. `missing_reason` says why: `unavailable` (collector failed or was rate limited),
  `not_collected` (source disabled by the user), `insufficient_coverage` (collected, but too little code was read for a
  "not found" result to count), `not_reported` (source answered, signal absent).
- `not_applicable`: its `applies_when` condition is false (for example "pinned actions" when there are no external actions,
  or "code review" for a single-contributor repository). If the condition's evidence is itself unobserved, the rule stays applicable.
- `informational`: shown with its score, weight 0.
- `disabled`: weight set to 0 by the profile.

**Missing evidence is not negative evidence.** An unobserved rule is excluded from the score and counted against
coverage and confidence only.

## 2. Dimension score

For the scored rules of a dimension, with profile weight `w` and score `s`:

```text
group scaling:   rules sharing a `group` (within a dimension) share the weight of their heaviest member:
                 effective_w = w x min(1, max_w_in_group / sum_w_of_scored_members_in_group)
score  = 10 x  sum(effective_w x s) / sum(effective_w)          (0 to 100)
```

Groups exist because one fact is often measured twice (our own branch-protection check and Scorecard's, for instance).
Ten signals about the same fact must not outvote one independent signal. Groups are declared in the rules, so
they are reviewable. Correlation _across_ dimensions is avoided by placing each fact in one dimension (see
[bias](bias.md)); that is a design discipline, not an automatic guarantee.

## 3. Coverage, quality, confidence

```text
coverage  = sum(unit weight of scored rules) / sum(unit weight of applicable rules)
            (a correlation group counts once, at its heaviest member, so losing a "twin" signal does not lower coverage
             when the fact is already observed)
quality   = sum(effective_w x c) / sum(effective_w),    c = evidence.confidence x source_reliability
confidence = coverage x quality                           (0 to 1)
```

`evidence.confidence` is set by the collector (sample size, truncation, freshness of Scorecard data...). Source reliability
is a fixed multiplier: github 1.0, scorecard 0.9, osv 0.9, manifest 0.9, identity 0.7, heuristic 0.6. These values are a
hand-authored judgement, not calibrated against labelled data (see [limitations](limitations.md)).

Because score and confidence are separate, "Security 91, confidence 42%" is possible and means: what was seen looks good,
but little was seen.

## 4. Sufficiency and score range

- `insufficient`: fewer than 2 scored rules, or coverage below 30%. The grade is `N/A` (the numeric score is still in the JSON).
- `low`: graded, but confidence below 50%.
- `score_range = [pessimistic, optimistic]`: the score if every unobserved applicable rule had scored 0, respectively 10
  (same group budgeting). The text report prints it when the range is 20 points or wider.

## 5. Overall score

```text
overall_score      = weighted mean of dimension scores over dimensions that are not `insufficient`
                     (weights from the profile; renormalized over the dimensions used)
overall_confidence = sum(dim_weight x dim_confidence) / sum(all dim_weights)    (missing dimensions count as 0)
overall is N/A if the contributing dimensions carry less than 50% of the total weight
```

The overall number is a convenience. Read the dimensions.

## 6. Grades

`>=95 A+`, `90 A`, `85 A-`, `80 B+`, `75 B`, `70 B-`, `65 C+`, `60 C`, `55 C-`, `45 D`, else `F`. Grades are labels for
the numeric score, not independent judgements, and they say nothing about the confidence.

## 7. Profiles

A profile ([profiles/](../profiles)) changes dimension weights, individual rule weights (0 disables) and advisory
minimums. It never changes evidence. Minimums are reported as `policy.violations`; they only affect the exit code with
`--enforce-profile` or explicit `--min` flags. A floor that cannot be verified (insufficient evidence) counts as a violation,
because "unknown" must not pass a gate.

## 8. Semantic identity and scoring

Identity influences scoring in exactly one place: `semantic-clarity.detected-purpose` (weight 3 within Semantic Clarity),
which treats "a classifier could determine the purpose from declared metadata" as a clarity signal. No Security,
Supply Chain, Maintenance, Engineering Hygiene or Community rule reads identity.

## 9. Normalized facts

Rules do not have to read raw collector output. `src/facts` derives **facts** from evidence and from the static code analysis
([code-analysis.md](code-analysis.md)); a fact has an id, value, `confidence`, `scope`, `derived_by` and `derived_from` (ids
that resolve to evidence or to detections, chains, hooks and secret candidates in the report). Families: `artifact.*`, `ci.*`,
`capability.*`, `execution.*`, `persistence.*`, `secret.*`, `scan.*`.

- Facts enter scoring as evidence of source `derived` (reliability 1.0: the fact already carries its own confidence). The report
  lists raw evidence in `evidence[]` and facts in `facts[]`; a rule input id resolves in either.
- **Absence is a fact with reduced confidence, and only when enough was read.** `capability.x.observed = false` has confidence
  `0.3 + 0.5 x source_coverage` (0.3 to 0.8): "not found in what was scanned", never "not present". Because the score is a
  weighted mean of rule scores (confidence does not weight it), a cheap "nothing found" must not become full marks:
  absence facts (`capability.*.observed=false`, `persistence.*`, `execution.chain.*`, `secret.candidates.count=0`) are **only
  emitted when the scan covered at least 20% of the source files and at least 3 code files** (`scan.absence_reliable`).
  Otherwise the rules that read them are `not_observed` with `missing_reason: insufficient_coverage`, a diagnostic
  explains why, and the score range widens. Positive observations are always emitted. (Found during development: a
  README-only repository gained 31 Security points from "nothing found in 0 files" before this gate existed.)
- Rules migrated to facts so far: `security.token-permissions`, `supply-chain.pinned-actions` (via `ci.*`) and every
  rule added in 0.2. The remaining 70+ rules still read evidence directly and migrate incrementally; they behave identically.

## 10. Rules added in 0.2

Scored: `security.hardcoded-secrets` (6), `security.install-time-download-execute` (6), `supply-chain.install-hooks` (3).
Informational (weight 0, may warn): chains outside install hooks, persistence, credential-store access, browser-data access.
Capability findings are **context for review**; only a clean/dirty outcome on secrets, install-time download-and-execute and
install-hook risk changes a score. The score impact of the scored rules is visible in `dimensions[].rules[]` and linked from
findings through `rule_ids`.

## 11. Dimension naming

The dimension id `code-quality` is kept for compatibility, but its label is **Engineering Hygiene**: it measures whether tests,
lint configuration, static typing and CI are *present*, not whether the code is good. Deeper code analysis (complexity,
duplication, error handling, API design) is future work and will be a separate dimension; see [migration.md](migration.md).

## 12. Reproducibility and integrity

Reports record: tool version, `schema_version`, `methodology.version`, `rules_digest`, `taxonomy_version`,
`detector_pack_version`, `facts_version`, the classifier id, profile id/version and a `config_digest` (profile, source toggles,
scan limits). `integrity.report_sha256` is the SHA-256 of the report without that field: **tamper evidence, not a signature**
(anyone can recompute it). Reports from different digests are not comparable.

## 13. Versioning

| Thing                        | Where                                             | Current |
| ---------------------------- | ------------------------------------------------- | ------- |
| Evidence/report schema       | `schema_version`, `schemas/*.json`                | 0.2     |
| Methodology (rules, formulas)| `methodology.version`, `methodology.rules_digest` | 0.2     |
| Profiles                     | `profile.version`                                 | 0.1     |
| CLI                          | `tool.version` (`package.json`)                   | 0.2.0   |
| Identity taxonomy            | `methodology.taxonomy_version`                    | 0.2     |
| Detector pack                | `methodology.detector_pack_version`               | 0.1     |
| Facts                        | `methodology.facts_version`                       | 0.1     |

Any change to a rule, weight, threshold or formula changes the digest; a change in meaning bumps the methodology version.
