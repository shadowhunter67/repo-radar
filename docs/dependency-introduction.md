# Dependency introduction and delta intelligence

The report records bounded, descriptive answers to when and through whom a dependency entered the analyzed revision. Direct dependencies come from the parsed manifest; transitive dependencies use the shortest known parent chain, capped by the introduction limits. `introduced_in_revision` is present only when an actually fetched history comparison proves first appearance. Otherwise the state is `unknown`.

Registry ages are current-state or retrieved-snapshot observations, not historical proof. `young_package_present` uses the documented 30-day threshold; release age and `introduced_before_first_publish_days` are numbers, not verdicts. Parent provenance is `verified`, `reported`, `none`, or `unknown` for the observed chain and is never inherited by a child.

Behavior and trust-boundary deltas compare two inspected versions of the same package only when both digests were verified. They cover observed install-hook capabilities and newly observed install/build domains, with file-and-line evidence. Unsupported file-level execution, native binary, `bin`, repository-host, and publisher-organization comparisons remain `not_available`; one-version reports emit no delta.

Use **observed** for collected facts, **reported** for registry claims, and **unknown** when coverage or verification is unavailable. These sections are risk indicators; they do not establish intent, safety, or compromise.
## Commit history

API failure semantics: a rate limit (403/429 with rate-limit signals) yields `history_rate_limited`; other listing
failures yield `history_unavailable`. A first-page empty 200 is `path_not_found_at_ref`, not a complete scan. Blob,
parent, and commit-detail failures suppress transitions and produce `history_partial` with `unknown_revisions`.
For a listed commit with a known parent SHA, a contents 404 whose message is exactly `Not Found` means the manifest
path is absent at that parent (`path_absent_at_parent`), so dependencies present in the creating commit may be
introduced there. Ref-not-found 404 responses and all other failures remain unknown.
GitHub's path-filtered commits endpoint is not equivalent to `git log --full-history`: side branches and renamed
paths may be omitted. Transitions are claimed only from commits and parent contents actually fetched.

Dependency introduction history is an opt-in, bounded collector. It uses only the central GitHub HTTP client and
path-filtered commit/content responses; it never uses current registry data to infer a historical commit. A result is
`history_complete`, `history_partial`, `history_budget_exhausted`, or `history_unavailable`, and unresolved results stay
unknown. The report records the exact commit SHA, timestamp, evidence path and separate commit author and committer
when GitHub supplies them. The wording is deliberately: “introduction observed in commit `<sha>`; commit author X;
committer Y; responsibility: not determined”.

The collector is bounded by candidate, commit, request, elapsed-time, changed-file and byte limits. It currently
supports presence checks in npm manifests and generic lock/manifest text. It does not claim Go MVS build-list
semantics, follow renames unless the API exposes them, or promise immutable history after a force-push. Merge commits
are flagged; first-parent and squash-like granularity remain explicit limitations. A partial or shallow history never
becomes a negative finding.
Revision reports may include timestamped `dependency_introduced` events. Artifact behavior deltas remain separate and are
only strong when both same-package artifacts have verified digests; missing, invalid, or skipped artifacts are unavailable.
## 0.14 canonical transition definition

Presence is compared per listed commit with its first-parent file content, never with the previous API list entry. Commits are ordered by committer date then SHA. Merge commits are TREESAME-skipped when the result equals any parent; a retained merge transition requires absence in all parents and presence at the merge, or the reverse. A later branch-line introduction without removal is `introduced_again_other_line`.

Newest-only truncation is `history_partial`; a transition whose oldest parent is already present is `introduced_within_window` and uncertain. An added manifest without confirmed rename evidence is `introduced_with_manifest_creation` and uncertain. Renames require commit-detail `previous_filename` evidence.

Independent validation covered 10 pinned repositories and 80 dependencies. The pre-fix result was 51 exact / 26 incorrect / 3 unknown introduction commits and 38 exact / 42 incorrect event sequences; manifest paths were 80/80. These figures are reviewer evidence, not a holdout accuracy claim.

## 0.13 history engine

History is scanned per manifest or lockfile path. One bounded commits-page walk is shared by every candidate on that path; each fetched revision is parsed once and the resulting presence sequence is evaluated oldest-to-newest. The engine never assumes monotonic presence: removal, reintroduction, specification/version changes, and lockfile parent changes remain separate timestamped events.

An incomplete window is `history_partial` (or `history_budget_exhausted`) and records its oldest scanned SHA; an introduction found only in that window is `introduced_within_window` and `introduction_commit_uncertain`. Unparseable revisions are unknown, not absent. First-parent semantics are used for merge interpretation; commit author and committer remain separate observations and never imply responsibility.

Manifest parsers are used for package.json workspaces and all supported ecosystem manifests; lockfiles are parsed through `src/deps/lock.ts` so transitive observations retain possible parent chains rather than claiming that the project selected a child. Renames are followed only when a GitHub commit detail explicitly reports `previous_filename`; otherwise a new manifest is marked uncertain. Parsed presence cache keys include repository, commit, path, blob SHA, and `HISTORY_PARSER_VERSION`.

### Window and cost policy

If the dependency is present in the parent of the oldest scanned commit, the result is `present_at_window_start` with an unknown introduction; no introduction event or `INTRODUCED_AT` edge is emitted. `introduced_within_window` is reserved for an observed 0-to-1 transition inside the scanned window. History is opt-in or policy-triggered by design. A long manifest history costs roughly one request per listed commit plus one request for each parent not already cached; default budgets are far below the largest observed histories, so enabled runs are intentionally partial rather than unbounded.
