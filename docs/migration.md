# Migration notes

## 0.3 -> 0.4 (report schema 0.4, methodology 0.4)

Compatibility goal: additive except the items marked **changed**. 86 rules in total (no rule added or removed).

### Additive

- Top level `regulatory{}` (applicability and readiness per pack, `legal_determination: "not_provided"`, disclaimer); `policy.blocks_evaluated` and `policy.block_violations`; `code_analysis.execution` hooks/edges carry `stage`, `trigger_kind`, `environment`, `details`; `entrypoints` and `projects` lists; graph node kinds `backend`/`entrypoint`/`extension`, relations `SELECTS_BACKEND`/`CONFIGURES`/`BUILDS`/`DEFINES`.
- Dependencies carry `context: primary|auxiliary`; ecosystem `Maven`; `dependency_intel.conflicts` entries use the shared conflict model (observations, preferred source, reason).
- New facts `execution.entrypoints.count`, `execution.build.repository_code`, `execution.native_build.present`, `osv.eligible_packages`, privacy/AI `privacy.<category>.observed` / `ai.<category>.observed`.
- CLI `diff`, `model`, `--no-compliance`; profile key `block`; standards packs `standards/regulatory/*.yaml` (digest included in `config_digest`).

### Changed

| What | Before | Now | Why |
| ---- | ------ | --- | --- |
| `osv.vulnerable_ratio` | vulnerable / eligible | vulnerable / checked | Observed risk is separate from completeness. |
| OSV evidence confidence | derived from checked share | `round(0.2 + 0.8 * coverage, 2)` | Completeness lowers confidence, not the ratio. |
| Identity confidence | unlabelled | `confidence_semantics: heuristic_uncalibrated` | Holdout ECE about 0.33; not rescaled. |
| Hook names | could carry an ecosystem prefix | no prefix; reports print `ecosystem:name` | Avoids double prefixes. |
| Lockfile coverage | any lockfile in the tree | own directory, listed importers, workspaces | Root lockfile no longer covers `examples/`. |
| `schema_version`, `methodology.version`, package | `0.3` | `0.4` | New sections; scoring input semantics changed. |

Rule files must declare `methodology: '0.4'`. The 0.2 holdout and any 0.3 result do **not** validate 0.4: release gate 5 needs the fresh holdout `calibration/fresh-holdout-0.4`.

## 0.2 -> 0.3 (report schema 0.3, methodology 0.3)

Compatibility goal: consumers of 0.2 reports keep working; the changes are additive except the items marked **changed**. 86 rules in total (two new informational rules).

### Additive

- Top level `dependency_intel{}`; new fact family `deps.*` (fact `scope` may be `dependency`); finding `category` may be `dependency` or `sbom`.
- CLI `--no-deps-dev` and `--no-sbom`; library options `depsDev`, `sbom`. New allow-listed host `api.deps.dev`.
- `methodology.config_digest` also covers the deps.dev/SBOM switches and the dependency limits.

### Changed

| What | Before | Now | Why |
| ---- | ------ | --- | --- |
| `osv.coverage_ratio` | `min(1, queried packages / direct dependency count)`, transitive lockfile packages included | share of direct registry dependencies with an exact version and a successful lookup | The old value could be 100% while few direct dependencies were checked. |
| `osv.vulnerable_ratio` | always emitted after a successful lookup | withheld when 0 vulnerabilities were found and the direct coverage is below 50% | "0 vulnerable among the 10% we could check" is not evidence about the rest; the rule is `not_observed` / `insufficient_coverage`. |
| `schema_version`, `methodology.version` | `0.2` | `0.3` | New report section; scoring input semantics changed. Reports of different methodologies are not comparable. |

Rule files must declare `methodology: '0.3'`. Holdout results recorded for methodology 0.2 do **not** validate 0.3 (release gate 5 fails until a fresh holdout exists).

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
