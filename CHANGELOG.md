# Changelog

All notable changes are documented here. Versioning: the CLI follows semver; the report schema and the scoring
methodology are versioned separately (`schema_version`, `methodology.version`) and are listed per release.

## [0.6.0] - unreleased

Report schema 0.6, methodology 0.4 (rules unchanged: 86 -> 86 rules; see [docs/methodology.md](docs/methodology.md) section 16 for why the methodology did not move). Migration notes: [docs/migration.md](docs/migration.md). Design: [identity](docs/identity.md), [retrieval](docs/retrieval.md), [registry](docs/registry.md), [trust](docs/trust.md), [governance](docs/governance.md), [snapshots and graph](docs/snapshots.md), [policy](docs/policy.md).

### Added

- **Identity v2 evidence hierarchy**: strong structural evidence (executable targets, server bootstrap, extension surface in a published package, container entrypoint of a program, native entry files) decides; weak evidence (bare Dockerfile, keyword hint) only breaks ties and is capped; status `clear | ambiguous | unknown`; a Dockerfile is a deployment form, not an identity; deployment `supported` forms. Metrics: overall/answered accuracy, top-2, packaging, interface precision/recall, deployment accuracy, ECE, abstentions.
- **Retrieval v2**: multi-pass walk (root, CI/build, hinted, source roots, breadth), static structural hints (workspaces, Cargo members, go.work, Gradle includes, Maven modules, CMake add_subdirectory, Makefile.am, meson, Kbuild), wide-directory handling, low-but-not-never ranking of docs/tests/vendor, budgets for requests/nodes/bytes/time/depth/hint reads, run-local reuse of parses by blob SHA.
- **Registry intelligence** (npm, PyPI, crates.io): package model, version/publisher history, repository correspondence (`confirmed | likely | conflicting | missing | unknown`), publisher/dormancy/cadence signals, findings, facts, `--no-registry`.
- **Cryptographic verification** (`--verify-crypto`, `--verify-assets`): trust-root vocabulary and states, Sigstore bundle verification through the maintained `sigstore` library, GitHub tag assertion kept separate from local verification, verified source binding, SLSA-related observations (never a level), bounded asset downloads with digest comparison, ELF/PE/Mach-O header metadata.
- **Timeline and temporal correlation**: unified events, built-in generic patterns, custom patterns as data, `temporal_block` policy.
- **Immutable snapshot store** (`--snapshot-dir`, `snapshots`), **Software Trust Graph** (`graph`), new `require` keys (`verified_provenance`, `verified_source_binding`, `registry_repository_match`, `publisher_stability`).
- Probes: `scripts/probe-registry.mjs`, `probe-trust.mjs`, `probe-retrieval.mjs` (v2); new identity holdout `calibration/identity-holdout-0.6` (run once).

### Changed

- A Cargo crate with `publish = false` is private (no install-time hook for dependents; not looked up in a registry).
- Signature/provenance states use the shared verification vocabulary (retired: `signature_present`, `signature_verified`, `signature_invalid`).
- `HttpClient` can return binary-safe bodies; the vitest default timeout is 20 s (retry back-off tests).
- Node >= 20.17 (required by `sigstore`).

### Fixed (found by real probes)

- A registry lookup for `fuzz/Cargo.toml` (ripgrep) matched an unrelated crate; PyPI responses above 4 MiB were rejected; old dormancy gaps produced signals; goreleaser bundles that the Sigstore root cannot time-stamp were reported `invalid` instead of `verification_failed`; the `config_digest` no longer includes the pinned ref (previous cycle).

## [0.5.0] - unreleased

Report schema 0.5, methodology 0.4 (rules unchanged: 86 -> 86 rules; scoring semantics are untouched, so the fresh holdout of methodology 0.4 stays valid). Migration notes: [docs/migration.md](docs/migration.md). Design: [docs/history.md](docs/history.md), [docs/releases.md](docs/releases.md).

### Added

- **Identity v2** (`identity_v2`): primary artifact, secondary roles, packaging structure, interfaces, deployment form, each with its own confidence and ranked alternatives, from structural evidence only (manifests, entry points, build files, layout, observed capabilities). A workspace is a packaging fact, never an identity. The flat `identity` is kept for compatibility. Confidence stays `heuristic_uncalibrated`.
- **Targeted tree retrieval** (`retrieval`): when GitHub truncates the recursive tree or the response is too large, a bounded, prioritised, breadth-first walk lists CI/build directories first, then package and source roots, under explicit request/node/byte/time/depth budgets (`stopped_by` says which one ended it). The result is never presented as complete. `--no-targeted-tree` disables it.
- **Coverage map** (`coverage_map`): per evidence class (manifest, lockfile, SBOM, CI, build config, source, documentation, release metadata) with state `complete | targeted | sampled | partial | none`; text section EVIDENCE COVERAGE.
- **Historical comparison**: `repo-radar diff <owner/repo> --from <ref> [--to <ref>]` analyzes two exact revisions sequentially (unchanged files are reused through a within-run blob cache), and `diff <old.json> <new.json>` now produces the same structured delta: identity, dependencies (added / removed / version / exact / unresolved / source / new vulnerability / resolved / git or path / unpinned), capabilities (new / removed / risk / context), execution paths, findings, policy, compliance indicators, governance, and an interpretable risk delta whose reasons are traceable. Comparability levels (`comparable | reduced | not_directly_comparable`) withhold numeric score deltas across different methodologies; removals in an incomplete tree are `inconclusive`.
- **Release intelligence** (`release_intel`, `--no-releases`): releases, assets (kind, digest, suspicious or duplicate names), checksum files (SHA-256/512 and weak MD5/SHA-1, BSD and GNU formats, bare per-asset digests, conflicts, traversal names), tag signature state as reported by GitHub, signature assets (present, never verified by repo-radar), GitHub artifact attestations parsed as in-toto/SLSA provenance (verification always `verification_unavailable`), and a source correspondence class. No binary is downloaded; only small checksum files from this repository's own release URLs.
- **Archive safety** (`src/release/archive.ts`): metadata-only inspection of zip/tar/tar.gz (zip slip, absolute paths, control characters, symlinks, duplicate entries, declared-size and ratio bombs, nested archives, entry-count and gunzip limits). Nothing is extracted or executed.
- **Governance** (`governance`): dormancy gaps, new committers and release authors after a gap, releases soon after resumed activity, release cadence, concentration; roles (contributor, committer, release author, package publisher, organization owner) kept apart; a sequence is reported as takeover risk *indicators*, intent undetermined.
- **Policy**: `require:` (`sbom`, `signed_release`, `provenance`, `checksums`; `true` or `strict`) compiles into blocks; `history_block:` rules over a revision diff (`new_vulnerability`, `new_install_hook`, `new_install_time_remote_execution`, `new_capability`, `new_git_or_path_dependency`, `takeover_indicators_with_new_install_hook`), enforced with `--enforce-profile` on `diff --from`.
- Facts `release.*` and `governance.*`; finding categories `release` and `governance`; repository model 0.2 with Release, ReleaseAsset, ArtifactDigest, Signature, ProvenanceRecord and Commit entities and trust-graph relations (RELEASES, TAGGED_AT, HAS_DIGEST, SIGNS, ATTESTS, BUILT_FROM, RELEASED).
- Human-review workflow: pseudonymous reviewer ids (e-mail rejected), review timestamp, label version, reviewed commit (must equal the pin), per-field and overall confidence, independence attestation, identity v2 opinions, several reviewers per repository, field status `agreed | disagreed | uncertain | needs_adjudication`, and calibration causes `model_wrong | label_ambiguous | reviewers_disagree`. Release gate 14 is still manual.
- New identity holdout `calibration/identity-holdout-0.5` (16 repositories, pinned), run once.

### Changed

- `methodology.config_digest` no longer contains the pinned ref (it is in `subject.ref`), so two revisions analyzed with the same options are comparable; it now covers the release and targeted-tree switches.
- Release list requests may be up to 8 MiB (large projects exceeded the previous cap and lost all release evidence).

## [0.4.0] - unreleased

Report schema 0.4, methodology 0.4 (rules unchanged: 86 -> 86 rules). Migration notes: [docs/migration.md](docs/migration.md). Compliance design: [docs/compliance.md](docs/compliance.md).

### Added

- **Shared conflict model** (`src/evidence/conflict.ts`): sources with quality (provenance, temporal, mutability), observations, explicit precedence (lockfile > SBOM > manifest pin for exact versions) and conflicts that state the preferred source and why. `dependency_intel.conflicts` uses it.
- **Execution model** (`src/analysis/exec-model.ts`): every hook/edge carries stage, trigger kind and environment; entrypoints are never "automatic"; build projects are listed.
- **Python build analysis**: build backends (including in-tree `backend-path`), `setup.py` only when setuptools really runs it, hatch/poetry/pdm build scripts, native builds (rust, meson, cmake, C extensions, cython, cffi), console/gui scripts and plugin entry points, Python import following.
- **JVM build analysis**: Maven and Gradle through a safe XML reader (DOCTYPE/ENTITY rejected), plugin catalog (exec, antrun, scripting, download, native, codegen, SCM), profile gating, Gradle config-time vs task execution, remote `apply from`, buildSrc, wrapper scripts, version catalogs, `gradle.lockfile`, Maven dependencies (pins with confidence 0.6).
- **Regulatory readiness** (`src/compliance`): three-valued applicability engine, versioned packs for the EU Cyber Resilience Act and EU AI Act (status `indicative`), privacy and AI technical indicators, report section `regulatory`, `--no-compliance`. Output is readiness/applicability, never a legal determination.
- **Policy blocks** in profiles (`block:` rules with `when` conditions and `on_unknown`), report fields `policy.blocks_evaluated` / `policy.block_violations`, exit code 2 under `--enforce-profile`; three blocks in the `enterprise` profile.
- **`repo-radar diff <old> <new>`** (dependencies, capabilities, hooks, vulnerabilities, persistence, SBOM, findings, governance, scores) and **`repo-radar model <report>`** (unified repository model with placeholders for releases and maintainers).
- Finding for non-ASCII (look-alike) dependency names.
- **Fresh holdout** `calibration/fresh-holdout-0.4`, blind-review workflow (`scripts/make-review-packets.mjs`, `scripts/compare-reviews.mjs`), dependency/SBOM label schema and metrics, `scripts/calibrate.mjs --corpus`, one-shot `--final` per (corpus, methodology).
- Adversarial and resource-limit tests (`tests/unit/adversarial.test.ts`).

### Changed

- `osv.vulnerable_ratio` is the observed-risk ratio (vulnerable / checked); completeness lowers the evidence confidence (`0.2 + 0.8 * coverage`) instead of the ratio. New fact `osv.eligible_packages`. The ratio is still withheld when nothing is vulnerable and direct coverage is below 50%.
- Identity confidence is labelled `confidence_semantics: heuristic_uncalibrated`; it is not rescaled (holdout ECE about 0.33).
- Lockfile applicability: a lockfile only covers manifests in its own directory, listed importers or workspaces; example/fixture manifests are `auxiliary` and no longer dilute coverage; pnpm multi-document lockfiles; Cargo nested locks only cover local names.
- Release gate 5 requires a fresh holdout result for the current methodology. Gate 14 (human label review) stays manual.
- Tree listing limit raised to 8 MiB; MAX_LOCKS 6, MAX_SBOMS 3.

### Security

- XML is parsed with a hand-written reader that forbids DTD and entities; regular expressions from standards packs are validated (`safeRegExp`) after a catastrophic-backtracking case was found; terminal output of names/specs is sanitized.

## [0.3.0] - unreleased

Report schema 0.3, methodology 0.3 (rules 84 -> 86 rules). Migration notes: [docs/migration.md](docs/migration.md). Design: [docs/dependencies.md](docs/dependencies.md).

### Added

- **Dependency intelligence** (`src/deps`): a normalized dependency model (structured package identity + purl, requested spec vs resolved version, relationship, direct/transitive, resolution state, vulnerability state, provenance), readers for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `uv.lock` and `go.sum`, and explicit specification kinds (exact, range, tag, branch, commit, workspace, path, url).
- **Vulnerability pipeline**: OSV is queried only for exact versions the repository evidences (lockfile > SBOM > manifest pin); every dependency ends in an explicit state (checked, unresolved_version, lookup_failed, ...); advisories keep their source, package, version, lookup URL and timestamp.
- **deps.dev** (optional, `--no-deps-dev`): licenses, advisory keys and provenance listing for exact versions, and "current registry candidate" for unresolved ranges (never used for vulnerability conclusions).
- **SBOM** (optional, `--no-sbom`): CycloneDX JSON 1.2-1.7 and SPDX JSON 2.2/2.3 ingestion with resource limits, comparison with manifests/lockfiles (consistent / partial / mismatch / unable_to_compare) and findings.
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
