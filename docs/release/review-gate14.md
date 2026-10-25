# Gate 14 human review packet

Gate 14 remains MANUAL and this file records no review outcome. A reviewer should
sample 12 identity cases and 12 dependency-history cases from the documented corpus,
covering npm, Python, Cargo, Go, simple introductions, window-start presence,
removal/reintroduction, merges, workspaces, and renames. Review every v3 incident
label and benign control used in headline metrics, including ambiguous and
insufficient cases.

| Sample | Required evidence/location | Factual choice to record |
| --- | --- | --- |
| identity ×12 | recorded fixture report, `evidence_ids`, identity facts | observed label, confidence, coverage |
| npm introduction | `calibration/history-validation/ground-truth-raw.json` and report history entry | commit/path/relationship |
| Python introduction | same ground truth and `pyproject.toml` evidence | commit/path/relationship |
| Cargo workspace | serde/axum ground truth and workspace manifest | workspace scope and commit |
| Go introduction | cobra/gin ground truth and `go.mod` evidence | commit/path/relationship |
| window-start presence | report `present_at_window_start` and oldest SHA | introduction unknown |
| removal/reintroduction | ordered event list and evidence IDs | event sequence |
| merge | parent SHAs and TREESAME evidence | merge handling |
| rename | API rename evidence and old/new paths | confirmed or uncertain move |
| v3 incidents | `calibration/incidents-v3/cases.json`, pinned pair paths | factual label/mechanism |
| benign controls | v3 case registry/artifact evidence | benign/ambiguous/insufficient |
| ambiguous/insufficient | case notes and abstention reasons | abstain, never negative |

For each case record evidence paths/links, factual label choices, confidence, notes,
and analyzer prediction separately. Do not expose the analyzer prediction before the
factual judgment. Store reviewer 1 and reviewer 2 independently using the existing
`calibration/review-v2` schema. If only one real human is available, record that
fact rather than fabricating a second review.

Reviewer 1: ____________________  Reviewer 2: ____________________
Review status: NOT REVIEWED  Gate status: MANUAL
