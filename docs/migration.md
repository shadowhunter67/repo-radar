## 0.11.0

Report schema 0.11 adds bounded dependency-introduction and artifact-delta sections, plus new timeline event types. Reports from schema 0.10 remain readable by comparison tooling but are not schema-valid 0.11 reports; re-run analysis to produce the new contract. Incident calibration results now also record `incident_model_version`.

Methodology remains 0.4: no score rule, weight, threshold, or score input changed.

## 0.10.0

Report schema 0.10 adds `analysis_manifest`, which records replay metadata, feature flags, collector versions, external-source classifications, trust-root IDs, budgets, and coverage. Reports from schema 0.9 are not schema-valid 0.10 reports; re-run analysis to produce the manifest.

The current rule set contains 86 rules in total; methodology remains 0.4.
## 0.12.0

Report schema 0.12 adds artifact executable/native/repository metadata and explicit behavioral delta components. Re-run analyses to produce schema 0.12 reports; methodology remains 0.4.

## 0.13.0

Dependency history is now a per-path bounded scan with transition events. Re-run analyses to produce schema 0.13 reports; incomplete history is explicitly partial/unknown. Methodology remains 0.4.

## 0.14.0

Dependency history transitions are computed against commit parents; new event kinds include `introduced_again_other_line`, and manifest creation is explicitly uncertain. Re-run analyses to produce schema 0.14 reports; methodology remains 0.4.
## 0.15.0

Dependency-history reports add `history_rate_limited`, per-entry diagnostics, unknown-revision counts, and request-class statistics. Re-run analyses; unavailable API data is no longer interpreted as empty history.
## 0.16.0

Report schema 0.16 adds `present_at_window_start` to dependency introductions. A
dependency present at the scanned window base has no claimed introduction commit or
event. Re-run analyses to produce schema 0.16 reports; methodology remains 0.4.

## 0.17.0

No report schema change (still 0.16) and no methodology change (still 0.4); existing reports and consumers keep working. The
new Web Analyzer exposes an HTTP API under `/api/v1`; "v1" versions that API only. The version-consistency check now allows
the package minor to be ahead of the report schema version.

## 0.18.0

No report schema change (still 0.16) and no methodology change (still 0.4). `integrity` gains an optional `format` field
(`canonical-json@1`); consumers that only read `report_sha256` are unaffected, but the digest is now computed over canonical
(key-sorted) JSON, so a digest of a 0.18 report cannot be recomputed with plain `JSON.stringify`. Reports without `format` keep the
legacy rule and still verify. Analysis results for the same input may differ in the order of `diagnostics`, scanned files and
`external_domains` observations compared with 0.17 (they are now sorted). Web API: new routes `/api/v1/metrics` and extra fields on
`/api/v1/ready`; new error codes `SERVICE_RATE_LIMITED` and `SHUTTING_DOWN`; job objects may carry `resolved_sha`, `cached`,
`coalesced` and `partial_reasons`.
