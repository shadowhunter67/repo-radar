# Calibration dataset (scaffold only)

**Status: no labelled data exists yet.** This directory defines the format and rules for building the golden repository
dataset the scoring model needs. Weights, thresholds and the confidence model in methodology 0.2 are hand-authored
judgement and are **not calibrated**. Until labels exist, treat every number as uncalibrated.

## Goal

Measure, against human labels, where repo-radar is right and wrong, **without tuning it merely to reproduce subjective
preference**: precision/recall of identity and capability detection, false positives and negatives, confidence calibration
(does 80% confidence mean right 80% of the time?), score stability over time and profile bias.

## Target composition (200-500 repositories)

mature OSS, new projects, solo-maintainer projects, large organizations, libraries, CLI tools, web applications, services,
frameworks, security software, AI projects, archived repositories, known vulnerable projects, known supply-chain incident
repositories, intentionally vulnerable projects, minimal repositories, educational repositories, high-quality references.
Include ecosystems beyond npm/Python (Go, Rust, Java, C/C++, shell) to expose ecosystem bias.

## Rules for labels

1. **Labels live apart from the analyzer** (this directory), never in `src/` or `standards/`, and the analyzer must not read them.
2. Pin each repository to a **commit SHA** and record the labelling date; analysis is compared at that SHA.
3. At least **two independent reviewers** per repository where feasible. Store each reviewer's labels separately and record
   disagreement; do not collapse disagreement into a single "truth".
4. Labels describe observable facts a reviewer verified (artifact type, domain, which capabilities exist, whether install hooks
   exist) plus clearly marked ordinal judgements (security maturity, engineering hygiene, ...), each with a one-line justification.
5. Do not label intent. "Contains persistence code" is a label; "is malware" is not.
6. Publish the dataset and the evaluation script together; record the repo-radar version, methodology digest and config digest of each run.

## Format

One YAML file per repository in `labels/<owner>__<repo>.yaml`, validated by `label.schema.json` once the evaluator exists:

```yaml
repository: owner/repo
commit: 0123456789abcdef0123456789abcdef01234567
labelled_on: 2026-10-10
reviewers:
  - id: reviewer-a
    artifact_type: library # library | application | cli | service | framework | plugin | extension | sdk | ...
    domain: developer-tooling
    capabilities: [PROCESS_EXEC, ENVIRONMENT_READ] # verified by reading the code
    install_hooks: [] # npm hooks / setup.py / build.rs a reviewer found
    persistence: []
    hard_coded_secrets: false
    ordinal: # 1 (weak) .. 5 (strong), each justified
      security_maturity: { value: 4, why: 'branch protection, SECURITY.md, pinned CI' }
      engineering_hygiene: { value: 5, why: 'tests, lint, types, CI' }
      maintenance_maturity: { value: 4, why: 'monthly releases' }
      documentation_quality: { value: 4, why: 'README with usage and examples' }
      supply_chain_maturity: { value: 3, why: 'lockfile, no signed releases' }
    risk_class: low # low | medium | high (consequence if misused), not intent
    notes: ''
```

## Planned evaluation (not implemented)

`scripts/calibrate`: run the analyzer at the pinned SHA for each repository, then report per-field agreement with each reviewer and
inter-reviewer agreement, confusion matrices for artifact type and domain, per-capability precision/recall, reliability diagrams for
confidence, and rank correlation between dimension scores and ordinal labels split by repository cohort (size, age, solo vs team,
ecosystem) to expose bias. See [docs/roadmap.md](../docs/roadmap.md).
