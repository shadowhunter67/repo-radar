# Normalized facts (schema 0.4)

Facts are the layer rules should prefer over raw evidence ([methodology section 9](methodology.md)). Schema:
[`FactSchema`](../src/facts/index.ts); in the report they are `facts[]` with
`{id, value, confidence, scope, derived_from, derived_by}`. `derived_from` ids resolve to evidence ids or to ids inside
`code_analysis` (`CAP-*`, `CHAIN-*`, `HOOK-*`, `SEC-*`).

When the static scan is disabled, scan-derived facts are **absent** (not false) and the rules that read them report
`not_collected`.

| Family                | Ids |
| --------------------- | --- |
| `artifact.*`          | `type` (its confidence is the artifact classification confidence) |
| `ci.*`                | `permissions.declared_ratio`, `actions.pinned_ratio` (mirrors of the GitHub workflow evidence under CI-agnostic names) |
| `scan.*`              | `source_coverage`, `files_scanned` |
| `capability.<name>.*` | `observed` and `install_time` for each of the 14 capabilities, for example `capability.process_exec.observed` |
| `execution.*`         | `install_hooks.count`, `install_hooks.max_risk` (0 none, 1 low, 2 medium, 3 high; over hooks that run for dependents), `chain.any`, `chain.install_time` |
| `persistence.*`       | `observed`, `install_time`, `kinds` |
| `secret.*`            | `candidates.count` (high-precision DIRECT candidates outside tests and examples) |
| `privacy.<category>.observed` | personal-data-related technical indicators for email, ip_address, location, device_identifier, cookies, analytics, telemetry, credentials, camera, microphone, contacts, user_files: facts about the code, never a legal statement. "Not observed" is only emitted when the scan was broad enough. See [compliance.md](compliance.md). |
| `ai.<category>.observed` | AI/ML indicators for ml_framework, llm_client, model_weights, training, fine_tuning, inference, agent, dataset. |
| `deps.*`              | `discovered`, `direct_count`, `resolution.exact_ratio` (direct registry dependencies with an exact version of this revision), `vulnerability.checked_ratio`, `unresolved_count`, `conflicts.count`, `sbom.present` (a structurally valid CycloneDX/SPDX document was parsed), `sbom.comparison` (consistent / partial / mismatch). See [dependencies.md](dependencies.md). |

The confidence of a "not observed" fact is `0.3 + 0.5 x scan.source_coverage`; an observed fact carries the best detection
confidence. Planned fact families (not implemented yet): `repo.*`, `language.*`, `framework.*`, `build.*`, `dependency.*`,
`license.*`, `network.*`, `filesystem.*`, `credential.*`, `privacy.*`, `release.*`, `maintainer.*`, `governance.*`,
`supply_chain.*`. Migrating the older rules from raw evidence ids to facts is incremental and does not change their results.

## The `code_analysis` section and findings

`code_analysis` (see [code-analysis.md](code-analysis.md)) holds detections (`CAP-*`), chains (`CHAIN-*`), install/build
hooks (`HOOK-*`), the execution graph, the persistence summary, redacted secret candidates (`SEC-*`) and scan coverage and
limits. `findings[]` uses `{id, title, severity, confidence, dimension, category, evidence_ids, rule_ids, standards, summary,
remediation, intent}`; `intent` is always `"undetermined"` (capability is not intent).


## Release and governance facts (0.5)

| Fact | Meaning |
| ---- | ------- |
| `release.count`, `release.assets.count` | Non-draft releases listed; assets of the inspected release. |
| `release.tag.signature_verified` | GitHub verified the annotated tag signature. Emitted only when the tag could be resolved; a failed lookup leaves it unobserved, never `false`. |
| `release.signature_assets.present` | A signature file (.asc, .sig, .sigstore, .minisig, ...) is published next to assets. Presence only; nothing is verified. |
| `release.checksums.published` | A non-weak checksum file covers at least one asset. |
| `release.provenance.present` | An attestation is listed for an asset (even when its statement could not be read). |
| `release.provenance.consistent_with_tag` | An attestation for an asset digest names the tag commit (signature not verified). |
| `release.correspondence` | `attested_to_tag_commit`, `attestation_inconsistent`, `checksum_listed`, `tag_only` or `unlinked`. |
| `governance.takeover_indicators` | Dormancy, a new account and a release soon after were all observed in the sampled window. Intent undetermined. |
| `governance.signals.count` | Number of temporal signals. |

## Registry facts (0.6)

| Fact | Meaning |
| ---- | ------- |
| `registry.packages.count` | Packages this repository publishes that were looked up (npm, PyPI, crates.io). |
| `registry.lookup_complete` | Every lookup succeeded. When `false`, the facts below are `unknown`/withheld, never "clean". |
| `registry.repository_match` | Worst correspondence over all packages: `conflicting`, `unknown`, `missing`, `likely` or `confirmed`. A failed lookup is `unknown`. |
| `registry.provenance_reported` | npm only: every package reports a provenance attestation for its latest version (not verified here). |
| `registry.publisher_stable` | No recent version was published by an account new to the sampled history. Emitted only when all lookups worked; PyPI exposes no per-version publisher. |
| `registry.dormancy_then_publish` | A recent publication ended a gap of a year or more. |


## Release verification and governance facts (0.6)

| Fact | Meaning |
| ---- | ------- |
| `release.provenance.verified` | A release attestation was cryptographically verified (emitted only when `--verify-crypto` ran; otherwise unknown). |
| `release.source_binding_verified` | The correspondence class is `verified_source_binding` (same condition for emission). |
| `release.assets.checksum_verified` | Downloaded asset bytes matched their published digest and none mismatched (emitted only when `--verify-assets` ran and checked something). |
