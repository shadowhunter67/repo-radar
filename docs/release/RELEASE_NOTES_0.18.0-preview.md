# repo-radar 0.18.0 — Experimental Preview (deterministic reports, hosting-ready Web Analyzer)

**This is an experimental preview, not a stable release.** There is no stable API or 1.0 guarantee. The report schema is still 0.16
(one additive field, see below) and the methodology 0.4; the HTTP API is still "v1" of that API only.

## What is new

- **Deterministic reports.** Two causes of nondeterministic output were found and fixed: scanned files were collected in
  network-completion order (which also changed the order of `external_domains` observations) and diagnostics were emitted in
  completion order. `integrity.report_sha256` now covers canonical JSON (`integrity.format = "canonical-json@1"`, additive field);
  older stored reports still verify. A randomized-completion-order test with every mocked upstream enabled now guards this. See
  [docs/reproducibility.md](../reproducibility.md).
- **One default configuration** (`src/defaults.ts`) shared by the CLI, the web worker and the library, with tests that prove the
  CLI with no flags, the web options and the engine defaults agree, and that a CLI-path analysis and a web-job-path analysis of the
  same mocked upstreams give an identical report.
- **Quota-aware admission** for the shared GitHub token: real remaining quota from GitHub's rate-limit endpoint, minus expected
  in-flight cost and a reserve; `SERVICE_RATE_LIMITED` with the reset time instead of starting a job that cannot finish.
- **Exact-commit analysis, short-lived cache and request coalescing.** The server resolves the ref to a SHA first, analyzes that
  SHA, caches `completed` reports for 10 minutes by default (key: repository, SHA, tool version, configuration digest), and lets
  identical concurrent requests share one analysis.
- **Worker hardening.** The runner settles exactly once whatever the worker does; real worker-thread tests cover a throwing worker,
  non-zero and clean exits without a result, malformed results, a hanging worker (timeout, worker really terminated), a worker that
  exhausts a small memory cap, and a failing job followed by a healthy one. Graceful shutdown, job-bookkeeping leak checks and a
  startup test from a path with spaces and non-ASCII characters were added.
- **Operations:** `/api/v1/ready` (version, schema, methodology, build commit, queue, coarse quota state), `/api/v1/metrics`
  (aggregates only), structured logs without repository names or addresses, IPv6 clients limited per /64, config validation.
- **UI:** hosted-limits banner, explained partial results, shared-quota and shutdown messages with the exact CLI fallback, analysis
  configuration, configuration digest, integrity hash with an honest explanation and copy action, data-freshness list, noindex once
  an analysis starts, deployed build in the footer, findings rows built per page so very large reports stay responsive.
- No new detector, no scoring or methodology change.

## What it is not

- **No official hosted instance is deployed.** No hosting platform was chosen for this cycle; this release ships code, tests and
  deployment documentation only. The repository website field stays empty.
- Public repositories only; no accounts, no stored history, no permalinks, no private-repository authentication.
- Not published to npm. The GitHub Action is not published.
- Not a safety guarantee. Calibration labels have not been independently human-reviewed (Gate 14 remains manual).

## Known limitations

- Live runs of the same commit are not byte-identical: time stamps are part of the report, and registry/vulnerability sources
  describe current state. Determinism is proven for frozen evidence (mocked upstreams), not for live upstreams.
- Jobs and the cache live in one process's memory and are lost on restart; there is no sharing between replicas.
- All users of an instance share one GitHub token budget; admission control reduces, but cannot remove, the chance of
  `SERVICE_RATE_LIMITED` under load.
- The web analyzes a pinned commit, so a report of a moving branch always names the exact SHA that was read.
- The Docker image was verified in 0.17; the 0.18 code was not run inside a rebuilt image in this cycle.
- A running job cannot be cancelled by the client; it finishes or times out and expires at the TTL.
- Development-only advisories in `vitest`, `@vitest/mocker` and `tinypool` remain open pending a compatible major upgrade.

## Verification

The tarball carries a GitHub build-provenance attestation: `gh attestation verify repo-radar-0.18.0.tgz --repo
shadowhunter67/repo-radar`. A CycloneDX SBOM, `SHA256SUMS` and release metadata are attached.
