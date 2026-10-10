# Evidence schema (version 0.1)

Evidence is the only input to scoring. The machine-readable definition is
[schemas/evidence.schema.json](../schemas/evidence.schema.json) (generated from the zod definition in
[src/evidence/types.ts](../src/evidence/types.ts)); the full report is [schemas/report.schema.json](../schemas/report.schema.json).

```json
{
  "id": "github.branch.default_protected",
  "value": true,
  "source": "github",
  "kind": "fact",
  "observed_at": "2026-10-10T12:00:00.000Z",
  "confidence": 0.9,
  "provenance": {
    "url": "https://api.github.com/repos/o/r/branches/main",
    "ref": "<commit sha the repository was read at>",
    "http_status": 200
  },
  "metadata": {}
}
```

| Field         | Meaning                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Stable, dotted, lowercase. `<namespace>.<name>`. Rules refer to it. Renaming an id is a schema change.                        |
| `value`       | boolean, number, string or string array. Never null: "not observed" is expressed by the absence of the evidence item.         |
| `source`      | `github`, `scorecard`, `osv`, `manifest`, `heuristic` or `identity`. Selects the reliability multiplier.                      |
| `kind`        | `fact`: read from an API or file. `heuristic`: inferred by a rule of thumb (pattern match, sampling).                          |
| `observed_at` | When the collector observed it.                                                                                               |
| `confidence`  | 0-1. How sure the collector is that `value` is right (sample size, truncated trees, stale Scorecard runs, partial coverage).  |
| `provenance`  | Where it came from: request URL, commit `ref` the files were read at, HTTP status.                                            |
| `metadata`    | Free-form context such as `capped`, `sample`, `truncated`, `detected_by` (inherited community files).                          |

Rules for collectors: absence of a file in a fully read tree is evidence (`false`); failure to fetch something is **not**
evidence (a diagnostic with `affects` is emitted instead, and rules depending on it report `missing_reason: "unavailable"`).
Evidence ids and diagnostics are deterministic for identical inputs; the report lists evidence sorted by id.

## Evidence ids in v0.1

`context` marks ids recorded for the audit trail but read by no scored rule.

| Namespace                    | Ids                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.repo.*`              | `archived`, `fork` (context), `default_branch` (context), `license_spdx`, `has_description`, `description_length`, `topic_count`, `language` (context), `age_days` (context), `days_since_push`, `stars` (context), `forks` (context), `size_kb` (context), `has_issues` (context) |
| `github.tree.*`              | `file_count` (context), `source_file_count` (context), `test_file_count` (context), `has_tests`, `test_to_source_ratio`                                                                                                                  |
| `github.file.*`              | `security_policy`, `code_of_conduct`, `contributing`, `changelog`, `license_file` (context), `codeowners`, `issue_templates`, `pr_template`, `dependency_updates`, `lockfile`, `dockerfile`, `sbom_file`, `lint_config`, `type_check_config`, `env_example`, `docs_dir`, `examples_dir`, `action_yml` (context), `makefile` (context), `deploy_config` |
| `github.workflows.*`         | `count`, `analyzed_count`, `external_action_count`, `pinned_actions_ratio`, `permissions_declared_ratio`, `pull_request_target` (context), `dangerous_checkout`, `expression_injection_risk`, `runs_tests`, `uses_sast`, `uses_provenance` |
| `github.branch.*`            | `default_protected`                                                                                                                                                                                                                      |
| `github.contributors.*`      | `count`, `top_share`, `bus_factor`                                                                                                                                                                                                       |
| `github.commits.*`           | `last_commit_age_days`, `recent_count_90d`, `distinct_authors_sampled`, `total`                                                                                                                                                          |
| `github.releases.*`          | `has_any`, `latest_age_days`, `median_gap_days`, `signed_assets`, `provenance_assets`, `sbom_assets`                                                                                                                                     |
| `github.issues.*`, `github.pulls.*` | `sample_size` (context), `median_days_to_close`, `stale_open_ratio`                                                                                                                                                               |
| `docs.readme.*`              | `present`, `length_chars`, `has_install`, `has_usage`, `has_config_docs`, `has_deploy_docs`, `code_block_count`, `purpose_statement`                                                                                                     |
| `manifest.*`                 | `ecosystems` (context), `dependency_count`, `file_count`, `has_description`                                                                                                                                                              |
| `heuristic.substance.*`      | `ci_without_tests`, `readme_heavy` (risk indicators; informational rules only)                                                                                                                                                            |
| `scorecard.*`                | `score` (context), `check.<slug>` for each conclusive Scorecard check (`branch_protection`, `dangerous_workflow`, `token_permissions`, `pinned_dependencies`, `security_policy`, `signed_releases`, `vulnerabilities`, `sast`, `code_review`, `maintained`, `binary_artifacts`, `cii_best_practices`, `fuzzing`, `ci_tests`, `dependency_update_tool`, ... ). A check score of -1 (inconclusive) is not recorded. |
| `osv.*`                      | `checked_packages`, `vulnerable_packages`, `vulnerable_ratio`, `vulnerability_ids`, `coverage_ratio`                                                                                                                                      |
| `identity.*`                 | `canonical_type` (context), `confidence`, `interfaces` (context), `name_purpose_divergence`, `name_normalization_lossy`                                                                                                                   |

### Sampling and caps

- Issues and pull requests: the 100 most recently updated items; medians use closed items only (needs at least 3), staleness uses open items (needs at least 3). Long-lived open items are under-represented.
- Contributors: top 100 (the API limit). Commits: latest 100 for recency/authors, `Link` header for the total.
- Releases: latest 30; cadence from the latest 10 gaps. Release assets: latest 5 releases.
- Tree: if GitHub truncates the tree, file _presence_ stays certain and file _absence_ drops to confidence 0.5.
- Files fetched: up to 20 workflows, 6 manifests, 4 lockfiles, each at most 512 KiB; OSV: at most 1000 exact-version packages.

## Diagnostics

`diagnostics[]` records what went wrong or was skipped: `{source, level, code, message, affects?}`. `affects` lists the
evidence-id prefixes that could not be collected, which is how the engine tells "unavailable" from "not reported".
Messages are redacted for tokens before they are emitted.
