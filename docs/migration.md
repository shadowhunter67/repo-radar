# Migration notes

## 0.6 -> 0.7 (report schema 0.7, methodology 0.4)

Additive except the items marked **changed**. 86 rules in total (unchanged); scoring semantics untouched, so the fresh holdout of methodology 0.4 stays valid and no new holdout is required. Not accepted: schema `0.6` reports by tools that only know 0.7 (the `model` and `graph` commands ask for a re-run).

### Additive

- Top level `dependency_registry_intel{}` and `external_domains{}`; `retrieval.declared_paths{}`, `retrieval.manifest_seek{}`, `retrieval.manifest_paths{}`; registry versions: optional `repository`, `has_install_script`, `maintainers`; registry package: optional `resolved_times`, `repository.homepage_normalized`; verification: `engine` and `subject`; signatures: `local_detail`, `basis`; `release_intel.key_material_in_repository`, `verification_run.signatures` / `trusted_keys`.
- Timeline: new event types and sources, optional `entity`, pattern flag `same_entity`, four built-in patterns. Fact scope `domain`, facts `registry.deps.*`, `domains.*`, `release.signatures.*`, `release.tag.signature_locally_verified`; finding category `domain`, ids `RR-DEPREG-*`, `RR-DOM-*`.
- Trust graph: nodes `TrustRoot`, `Registry`; edges `VERIFIED_BY`, `USES_TRUST_ROOT`, `PUBLISHED_IN`, `CORRESPONDS_TO`; edge fields `introduced_at` / `removed_at`; `graph --query`, `graph --snapshot-dir`; `snapshots --export-to / --import-from`.
- Historical diff: `domains[]` and `provenance[]`.
- Policy: `require` keys `locally_verified_signature`, `dependency_registry_match`, `dependency_publisher_stability`, `dependency_provenance_reported`, `no_dependency_takeover_indicators`; `history_block` kinds `new_install_time_domain`, `provenance_verification_lost`, `source_binding_conflict`. None is in a shipped profile.
- CLI: `--no-dep-registry`, `--dep-registry-max`, `--dep-registry-requests`, `--dep-registry-time`, `--no-domains`, `--trust-config`, `--trust-gpg-key`, `--trust-minisign-key`, `--expect-signer`.
- Dependency `openpgp` 6.3.2 (exact, loaded lazily). Package 0.7.0.

### Changed

| What | Before | Now | Why |
| ---- | ------ | --- | --- |
| Trust roots | `user_supplied_key`, `project_pinned_key` (never emitted) | `user_supplied_gpg_key`, `project_pinned_gpg_key`, `user_supplied_minisign_key`, `project_pinned_minisign_key` | The algorithm is part of what a root verifies. |
| Verification states | 6 | + `verification_skipped_resource_limit` | A limit stopped the check; it is not a failure to decide. An oversized Sigstore bundle used to be `verification_failed`. |
| Sigstore error classification | message regex | the library's error codes first, then the regex | `inclusion proof`, `expired` and `digest mismatch` are rejections even though they mention the log. |
| `release.signature_assets.present` | signatures with `verified_by: none` | signatures not asserted by GitHub | A signature asset checked locally is still present. |
| Asset `checksums.txt.sigstore.json` | classified as a checksum file | a signature | Found by the real goreleaser probe. |
| Large attestation bundles | counted, not read | downloaded from GitHub's attestation store within strict limits | Found by the real cli/cli probe (5 of 5 unreadable before). |
| Targeted tree | manifests at depth <= 2 | depth <= 8 and up to 24 manifests read for a TARGETED tree only; complete trees keep depth 2 | The staging modules kubernetes' `go.work` names were listed and then ignored. |
| Retrieval budget | one pool of 90 requests | + a declared-path pool (60) and a manifest-seek pool (24); total requests can exceed 90 | Declared paths are followed without widening the generic traversal. Tight budgets in custom code: set `declared: { maxRequests: 0, maxHintReads: 0 }` and `seek: { enabled: false }` for the 0.6 behaviour. |
| `getSnapshot` | returned the schema-parsed copy | returns the report as stored | Its integrity digest depends on key order. |
| Bundle banner (`npm run bundle`) | `createRequire` | aliased `__rrCreateRequire` | `openpgp` imports `createRequire` itself. |
| Package / schema | 0.6.0 / 0.6 | 0.7.0 / 0.7 | New report sections. |

Methodology stays 0.4: no rule, weight, fact consumed by a rule, or score input changed. The new facts feed policy only.

## 0.5 -> 0.6 (report schema 0.6, methodology 0.4)

Additive except the items marked **changed**. 86 rules in total (unchanged).

### Additive

- Top level `registry_intel{}`, `timeline{}`; `release_intel.verification_run`; per release `slsa{}` and `asset_checks[]`; per provenance record `verification_detail`; `identity_v2.primary_artifact.status` / `evidence_strength`, `identity_v2.deployment_form.supported`; `retrieval.passes` / `hints` / `skipped_by_rule` / `wide_directories`.
- Fact scope `registry`; facts `registry.*`, `release.provenance.verified`, `release.source_binding_verified`, `release.assets.checksum_verified`; finding category `registry`.
- CLI: `--verify-crypto`, `--verify-assets`, `--no-registry`, `--snapshot-dir`, `--snapshot-revision`, `snapshots`, `graph`. Profile keys `temporal_block` and more `require` keys. Dependency `sigstore` 4.1.0 (loaded only with `--verify-crypto`).

### Changed

| What | Before | Now | Why |
| ---- | ------ | --- | --- |
| Signature `state` values | `signature_present`, `signature_verified`, `signature_invalid`, `verification_unavailable` | `not_present`, `present_unverified`, `verified`, `invalid`, `verification_failed`, `verification_unavailable` + `trust_root`, `verified_by`, `local_state` | Presence, GitHub's assertion and local verification are different facts. |
| Provenance `verification` | `verification_unavailable` / `verified_by_github` | the same state vocabulary | Same reason. |
| `release_intel.releases[].correspondence` | 5 classes | + `verified_source_binding`, `verified_build_provenance`, `source_binding_conflict`, `digest_verified_only` | Verified binding needs more than an attestation. |
| Dormancy directories | read by the walk only when not on a deny-list | docs/tests/vendor rank low but are read when budget remains | Low priority must not mean never. |
| Cargo `publish = false` | public | private | Never published, never installed by dependents. |
| Package / engines | 0.5.0, Node >= 20 | 0.6.0, Node >= 20.17 | New report sections; `sigstore` requirement. |

Methodology stays 0.4 (see docs/methodology.md section 16); schema `0.6` reports are not accepted by tools that only know 0.5.

## 0.4 -> 0.5 (report schema 0.5, methodology 0.4)

Compatibility goal: additive. Methodology stays 0.4 because no rule, weight or score input changed (86 rules in total), so scores of 0.4 and 0.5 reports are comparable.

### Additive

- Top level `identity_v2{}`, `retrieval{}`, `coverage_map{}`, `release_intel{}`, `governance{}`.
- Fact scopes `release` and `governance` (`release.count`, `release.assets.count`, `release.tag.signature_verified`, `release.signature_assets.present`, `release.checksums.published`, `release.provenance.present`, `release.provenance.consistent_with_tag`, `release.correspondence`, `governance.takeover_indicators`, `governance.signals.count`); finding categories `release` and `governance`; evidence `github.commits.head_date`.
- CLI: `diff <owner/repo> --from <ref> [--to <ref>]`, `--no-releases`, `--no-targeted-tree`; `diff <old.json> <new.json>` returns the structured historical delta (`--format json` has more fields; the old `changes` list is still there).
- Profile keys `require` and `history_block`; the `enterprise` profile requires published checksums and blocks new install-time remote execution, new vulnerabilities and a new install hook alongside takeover indicators in a revision diff.
- Repository model 0.2.

### Changed

| What | Before | Now | Why |
| ---- | ------ | --- | --- |
| `methodology.config_digest` | included the pinned ref | excludes it, includes the release and targeted-tree switches | Two revisions of one repository can be compared; the ref is in `subject.ref`. |
| `enterprise` profile blocks | 3 | 4 (adds `require-checksums`) | `require:` compiles into a block; unknown does not block. |
| Release list byte cap | 2 MB | 8 MB | Projects with many assets lost their release evidence. |
| `schema_version`, package | `0.4`, `0.4.0` | `0.5`, `0.5.0` | New report sections. |

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
## 0.7 -> 0.8 (report schema 0.8, methodology 0.4)

Dependency registry packages now carry bounded per-version attestation states and the dependency budget records attestation limits. Existing reports must be re-run; scoring and shipped profiles are unchanged.
