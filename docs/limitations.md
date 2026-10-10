# Limitations

Plain statements of what repo-radar v0.1 cannot do or does badly.

## What a score means

- A score summarizes **indicators observed by specific rules**. It is not a security audit, a code review or a trust guarantee.
- A high Code Quality score means tests, lint configuration, typing and CI were _seen_. It does not measure the code.
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
- OSV: only exact versions are queried (lockfiles, `go.mod`, pinned `requirements.txt`). npm projects without a committed lockfile are
  **not checked**, which is reported as a diagnostic, not as "clean". OSV batch results carry no severity and no reachability, so
  "has an advisory" does not mean "exploitable". Result pagination (`next_page_token`) is not followed.
- deps.dev, OpenSSF Best Practices badge API, SLSA verification, signature verification, SBOM parsing, license compatibility and
  secret scanning are **not** implemented. "Secret exposure indicators" are not covered.
- Package manifests: `package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml` (root and up to depth 2, at most 6 files).
  Workspaces/monorepos are sampled, not traversed.

## Identity

- The default classifier is a keyword/dependency/topic heuristic over a fixed taxonomy of ~30 types. Niche domains are
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

- No caching: each run re-fetches everything. Not suitable yet for scanning thousands of repositories.
- No historical tracking: reports are point-in-time.
- Reports are reproducible only if the repository and the external services have not changed; evidence carries `observed_at` and the commit `ref`.
- Rate limiting on optional endpoints produces a partial report with diagnostics rather than an error.
