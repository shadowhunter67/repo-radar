# Roadmap

Nothing below exists in v0.1 unless it is listed in the README. Order is rough priority.

## v0.2 (hardening the engine)

- **P0** Caching layer behind an interface (content-addressed by repo/ref/source/query) plus bounded concurrency and backoff; needed before any bulk scanning.
- **P0** Calibration set: a labelled benchmark of repositories (expert-rated) to test rule weights and the confidence model; publish the dataset and methodology.
- **P0** Resolve npm/PyPI version ranges (deps.dev) so repositories without lockfiles get a vulnerability check.
- **P1** Library vs application detection from identity interfaces, used by `applies_when` (lockfile, deployment docs).
- **P1** OpenSSF Best Practices badge API, deps.dev package signals, SBOM parsing, signature/attestation verification.
- **P1** Ecosystem rule packs (Rust inline tests, Java layouts, Python packaging) and non-GitHub CI detection.
- **P2** Multi-evidence rule predicates (conjunctions, trends) while keeping the DSL declarative.
- **P2** Org policy files, signed methodology bundles.

## Later

- Web index and public API over stored reports
- Repository search by purpose; semantic repository search over identity records
- Expert-maintained standards with per-namespace maintainers and review workflow (`standards/security/*` owned by security reviewers, etc.)
- Historical score tracking and trend evidence
- Provenance graph (dependency and build lineage)
- Package-ecosystem support beyond npm, PyPI, Go, crates.io
- LLM-assisted semantic classification behind `IdentityClassifier`, always reporting the classifier id and confidence
- Duplicate/clone detection and repository authenticity signals (forks passed off as originals, copied READMEs)
- Benchmark datasets and expert review layers
- Other forges (GitLab, Codeberg)

## Explicit non-goals for the MVP

Web dashboard, database, distributed services, executing repository code, or any claim of code authorship (human or AI).
