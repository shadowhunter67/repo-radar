# Scoring bias

Every scoring system encodes a point of view. These are the biases we know about in methodology 0.1, what the current
rules do about them, and what they do not.

| Bias | How it shows up | Current mitigation | Remaining gap |
| ---- | --------------- | ------------------ | ------------- |
| **Small vs large projects** | File-count ratios (tests/source), contributor counts and CI presence favour big projects. Small tools can never reach 20 contributors. | Breadth rules have small weights and share one budget (`community.*` group `breadth`). | Test ratio and contributor thresholds are not size-normalized. |
| **Solo maintainer vs foundation-backed** | No second reviewer means no code-review score, one contributor means bus factor 1, no CoC/templates. | `security.code-review` is `not_applicable` for single-contributor repos, so it is not scored as zero. Bus factor is reported openly as continuity risk, with a warning, not hidden. `startup` profile down-weights governance rules. | A solo maintainer still scores lower on Community and Maintenance by design. That is a continuity signal, not a judgement of quality. |
| **New vs mature** | `maintenance.history-depth`, release recency/cadence and Scorecard history favour old projects; new projects have thin evidence. | Thin evidence lowers *confidence* and widens the score range rather than silently scoring low. | Young projects with real quality still score lower on history-based rules. |
| **Library vs application** | Lockfiles are expected of applications, not libraries. Deployment docs matter for services, not libraries. Dependency count is not comparable. | Lockfile weight is moderate with a documented limitation; config/deploy docs and dependency count are informational. | No automatic library/application distinction yet (identity interfaces could drive `applies_when`). |
| **Research prototype vs production** | Prototypes lack CI, tests and governance by intent. | Profiles: use `default` for context. | No "research" profile. |
| **Company-owned vs community OSS** | Company projects often have few external contributors but strong internal process invisible from the outside (private CI, internal review). | None beyond confidence reporting. | Internal process is invisible to a read-only public-data tool. |
| **Ecosystem differences** | Test detection by path/name conventions fits JS/Python/Go better than Rust (inline unit tests) or Java layouts. Lint/type detection knows a fixed list of tools. `go.sum`, `Cargo.lock`, `package-lock.json` are recognised, other ecosystems less so. OSV only checks npm, PyPI, Go and crates.io with exact versions. | Absence of a lint/type/test file has a soft (not zero) score; heuristic evidence has lower confidence. | Needs per-ecosystem rule packs. |
| **GitHub-centric** | Only GitHub Actions workflows count as CI; other CI systems are invisible. Projects hosted elsewhere and mirrored to GitHub look abandoned. | `code-quality.ci-present` states this limitation. | No CircleCI/Jenkins/GitLab detection. |
| **Activity is not quality** | Stable, finished libraries look inactive. | Activity rules are one correlated group; `release-cadence` is informational. | Quiet-but-fine projects still lose some Maintenance points. |
| **Gaming** | Description, topics and README headings are cheap to write; a repository can keyword-stuff to raise identity/clarity scores, add empty test files, or pin actions without otherwise caring. | Popularity (stars/forks) is never used. Heuristic evidence has capped confidence. Rules measure process indicators from several independent sources (API, tree, Scorecard, OSV). | A determined author can still satisfy every checkbox. Rules are indicators, not proof. |

## Correlated signals

- Within a dimension, correlated signals share a `group` budget (for example a local check and its Scorecard twin).
- Across dimensions, each fact is assigned to one dimension: issue/PR responsiveness is scored only in Maintenance; vulnerabilities
  only in Security; signing only in Supply Chain; the "has releases" fact feeds `documentation.changelog` and is informational in Maintenance.
- The remaining known overlap: bus factor (Maintenance, scored) and contributor count/authors (Community, scored with small weights)
  both derive from contributor data. They measure different things (concentration vs breadth) but are not independent.

"More contributors" is never treated as unconditionally better: the breadth rules have weight 2+2 (shared budget of 2) in a dimension
that the `default` profile weights equally with the others and the `startup`/`enterprise` profiles at 0.5.
