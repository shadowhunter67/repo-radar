# Changelog

All notable changes are documented here. Versioning: the CLI follows semver; the report schema and the scoring
methodology are versioned separately (`schema_version`, `methodology.version`) and are listed per release.

## [0.3.0] - unreleased

Report schema 0.3, methodology 0.3 (rules 84 -> 86 rules). Migration notes: [docs/migration.md](docs/migration.md). Design: [docs/dependencies.md](docs/dependencies.md).

### Added

- **Dependency intelligence** (`src/deps`): a normalized dependency model (structured package identity + purl, requested spec vs resolved version, relationship, direct/transitive, resolution state, vulnerability state, provenance), readers for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `uv.lock` and `go.sum`, and explicit specification kinds (exact, range, tag, branch, commit, workspace, path, url).
- **Vulnerability pipeline**: OSV is queried only for exact versions the repository evidences (lockfile > SBOM > manifest pin); every dependency ends in an explicit state (checked, unresolved_version, lookup_failed, ...); advisories keep their source, package, version, lookup URL and timestamp.
- **deps.dev** (optional, `--no-deps-dev`): licenses, advisory keys and provenance listing for exact versions, and "current registry candidate" for unresolved ranges (never used for vulnerability conclusions).
- **SBOM** (optional, `--no-sbom`): CycloneDX JSON 1.2-1.6 and SPDX JSON 2.2/2.3 ingestion with resource limits, comparison with manifests/lockfiles (consistent / partial / mismatch / unable_to_compare) and findings.
- Report section `dependency_intel`, text section "DEPENDENCY INTELLIGENCE", facts `deps.*`, finding categories `dependency` and `sbom`, two informational rules (`supply-chain.dependency-resolution`, `supply-chain.sbom-validated`).

### Changed

- `osv.coverage_ratio` now means the share of DIRECT registry dependencies that were vulnerability-checked (it used to count transitive lockfile packages and could read 100% with 10% of direct dependencies checked). When no vulnerability is found and that share is below 50%, `osv.vulnerable_ratio` is withheld and `security.known-vulnerabilities` is left unobserved (`insufficient_coverage`) instead of scoring 10/10. Score weights are unchanged.
- Lockfiles up to 5 MiB are read (was 512 KiB); up to 6 lockfiles; up to 10 manifests.

## [0.2.0] - unreleased

Report schema 0.2, methodology 0.2, taxonomy 0.2, detector pack 0.1, facts 0.1. Migration notes: [docs/migration.md](docs/migration.md).

### Added

- **Normalized facts** layer (`src/facts`) between evidence and rules; report sections `facts`, `code_analysis`, `findings`, `integrity`.
- **Static code analysis** ([docs/code-analysis.md](docs/code-analysis.md)): 14 capabilities with contexts and detection modes, install-time execution graph (npm lifecycle traced to local files), persistence and background-execution detection, download-and-execute chains, secret scanning with redaction, bounded file selection and explicit limits (`src/limits.ts`).
- **Identity layers**: artifact type (+ alternatives), domain, candidate alternatives, observed capabilities, deterministic purpose sentence.
- 7 rules (3 scored: hard-coded secrets, install-time download-and-execute, install hooks; 4 informational) -> 84 rules.
- CLI `--no-scan`; Action input `code-scan`; report `methodology` records taxonomy/detector/facts versions and a configuration digest; `integrity.report_sha256` tamper evidence.
- Tests: static-analysis unit tests, hostile-input/ReDoS cases, end-to-end installer-like and benign repository fixtures (416 tests in 18 files).

- **Calibration corpus v0** ([calibration/README.md](calibration/README.md)): 48 pinned repositories, label schema (tri-state yes/no/unknown/disputed), dev/validation/holdout splits, `scripts/calibrate.mjs` (holdout only with `--final`), metrics (precision/recall, abstention-aware accuracy, ECE/Brier). Labels are one AI-assisted review, not human review.
- CLI/library `--ref <sha|branch|tag>` pins files, tree and commits to a revision (validated; never an option injection).
- Release packaging for the Action (`npm run package:action`, `release-action.yml` dry-run by default; CI runs the Action on real repositories and checks the policy-gate exit code).
- Public release gates ([docs/release-gates.md](docs/release-gates.md)), machine-checked by `npm run release:gates`.

### Fixed (found by calibration, each with a regression test)

- A **private** npm package's lifecycle hooks no longer count as running for dependents; `setup.py` counts as an install hook only when the PEP 517 backend is setuptools or undeclared.
- A container `restart:` policy is no longer reported as host persistence; `$ `-prompt lines in help text are not code.
- A `.pem` named like a certificate is only a POSSIBLE secret file; scanner allow markers (`gitleaks:allow`...) demote a hit to POSSIBLE; test-server/e2e directories count as test locations.
- Workspace manifests: published-looking packages are fetched before examples/tools (cap raised 6 to 10); a publishable root that ships a CLI stays a CLI instead of "monorepo".

### Changed

- Dimension label **Code Quality -> Engineering Hygiene** (id `code-quality` unchanged): it measures process indicators, not code quality.
- `security.token-permissions` and `supply-chain.pinned-actions` read normalized facts (`ci.*`); results are identical.
- Chain detection requires steps within 40 lines; scripts a user starts by hand (install.sh, Makefile, Dockerfile) are `build` context, only automatic hooks are `install`; container-image-only constructs are downgraded; inferred chains are medium unless confidence is high. (All tuned against real repositories during development.)

### Fixed

- Absence of evidence no longer becomes a good score: "nothing found" facts need at least 20% source coverage and 3 code files, otherwise the rule is `not_observed` (`missing_reason: insufficient_coverage`). A README-only repository had gained 31 Security points from "nothing found in 0 files".
- Artifact classification no longer calls a repository a monorepo because of manifests under `examples/` or `tests/` (flask).
- `lint` detection from `package.json` dev dependencies; HTTP 5xx on scan-file fetches is reported instead of dropped.

## [0.1.0] - unreleased

First working MVP. Schema 0.1, methodology 0.1.

### Added

- `repo-radar analyze <owner/repo | url>` with `--format text|json`, `--profile`, `--output`, `--text-output`, `--min`, `--enforce-profile`, `--verbose`, `--ascii`, `--no-scorecard`, `--no-osv`; `profiles` and `rules` subcommands.
- Collectors: GitHub REST + raw files (metadata, tree, README, workflows, manifests, contributors, commits, releases, issues/PR samples, branch protection flag, community profile), OpenSSF Scorecard, OSV.
- Static manifest parsers: package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml and lockfiles.
- Semantic Identity engine (heuristic classifier behind `IdentityClassifier`, ~30-type taxonomy, Unicode-safe name normalization).
- Rules as YAML for 7 dimensions; evidence-traced scoring with coverage, confidence, score range and sufficiency; correlation group budgets.
- Profiles: default, startup, enterprise (weights + advisory minimums).
- Canonical JSON report with generated JSON Schemas; text report.
- GitHub Action (composite, bundled), CI, Dependabot, issue/PR templates.
- Documentation: architecture, methodology, evidence schema, bias, limitations, security model, roadmap, standards authoring.
