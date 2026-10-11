# Roadmap

Nothing below exists in v0.1 unless it is listed in the README. Order is rough priority.

## Done in 0.2

- Normalized facts layer (`src/facts`), first rules migrated.
- Identity layers: artifact type, domain, alternatives, capabilities, purpose sentence.
- Static capability engine (14 capabilities), install-time execution graph for npm, persistence detection, download-and-execute chains, secret scanning (redacted).
- Findings with rule links; `Code Quality` dimension relabelled **Engineering Hygiene** (id unchanged); report integrity digest and versioned components.
- Explicit resource limits in one module.

Not done and still open from the 0.2 brief: GitHub Action/CI have not run on GitHub; no calibration dataset beyond a scaffold ([calibration/](../calibration/README.md));
no deps.dev, SBOM, dependency freshness, regulatory rule packs, sandbox, caching or database.

## Next (hardening the engine)

- **P0** Caching layer behind an interface (content-addressed by repo/ref/source/query) plus bounded concurrency and backoff; needed before any bulk scanning.
- **P0** Calibration set: a labelled benchmark of repositories (expert-rated) to test rule weights and the confidence model; publish the dataset and methodology.
- **P0** Resolve npm/PyPI version ranges (deps.dev) so repositories without lockfiles get a vulnerability check.
- **P1** Library vs application detection from identity interfaces, used by `applies_when` (lockfile, deployment docs).
- **P1** OpenSSF Best Practices badge API, deps.dev package signals, SBOM parsing, signature/attestation verification.
- **P1** Ecosystem rule packs (Rust inline tests, Java layouts, Python packaging) and non-GitHub CI detection.
- **P2** Multi-evidence rule predicates (conjunctions, trends) while keeping the DSL declarative.
- **P2** Org policy files, signed methodology bundles.

## Strategic direction (product brief, 2026-10)

Long-term product: an evidence-driven software intelligence engine covering identity, engineering process, dependencies,
capabilities, execution, supply chain and compliance readiness. Order of work:

- **P0 foundation / trust**: verify the Action and CI on real GitHub (open), clean release state (baseline committed locally, not pushed), facts layer (done, migrating), artifact classification (done), capability engine (done, line-oriented), npm execution graph (done), secret scanning (done), calibration dataset (scaffold only), Code Quality naming (done: label changed).
- **P1 deeper intelligence**: deps.dev and version-range resolution, dependency freshness, SBOM ingest/generation (SPDX, CycloneDX), ecosystem rule packs, complexity and maintainability metrics (a separate future dimension), non-GitHub CI detection, more execution ecosystems (Python build backends, Maven/Gradle, Composer, gemspec, CMake/configure), data-flow foundations, a unified repository model with entity/relationship types, an applicability engine driven by artifact type, versioned standard packs (`openssf-scorecard@x`, `slsa@1.2`, `nist-ssdf@1.1`, `spdx@3.0`).
- **P2 scale**: caching, persistent store, batch scanning, organization policy files, historical reports, API service, dashboard, report and methodology signing, other forges.
- **P3 advanced**: isolated dynamic sandbox, syscall/process-tree/filesystem/network telemetry, behavioral fingerprinting, trust graph.
- **Compliance readiness packs** (EU CRA, EU AI Act, GDPR/CCPA/LGPD/PDPA, Vietnam personal-data rules): technical indicators only, each result separating applicability confidence, technical evidence, observed controls, missing controls, unknown deployment context and legal determination (always "not provided"). Not started; requires the privacy-capability facts (`privacy.*`) first.

### Constraints for any future dynamic analysis

Never on the host. A disposable sandbox with no host filesystem, no host credentials, no cloud-metadata or private-range access,
resource and time quotas and recorded telemetry (process tree, filesystem changes, DNS/HTTP, syscalls, services and tasks created),
destroyed afterwards. Do not start before static capability and execution analysis is mature and calibrated.

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

## After 0.4

Done: dependency intelligence (0.3), Python and JVM execution models, regulatory readiness packs, policy blocks, report diff, repository model, fresh-holdout procedure. Next: historical analysis over commits and tags (using the repository model), release/binary and provenance analysis, human review of the fresh-holdout labels (gate 14), paging for very large trees, Go/.NET build analysis, legal review of the regulatory packs.
