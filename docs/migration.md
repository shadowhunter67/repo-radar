# Migration notes

## 0.1 -> 0.2 (report schema 0.2, methodology 0.2)

Compatibility goal: consumers of 0.1 reports keep working; everything new is additive except the items marked **changed**.

### Additive

- Top level: `facts[]`, `code_analysis{}`, `findings[]`, `integrity{report_sha256}`.
- `methodology`: `taxonomy_version`, `detector_pack_version`, `facts_version`, `config_digest`.
- `identity`: `artifact_type`, `artifact_confidence`, `artifact_alternatives`, `domain`, `alternatives`, `capabilities`,
  `purpose_summary`, `taxonomy_version`.
- Evidence source `derived` (only used by rule inputs resolved from `facts`).
- 7 new rules (3 scored, 4 informational; 84 rules in total), the `--no-scan` flag and Action input `code-scan`.

### Changed

| What | Before | Now | Why |
| ---- | ------ | --- | --- |
| Display label of dimension `code-quality` | "Code Quality" | "Engineering Hygiene" | The dimension measures process indicators (tests, lint config, typing, CI), not the quality of the code. The **id `code-quality` is unchanged** so JSON consumers and profiles keep working. A deeper code-quality / maintainability analysis (complexity, duplication, error handling) will get its own dimension later. |
| Inputs of `security.token-permissions` and `supply-chain.pinned-actions` | `github.workflows.*` evidence ids | normalized facts `ci.permissions.declared_ratio`, `ci.actions.pinned_ratio` | First rules migrated to the fact layer; values are identical. |
| `rule.evidence_ids` | always ids from `evidence[]` | ids from `evidence[]` **or** `facts[]` | Rules may read facts. |
| `methodology.version`, `schema_version` | `0.1` | `0.2` | Rule set, evidence sources and report shape changed. Reports with different digests are not comparable. |
| Scores | - | can differ slightly for the same repository | More rules apply (coverage rises) and secrets/install hooks can lower Security and Supply Chain. |

### Custom classifiers

`IdentityClassifier.classify` must now return the new identity fields (`artifact_type`, `domain`, ... ). `capabilities` may be
an empty array: the pipeline fills it after the scan.

### Rule/profile files

`methodology:` in rule files must read `'0.2'` (a loader check). Profiles are unchanged.

### Reading the new evidence ids

`derived_from` ids in a fact may point at evidence ids, or at ids inside `code_analysis` (`CAP-*`, `CHAIN-*`, `HOOK-*`, `SEC-*`).
