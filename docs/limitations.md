# Limitations

Plain statements of what repo-radar v0.2 cannot do or does badly.

## What a score means

- A score summarizes **indicators observed by specific rules**. It is not a security audit, a code review or a trust guarantee.
- A high Engineering Hygiene score (dimension id `code-quality`) means tests, lint configuration, typing and CI were _seen_. It does not measure the code; no complexity, duplication, error-handling or design analysis exists yet.
- Confidence is a hand-authored model (source reliabilities, sampling penalties). It has **not** been calibrated against labelled
  repositories or expert ratings. Weights and thresholds are informed judgement, not empirical results.
- Overall numbers hide dimension differences; profiles encode preferences, not objective truth.

## Data coverage

- GitHub only. No GitLab, Bitbucket, or private repositories (a token with access may work for private repositories, but this is untested and not a goal).
- Unauthenticated use is limited to 60 GitHub API requests per hour; each analysis uses about 12 (raw file downloads from raw.githubusercontent.com are not counted against the API limit). Use `GITHUB_TOKEN`.
- Issues and PRs are a recency sample of 100, not the full history. Contributors are capped at 100.
- Branch protection is only the public boolean `protected` flag; rulesets and detailed settings need admin access (Scorecard's
  Branch-Protection check helps only when Scorecard has data).
- A SECURITY policy is also looked for in the owner's `.github` repository; other organization-level settings are not seen.
- Scorecard data is whatever the public API last published (often weeks old; stale data lowers confidence). Many repositories have none.
- OSV: only exact versions of the analyzed revision are queried (lockfile > SBOM > exact manifest pin; see [dependencies.md](dependencies.md)). npm projects without a committed lockfile are
  **not checked**, which is reported as a diagnostic, not as "clean". OSV batch results carry no severity and no reachability, so
  "has an advisory" does not mean "exploitable". Result pagination (`next_page_token`) is not followed (such packages are marked `partial`).
- Dependency intelligence (0.3): transitive dependencies are known only from lockfiles; Maven/Gradle, Pipfile.lock and bun are not read;
  Python ranges are never evaluated (only `==` pins are exact); a Go `go.mod` is the main module's requirement set, not a computed build list;
  deps.dev metadata covers at most 40 exact and 30 candidate lookups; SBOMs published only as release assets are not fetched; an SBOM
  comparison is evidence about SBOM/repository consistency, not about the SBOM's correctness. Every limit is a diagnostic when hit.
- OpenSSF Best Practices badge API, SLSA verification, signature verification, license compatibility and
  secret scanning are **not** implemented. "Secret exposure indicators" are not covered.
- Package manifests: `package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml` (root and up to depth 2, at most 6 files).
  Workspaces/monorepos are sampled, not traversed.

## Static code analysis (capabilities, execution, persistence, secrets)

Details in [code-analysis.md](code-analysis.md). In short:

- It reads a **bounded sample** (at most 40 files of 64 KiB) of each repository. Large repositories are only partly covered; the report gives the coverage and says which limits were hit. "Not observed" means "not found in the sample", with confidence scaled by coverage.
- Detection is **line-oriented pattern matching**: no AST, no data flow or taint tracking, no handling of obfuscation, encoding, string concatenation or dynamic `require`. A determined author can evade it; an innocent project can trigger it (test code, documentation helpers, installers).
- Only **npm lifecycle execution** is traced in depth. Python build backends, Maven/Gradle plugins, Composer scripts, gemspec extensions and CMake/configure logic are not resolved; `setup.py`, `build.rs`, `Dockerfile`, `Makefile` and manual install scripts are listed and scanned but not followed through every call.
- Hooks beyond manifests at depth 2 (or beyond the first 6 manifests) are not seen.
- Dependencies' code is not analyzed, nor are binaries and release assets.
- A capability is never evidence of intent; installers, agents and security tools legitimately trigger the highest-risk detections.
- Secret scanning covers only fetched files plus file names from the git tree; high-precision patterns miss unusual formats, and found credentials may already be revoked or sample values.
- Persistence/privilege constructs inside a `Dockerfile` apply to the image and are downgraded; this also means some real container-escape patterns are not reported.

## Identity

- The default classifier is a keyword/dependency/topic heuristic over a fixed taxonomy of ~30 types (taxonomy 0.2 adds a domain and an artifact-type hint per type). Artifact type (library, CLI, service, ...) comes from that hint and from observable structure, so it is as uncertain as the domain: it exposes `artifact_alternatives` and `alternatives` instead of hiding ambiguity. Real example: `nvm-sh/nvm` (a shell CLI) is reported with 20% confidence and a wrong "library" interface because the signals (a package.json, a Dockerfile) are misleading. Niche domains are
  `unclassified`; it can be wrong (it has no notion of negation, e.g. "not a database"), and keyword stuffing can steer it.
  Real example from development: `junegunn/fzf` first came out as "editor extension" (30% confidence) because the taxonomy
  lacked "command-line"; after adding it the result is "command-line utility" (65%). Confidence is the only protection users get.
- Identity feeds scoring in one rule only (`semantic-clarity.detected-purpose`).
- The name-vs-purpose divergence is a crude token overlap and is informational.

## Heuristics that can mislead

See [bias](bias.md). In addition:

- **Test detection** is path/name based. Unit tests inside source files (Rust, some Go layouts) and repositories whose tests live elsewhere look untested.
- **CI test detection** matches common commands in the first 20,000 characters of each `run:` script; custom scripts (`./ci.sh`) are invisible.
- **Lint/type detection** knows a fixed list of config files and `package.json` devDependencies.
- **Workflow checks** are static pattern matches: `pull_request_target` + PR-head checkout, untrusted event fields inside `run:`,
  unpinned actions. They flag candidates; they cannot prove or rule out exploitability. Reusable workflows are not resolved.
- **"Substance indicators"** (`ci_without_tests`, `readme_heavy`) are weak signals, informational, and also fire on honest early-stage projects.
  They say nothing about how the code was produced.
- **Bus factor** is computed from GitHub contributor commit counts; squash merges, co-authors and bots distort it.

## Operational

## Dependency artifact domains (0.9)

- Artifact domain extraction is opt-in, bounded, and static. It reads only selected registry artifacts after digest comparison; it never executes package hooks or contacts an observed domain.
- The current report records artifact-domain hostnames and the pure same-package version event builder is available for revision workflows. A single analysis cannot establish introduction/removal time, so it emits no temporal event for one artifact alone.
- Artifact candidates are currently taken from the dependency-registry versions selected by the existing registry budget; a separate artifact-specific priority expansion is not yet implemented. Skipped or unavailable candidates remain unknown and do not emit absence facts.

## Package-name intelligence (0.9)

- Comparisons are bounded heuristics over the repository dependency set, declared package names, and the checked-in popular-name seed. The seed is not a registry popularity feed and is intentionally incomplete.
- The comparator supports registry-normalized names and reports independent signals; it does not establish ownership or intent. Registry-history/deprecation suppression is available to callers supplying those metadata records, while the default repository pipeline does not yet hydrate every registry rename/deprecation relationship into candidate metadata.

## Build-system sources (0.9)

- Bazel, Nix, and Buck support is structural and bounded: macros, imports, dynamic string construction, and evaluation are counted or marked unparsed rather than resolved.
- Build-source facts describe declared remote inputs only. They do not prove that a build fetched or used a source, and a missing source is reported as unknown unless every discovered file was parsed within the limits.

- No caching: each run re-fetches everything. Not suitable yet for scanning thousands of repositories.
- No historical tracking: reports are point-in-time.
- Reports are reproducible only if the repository and the external services have not changed; evidence carries `observed_at` and the commit `ref`.
- Rate limiting on optional endpoints produces a partial report with diagnostics rather than an error.

## Python, JVM and large repositories (0.4)

- Python and JVM analysis is static and heuristic. Gradle build scripts (Groovy/Kotlin) are not evaluated: tasks, plugins and `apply from` are found by pattern with brace tracking, so dynamically computed tasks are missed. Maven profile activation is not evaluated; plugins in profiles get lower confidence. Gradle/Maven dependency versions that need property or BOM resolution stay `unresolved` (reported as `jvm_partial_resolution`).
- A custom in-tree Python backend that does not mention setuptools is not assumed to run `setup.py`; one that does is.
- Very large trees are blind: the tree listing is capped at 8 MiB, so repositories such as flink, ruff or django are analysed from partial or no file lists and say so.
- An entrypoint (console script, `bin`, plugin group) is not an automatic hook; it only runs when a user or a host invokes it.
- Dependency names are checked for non-ASCII look-alikes only; typosquatting by ASCII edit distance is not claimed.
- Regulatory output is readiness/applicability, not a legal verdict (see [compliance.md](compliance.md)).
- Fresh-holdout labels come from one AI-assisted reviewer; they are not human-verified.


## Identity v2, large repositories, history, releases (0.5)

- **Identity v2 is not yet more accurate than the legacy label** on an independent holdout (63% vs 67%, 16 repositories, single AI-assisted reviewer). Known failures: frameworks without a framework-specific manifest signal (fastify, gin) read as libraries; a C CLI with a Dockerfile (jq) reads as a container; C services without manifests (redis) are wrong; a CLI with a library API (bat) reads as a library; a root console script makes a framework read as a CLI (flask). Confidence values are not calibrated.
- **Targeted retrieval is bounded, not complete.** For flink-sized repositories the walk reads about 70 directories (breadth first, CI and build directories first) and reports the rest as unread; deep module trees (kubernetes, linux, nixpkgs) are still mostly unread and the coverage map says so. Absence in such a tree proves nothing.
- **Historical diff** compares two analyses: release assets, contributors and branch protection are current-state only; `setup.cfg` dependencies are not parsed; vulnerability severity is not available; removals in incomplete trees are inconclusive.
- **Release intelligence** does not verify any signature or attestation; large attestation bundles are listed but not read; only GitHub releases are covered; no binary is downloaded or analyzed.
- **Governance** uses a 100-commit window, 30 releases and the top 100 contributors; shared or renamed accounts, bots and organization changes are invisible; the takeover sequence is an indicator of a pattern that a legitimate hand-over also produces.


## 0.6 additions

- **Identity v2**: 67% overall / 75% when answered on a fresh 18-repository holdout (single AI-assisted reviewer); frameworks whose evidence is outside the scanned source sample, CLIs that contain a server helper, Go services whose only strong evidence is `package main`, and C projects without manifests are the known failure modes. Confidence is not calibrated (ECE 0.33).
- **Very large repositories** remain partially read: manifests deeper than three path segments are not selected (kubernetes staging modules), source coverage is a small sample, and nothing is claimed absent from an unread directory.
- **Registry**: only the packages this repository publishes; PyPI exposes no per-version publisher or maintainers; ownership history does not exist in any of the three registries; maintainers are current-state; npm provenance is "reported", not verified; crates.io and PyPI provenance are not read.
- **Cryptographic verification**: Sigstore public-good root only; blob bundles, GPG/minisign/SSH signatures, local tag signature verification, certificate revocation, GitHub's private-instance trust root and large non-inlined bundles are not covered. `--verify-crypto` needs network access to the Sigstore TUF repository.
- **Asset checks** download at most 3 assets (8 MiB each); everything else is "skipped for resource limit". Binary metadata is a header read, not analysis.
- Dependency artifact reports omit raw artifact URLs, including signed or temporary URLs; ZIP64 archives are reported as unsupported.
- **Timeline**: no external-domain events, no maintainer or ownership history; correlations are indicators over small samples.
- **Snapshots** are a local directory with an append-only index: no concurrent-writer protocol beyond atomic file creation, no remote store.

## 0.7 additions

- **Dependency registry**: a budgeted subset (25 packages by default, priority-ranked); the rest is `unknown`. PyPI has no publisher or maintainer history; maintainers at publish time and per-version repository/install-script data exist for npm only; crates.io shows per-version publishers but not owners at the time. The sample is the newest 20 versions. Registries only REPORT provenance; dependency attestations are not verified. Correspondence never checks that a repository links back to the package. Typosquatting by a new package name is not a publisher change. Events are history of metadata, not an analysis of the package contents (tarballs are never fetched).
- **Takeover indicators for dependencies** require a pattern on one package inside the sampled window: a compromised account of an existing publisher, a malicious transitive dependency that was not queried, and PyPI are invisible.
- **Cryptographic verification**: Sigstore public-good only (GitHub's own instance, hence GitHub release attestations, stays `verification_failed`); no revocation checking; OpenPGP and minisign only against keys YOU supply; SSH/S/MIME tag signatures and cosign key signatures are not verified; artifacts above 8 MiB (24 MiB total) are `verification_skipped_resource_limit`, so large release archives are usually not verified byte-for-byte - checksum files and signatures over them are.
- **External domains**: a reference in a file, not a connection; documentation and README are not fetched; hosts built at run time, container image references without a scheme and `s3://` buckets are not extracted; comment and docstring detection is line-based and does not model strings containing `//` or `/*`; categories are by name (no DNS, no reputation); domains of dependencies are not observed.
- **Retrieval v3**: still bounded and never complete for kubernetes/linux/nixpkgs-sized trees. Declared paths are only as good as the build file patterns (Bazel, Nix and Buck are not read). A large repository costs more requests and time than before (see [retrieval.md](retrieval.md)). Source-scan coverage ratios fall because the denominator (known source files) grows while the scan sample stays fixed.
- **Historical diff**: release data is current state, so provenance deltas need two reports made at different times; domain and capability removals are inconclusive on incomplete trees.
- **Trust graph**: references, not connections; no graph database; the projection is regenerated, never stored.
- `openpgp` is LGPL-3.0-or-later (used unmodified through its public API): review the licence fit with counsel before any public release.

## 0.9 batch foundation

- **Batch** is sequential and bounded at 25 repositories. Failures are isolated and aggregate counts are descriptive, not an organization score. Snapshot reuse uses the immutable local snapshot index for the requested repository; a separate preflight head-resolution request is not performed, so callers should refresh or clear the store when repository heads may have changed.
- **Artifact probe measurements** are one offline Windows run and are not stable performance guarantees; production digest verification requires registry metadata supplied by the collector.

## H5 audit boundary (2026-10-16)

The following H5 follow-ups remain explicitly unclaimed and require separate review work: memory-pressure assertions for every decompressor/import path; exhaustive timed ReDoS coverage for every Phase 0.9 regex; full batch budget/summary expansion; hostile snapshot-import corpus for duplicate/prototype/index cases; the Goreleaser GitHub-instance attestation end-to-end fixture; complete trust-root negative tests for every source type; dependency-attestation coverage counters; graph property tests and hostile graph-limit cases; exhaustive policy truth-table coverage; and the full Bazel/Nix/Buck comment/string/macro corpus. The current cycle added bounded PAX parsing, invalid-UTF-8/duplicate-key/traversal tests, and foreign-redirect rejection, but these do not constitute completion of the remaining items. No item is represented as verified solely because a fixture is absent.
