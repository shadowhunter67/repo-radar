# Changelog

All notable changes are documented here. Versioning: the CLI follows semver; the report schema and the scoring
methodology are versioned separately (`schema_version`, `methodology.version`) and are listed per release.

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
