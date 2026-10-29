# repo-radar 0.19.0 — Experimental Preview (Quick Scan and Deep Scan)

**This is an experimental preview, not a stable release.** There is no stable API or 1.0 guarantee. The report schema is 0.16 and
the methodology 0.4, both unchanged.

## What is new since 0.18.0

### Added

- **Quick Scan and Deep Scan.** Two retrieval profiles over the same analyzer (same facts, rules, scoring, findings, schema and
  methodology; only the budgets differ). CLI: `repo-radar analyze owner/repo --mode quick|deep`, plus an explicit `--history`.
  Quick is the default and keeps the long-standing budgets; Deep reads up to 200 files (128 KiB each, 12 MiB total) and looks up up
  to 150 dependencies, still bounded. See [docs/modes.md](../modes.md) and [docs/deep-scan.md](../deep-scan.md).
- **Web Analyzer as a Quick Scan preview**, Vietnamese by default with a VI / EN switch. Overall evidence, source code and
  dependency lookup coverage are shown separately; partial reasons are stable codes with counts, localized; a Deep Scan call to
  action with the exact-commit command appears when a result is partial or thinly scanned. The hosted service refuses a `mode`
  field (`UNSUPPORTED_ANALYSIS_MODE`).
- **Onboarding docs:** [Getting started](../getting-started.md), [CLI reference](../cli.md), a tested set of documented commands.
- **Packaging checks in CI:** a job that installs the packed tarball into an empty directory and runs the CLI from there.
- **npm trusted publishing path** in the release workflow (OIDC, no stored token); it only runs on an explicit request and only
  once the preview policy records an approved licence review.

### Changed

- `repo-radar --help` is now a short first screen with examples; `repo-radar analyze --help` lists every analyze option. Usage
  errors are one line plus a pointer, and never touch the network.
- The Deep Scan command shown on the result page links to the install guide.

### Fixed

- A percent-encoded host in a repository URL (`https://%67ithub.com/...`) was accepted by the hosted API; it is rejected.
- An oversized request body produced a bare 502 behind a proxy; it now gets a real 413.
- The hosted page tolerates a cold start of the free host with a neutral waiting message instead of an error.
- Unreadable white-on-white buttons in dark mode; explicit colours for buttons, inputs and selects in both themes.

## Installing

repo-radar is **not on the npm registry**. Install it from this release's tarball
(`npm install -g <release tarball URL>`) or from a source checkout; see [docs/getting-started.md](../getting-started.md).

## What it is not

- Not a safety verdict: scores are evidence-derived heuristics, a capability is not intent, "not observed" is not "absent".
- Deep is bounded, not exhaustive: a large repository can still be partial.
- Not published to npm; the GitHub Action is not published.
- Calibration labels have not been independently human-reviewed (Gate 14 remains manual).

## Known limitations

- Hosted preview: Render Free (cold starts, 512 MB), one shared server-side GitHub token, temporary in-memory jobs, public
  repositories only, Quick only.
- Live runs of one commit are not byte-identical (time stamps, current-state sources); see [docs/reproducibility.md](../reproducibility.md).
- Dependency lookup in Deep stops at 150 packages, and some very large registry responses are skipped (`too_large`).
- `TRUST_PROXY` behaviour behind Render's proxy has not been verified, so the hosted per-client rate limit may be shared.
- Development-only advisories in `vitest`, `@vitest/mocker` and `tinypool` remain open; the production dependency tree has none.
- `openpgp` (LGPL-3.0-or-later) is an external runtime dependency; the licence review for npm distribution is pending a human.

## Verification

The tarball carries a GitHub build-provenance attestation: `gh attestation verify repo-radar-0.19.0.tgz --repo
shadowhunter67/repo-radar`. A CycloneDX SBOM, `SHA256SUMS` and release metadata are attached.
