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
