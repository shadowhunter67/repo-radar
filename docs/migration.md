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
