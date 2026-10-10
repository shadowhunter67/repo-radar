# Changelog

All notable changes are documented here. Versioning: the CLI follows semver; the report schema and the scoring
methodology are versioned separately (`schema_version`, `methodology.version`) and are listed per release.

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
