# repo-radar 0.17.0 — Experimental Preview (Web Analyzer MVP)

**This is an experimental preview, not a stable release.** There is no stable API or 1.0 guarantee. The report schema is
unchanged at 0.16 and the methodology at 0.4; the new HTTP API is "v1" of that API only and does not mean 1.0 of the product.

## What is new

- A **Web Analyzer**: a small server and static page that run the existing engine on a public GitHub repository and show the
  result: score, confidence and evidence coverage as separate values, the exact analyzed commit, findings with an evidence
  drawer, dependencies, releases and provenance, capabilities, governance, indicative compliance, technical details and a JSON
  download. See [docs/web-analyzer.md](../web-analyzer.md).
- Server controls: input validation, per-client rate limits, a bounded queue, worker threads with a memory cap and a hard
  timeout, in-memory jobs with a TTL, a strict Content-Security-Policy and other security headers, and no telemetry or
  accounts. See the Web Analyzer section of [docs/security-model.md](../security-model.md).
- A non-root `Dockerfile`, `.env.example` and [docs/deployment.md](../deployment.md).
- The report is identical in shape to the CLI's. No new detector, no scoring or methodology change, no schema change.
- The release workflow now takes its notes file from the package version and refuses a tag that does not match it.

## What it is not

- **No official hosted instance is deployed.** This release ships code and deployment documentation only. Run your own.
- Public repositories only. There is no private-repository authentication in the web version, no accounts, no permalinks and
  no stored results; history analysis is off.
- Not published to npm. The GitHub Action is not published.
- Not a safety guarantee. Output is a set of observed indicators; the page never calls a repository safe, and compliance
  content is indicative only.
- Calibration labels have not been independently human-reviewed (Gate 14 remains manual); the human decisions behind this
  preview are in [final-human-decisions.md](./final-human-decisions.md).

## Known limitations

- Jobs are lost on restart and cannot be shared between replicas.
- All users of an instance share one GitHub token budget; see [docs/deployment.md](../deployment.md).
- The Docker image was built and run once (Docker Desktop, Linux container): it runs as uid 1000 (`node`), `/api/v1/health` answered, one real analysis completed, the healthcheck reported healthy, and the token did not appear in the image history. This is a single local run, not a hardening review.
- Development-only advisories in `vitest`, `@vitest/mocker` and `tinypool` remain open pending a compatible major upgrade; they
  affect contributors running the test suite, not users of the runtime package.
- CLI parity was checked once by comparing a real web run and a real CLI run of `spf13/cobra` at the same commit: scores, findings, SHA and all sections were equal apart from timestamps and the order of `external_domains` observations. That ordering also differs between two CLI runs (an existing engine nondeterminism that changes `integrity.report_sha256`), so it is not a web difference; it is not fixed in this release. CLI flag defaults versus engine defaults are not covered by a unit test.
- Single-run timings through the web flow on one developer machine with a token (not benchmarks): is-plain-obj 7.1 s, cobra 8.1 s, flask 15.2 s (partial: scan budget reached), repo-radar 15.1 s (partial: scan budget reached and two registry lookups failed), nonexistent repository 1.0 s to `REPOSITORY_NOT_FOUND`, invalid input rejected with 400 immediately. Report sizes 125 KB to 700 KB.

## Verification

The tarball carries a GitHub build-provenance attestation: `gh attestation verify repo-radar-0.17.0.tgz --repo
shadowhunter67/repo-radar`. A CycloneDX SBOM, `SHA256SUMS` and release metadata are attached.
