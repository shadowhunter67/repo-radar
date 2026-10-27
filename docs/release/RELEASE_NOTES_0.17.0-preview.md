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
- The Docker image is provided but its build was not verified on the release machine unless stated in the final report.
- Development-only advisories in `vitest`, `@vitest/mocker` and `tinypool` remain open pending a compatible major upgrade; they
  affect contributors running the test suite, not users of the runtime package.
- The relationship between CLI default flags and engine defaults is verified by comparing real runs, not by a unit test.

## Verification

The tarball carries a GitHub build-provenance attestation: `gh attestation verify repo-radar-0.17.0.tgz --repo
shadowhunter67/repo-radar`. A CycloneDX SBOM, `SHA256SUMS` and release metadata are attached.
