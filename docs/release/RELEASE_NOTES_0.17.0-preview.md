# repo-radar 0.17.0 — Experimental Preview

repo-radar provides evidence-driven, static repository and software supply-chain
intelligence. It preserves observations, evidence, coverage, confidence, and
unknown states for human review.

## Included

Core static analysis, dependency normalization, release metadata, JSON reports,
diffs, snapshots, graph projections, and bounded policy evaluation. Experimental
features include dependency history, governance indicators, incident correlation,
trust-graph queries, and batch analysis.

## Limitations and security model

Repository and artifact code is never executed, installed, or built. Coverage is
bounded and can be partial. External APIs can fail or rate-limit. Registry state may
be current-state rather than historical truth. See [security-model](../security-model.md)
for SSRF, archive, token, snapshot, Unicode, and API-failure controls.

Calibration labels are AI-assisted and not independently human-reviewed. Gate 14 is
MANUAL. This preview makes no accuracy, safety, malware, compliance, or legal claim.
Methodology remains 0.4; scores are evidence-derived heuristics, not probabilities.
