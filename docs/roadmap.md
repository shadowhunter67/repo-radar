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


## After 0.5

Done: Identity v2 representation, targeted retrieval and coverage map, historical comparison, release / provenance / governance foundations, `require` and `history_block` policy. Next: (1) human review of labels (gate 14) and a second reviewer on the identity holdout; (2) better Identity v2 structure rules for frameworks, C / Rust CLIs with libraries and services without manifests, measured on a NEW holdout; (3) registry publisher data (npm, PyPI, crates.io) for `PUBLISHED_BY` and package-publisher change signals; (4) verification of Sigstore bundles and tag signatures with a pinned trust root; (5) deeper retrieval for kubernetes-sized trees; (6) a persistent snapshot store for history over many tags.


## After 0.6

Done: structural Identity v2 with an evidence hierarchy, multi-pass retrieval with hints, registry intelligence (npm, PyPI, crates.io), Sigstore verification of GitHub attestations, source binding, bounded asset checks, unified timeline with generic correlation, immutable snapshots, trust graph, new policy requirements. Next, in order of value: (1) human review of labels (gate 14) and a second reviewer for the identity holdouts; (2) verification of Sigstore blob bundles, minisign/GPG with pinned keys, and local tag-signature verification; (3) registry coverage for DEPENDENCIES (publisher change of a dependency is the classic attack path) with a request budget; (4) a manifest selection that follows hinted directories deeper than three segments (kubernetes); (5) external-domain extraction so `external_domain_introduced` and `CONNECTS_TO` become real; (6) calibration of identity confidence on a larger independent set; (7) a remote snapshot store with concurrent-writer rules.


## After 0.7

Done: dependency registry and publisher intelligence with a priority model and budget; Sigstore blob and large-bundle verification; OpenPGP, minisign and local tag verification against user-held trust; external domains with context; dependency and provenance events in the timeline and diff; trust graph enrichment, queries and snapshot projection; retrieval v3 (declared paths, manifest seeking). Next, in order of value:

1. Human review of the calibration labels (gate 14) and a second reviewer for the identity holdouts - still MANUAL.
2. GitHub's own Sigstore instance as a trust root (its release attestations are `verification_failed` today) and verification of npm / PyPI dependency attestations (the registries only report them).
3. Calibrate the dependency-event thresholds (dormancy, cadence, new publisher) on a labeled set of real incidents and benign hand-overs; today they are plausible defaults, not measured.
4. A benign-vs-takeover labeled history set for domains and dependencies, so false-positive rates are measured rather than listed.
5. A remote snapshot store with a concurrent-writer protocol, built on the `SnapshotStore` seam and `copySnapshots`.
6. Bazel / Nix / Buck declared-path readers for retrieval, and cheaper per-request costs for the largest repositories.
7. Reading README / docs for domains (documentation context is empty today because those files are not fetched).
