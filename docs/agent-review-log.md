# Agent review log

A lightweight engineering decision trail of independent reviews by Codex (via the `openai-bridge` MCP tool, `codex exec`), with the
lead agent's (Claude's) decision on each point. Reviews are summarized, not transcribed. Codex was used as a peer, not as an authority:
every finding was checked against the code before acting. Two of the reviews (A and B) returned generic text without citing files;
those are marked, and the substantive analysis in B was done by the lead agent.

---

## Review A: architecture
Area: overall architecture draft (docs/architecture.md, first version)
Reviewer: Codex (generic, no file citations)

Finding: "Stateless" will not scale: add caching, dedupe, rate-limit coordination.
Decision: Rejected for v0.1, kept on the roadmap (P0 for v0.2).
Reason: The MVP is a point-in-time CLI; caching has no value before bulk scanning exists. An interface will be added when it is needed.

Finding: Evidence needs richer provenance (ref/commit, request scope, freshness).
Decision: Accepted.
Implementation: Evidence carries `provenance.{url, ref, http_status}`; reports record the commit `ref` read; Scorecard freshness lowers confidence.

Finding: Confidence from evidence count/coverage can mislead; separate coverage from confidence and gate low-coverage scores.
Decision: Accepted.
Implementation: Dimension results expose `coverage`, `evidence_quality`, `confidence`, `sufficiency` (`insufficient` => grade `N/A`).

Finding: Single-evidence rules are too narrow.
Decision: Partially accepted.
Implementation: `evidence: [...]` with `combine: first|min|max|mean`. Arbitrary predicates/trends deferred (roadmap P2): they would turn the rule DSL into a programming language.

Finding: Identity could dominate downstream scoring.
Decision: Accepted.
Implementation: identity influences exactly one scored rule (`semantic-clarity.detected-purpose`); a test asserts no scored rule reads name divergence.

---

## Review B: evidence and scoring model
Area: src/scoring/engine.ts, standards/, collector evidence
Reviewer: Codex (generic again; did not cite file:line and claimed docs were missing that had not been written yet)

Finding (generic): distinguish unavailable / forbidden / absent / not-applicable evidence; make results interval-aware; correlation groups are blunt.
Decision: Accepted in substance; the specifics came from the lead agent's own audit of the engine:
- Bug found: coverage counted both members of a correlation group, so losing a Scorecard "twin" lowered confidence although the fact was already observed. Fixed: a group counts once at its heaviest member.
- `missing_reason` (`unavailable | not_collected | not_reported`) added; collectors attach `affects` prefixes to failure diagnostics.
- `score_range` (pessimistic/optimistic bounds from unobserved rules) added and printed when wide.
- Cross-dimension double counting: `maintenance.has-releases` and `documentation.changelog` shared a fact; the former is now informational.
- Solo-maintainer bias: `security.code-review` is `not_applicable` for single-contributor repositories.
- False negative: community/security health files inherited from the owner's `.github` repo were reported missing. Fixed with the community profile endpoint and an org-level SECURITY.md lookup (recorded as inherited).
Reason: These are concrete, testable defects/biases; each has a regression test.

Finding: Calibrate against labelled repositories; "source reliability" is hand-authored.
Decision: Acknowledged, not done.
Reason: No labelled dataset exists yet. Documented in limitations; roadmap P0.

---

## Review C: security
Area: all of src/ (read by Codex, file:line citations verified by the lead agent)
Reviewer: Codex

Finding: Response size cap bypassed when `res.body` is null (`readCapped`, src/util/http.ts).
Decision: Accepted (low in practice, trivial to fix).
Implementation: byte length of `text()` is checked against the cap; test with a stream-less Response.

Finding: `--output` can overwrite arbitrary files.
Decision: Rejected.
Reason: The path is supplied by the invoking user (equivalent to a shell redirect), not by repository data. Listed under "deliberate non-controls" in docs/security-model.md.

Finding: Secret redaction is pattern-dependent.
Decision: Accepted.
Implementation: the HTTP client also scrubs the exact token value from network error messages; test uses a non-GitHub-shaped token.

Observed controls Codex confirmed: https-only host allowlist with redirect validation, token scoped to api.github.com, repo-ref validation, terminal sanitization.

---

## Review D: test gaps
Area: src/ and tests/ (file:line citations verified)
Reviewer: Codex

Accepted and fixed, each with tests (tests/unit/regressions.test.ts):
- An unparsable commit `Link` header produced `commits.total = 1`: now no evidence plus a diagnostic.
- `has_tests = true` on a truncated tree was given reduced confidence: presence is now certain, absence uncertain.
- `permissions: write-all` counted as an explicit least-privilege declaration: it no longer does.
- `pull_request_target` checkout detection missed `refs/pull/*/merge` and a `repository:` pointing at the fork: both detected.
- OSV responses with `null` entries could throw; now tolerated (mismatched result counts are discarded entirely).
- Invalid or future Scorecard dates mapped to "very stale"; now neutral confidence.
- Rule-direction regression tests: every "higher is worse" threshold table is checked to be monotonic in the right direction.
- Bus factor with bots / zero contributions, release drafts and missing dates, inherited community files, org SECURITY.md.

Not done (recorded as limitations):
- Recent-commits page empty while total is large (API inconsistency): not realistic to guard against.
- Negation in identity text ("not a database"): the keyword heuristic cannot handle it; documented.

---

## Review E: final release audit
Area: whole repository
Reviewer: Codex (two attempts; both short, neither followed the requested requirement-by-requirement structure)

Finding: `parseRepoRef` accepted `https://github.com/org/repo/anything` and analyzed `org/repo`.
Decision: Accepted (low).
Implementation: only a bare repository URL or a known repository sub-page (`tree`, `blob`, `issues`, `pull`, `releases`, ...) is accepted; tests added.

Finding: tests, build and bundle could not be executed inside Codex's sandbox (not an assertion failure).
Decision: Noted. The lead agent ran them (301 tests passing, typecheck/lint/format clean, build and bundle OK, see the final report). Codex's "conditionally approve pending a CI run" is accurate for the one thing nobody has run: the GitHub workflow (`ci.yml`, `action.yml` via `uses: ./`) has never executed on GitHub.

Not found by Codex but found by the lead agent while verifying the security-model claims: a **quadratic ReDoS** in the CI test-command regex (`mvn ` x 100,000 in a single `run:` line took ~26 s, a denial-of-service vector from a hostile workflow). Codex's security review (C) had been explicitly asked to look for ReDoS and did not report it. Fixed (bounded look-ahead, 20,000-character scan window, bounded identity text) with regression tests. Lesson recorded: independent review does not replace adversarial tests written by the author; claims in the security model must each be backed by a test.

---

# 0.2 reviews (static analysis subsystem)

Codex was asked to read files and cite file:line (the format that worked for reviews C and D). Both calls were verified by the lead
agent before acting.

## Review F: security of the new static-analysis code
Area: src/analysis/*, src/facts, scan-file fetching
Reviewer: Codex (read the files, cited lines)

Finding: "High: ordinary network-client code can be misreported as a download-and-execute chain" (`fetch(url); chmod +x file; ./file`
produces `download-chmod-exec`, because generic network-client detections are used as download anchors).
Decision: Rejected as stated; derived improvement accepted.
Reason: Reproduced the exact input with a probe: no chain is produced, because the `chmod +x` detector only applies to shell-like file
kinds, so a literal `chmod +x` line in a JavaScript file never completes a chain. The probe did reveal the opposite, real problem:
`fetch -> fs.chmodSync -> execSync` and `urlopen -> os.chmod -> os.system` were NOT detected (false negatives).
Implementation: language-API chmod detectors for JS, Python, Go and Rust (`js.chmod`, `py.chmod`, ...) feed the same chain logic;
chains from generic network anchors still need both a make-executable step and an execution step within 40 lines. Regression tests
in `tests/unit/chain-variants.test.ts` pin both directions (including Codex's exact scenario staying chain-free).

Not found by Codex (also asked for ReDoS probing of every regex): nothing further verified. The lead agent's own hostile-input tests
(2 MB lines, repeated `mvn `, `-a ` x 100k, quote floods) all finish under 2.5 s in total.

## Review G: test gaps of the new code
Area: tests vs implementation
Reviewer: Codex (read the files, cited lines; could not run tests in its sandbox)

Finding: when detections exceed the 300 cap, a capability found only beyond the cap is reported `observed` but its fact has no
detection id to trace back to (capability summary uses uncapped detections, facts use the capped list).
Decision: Accepted (verified in `src/analysis/index.ts` and `src/facts/index.ts`).
Implementation: when capping, the first three detections of every capability are kept before the rest are filled in file order;
test `capping keeps traceable detections for every observed capability`.

The lead agent added boundary tests of its own (absence-gating thresholds exactly at 20% and 3 files, rule thresholds of the new scored
rules, `notObservedConfidence` clamping) in `tests/unit/boundaries.test.ts`.

## Defects found by the lead agent against real repositories (not by reviewers)

Running the analyzer on public repositories found bugs that the unit tests had not (each now has a regression test):

- **Absence of evidence became a good score** (design flaw): a README-only repository gained Security points from "nothing found in 0 files". Fix: absence facts need >= 20% coverage and >= 3 code files.
- **flask classified as a monorepo** because of manifests under `examples/` and `tests/`.
- **execa (a library) classified as a CLI** because the domain hint said "command-line": structure now outranks the hint.
- **Unrelated steps stitched into one chain**: a download helper and a `chmod` hundreds of lines later in `nvm`'s installer.
- **Container-image constructs scored as host risks** (`sudo`, profile edits in a Dockerfile) and **manual install scripts treated like automatic install hooks**.
- **HTTP 5xx on a scan file was silently dropped.**
- A ReDoS in the CI test-command regex (from 0.1, found by the author, missed by review C).

Lesson (repeated): independent review is useful when it must cite code, but it did not find any of the defects above; real-repository
runs and adversarial author-written tests did.
