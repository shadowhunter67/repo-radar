# v0.19.0 release readiness

Status words: **PASS**, **MANUAL** (needs a human), **BLOCKED** (cannot proceed without an owner action), **N/A**.
Facts below are from the released state. Observations on one machine, not benchmarks. Nothing here is legal advice or a human review.

## Outcome

| Item | Status |
|---|---|
| GitHub prerelease v0.19.0 (Experimental Preview) | **PASS**: published; tag `v0.19.0` points to commit `16aee42` |
| npm publication | **BLOCKED** (see below); not published |
| GitHub Action publication | **N/A**: not in scope, not published |

The release commit is `16aee422594b2118f5009dd8edfcfb89431e57b3` (preview-policy scope extended to v0.19.0 on top of the reviewed code).
The workflow ran with npm publication off; its `npm-publish` job was skipped.

## Checklist

| Area | Status | Evidence |
|---|---|---|
| Analyzer, scoring, methodology, schema | **PASS** (unchanged) | schema 0.16, methodology 0.4, no new detector |
| Quick / Deep invariant | **PASS** | `tests/unit/modes.test.ts`; installed package gave the same score 67.3 and commit for both modes on `sindresorhus/is-plain-obj` |
| Tests from the release commit | **PASS** | `npm run check`: 111 files, 1626 tests, 1 skipped (includes docs-sync) |
| Browser tests | **PASS** | Playwright Chromium 11/11 |
| CI on the release commit | **PASS** | check (20), check (22), web-e2e, package-install, action-policy-gate, action-matrix |
| Packed package | **PASS** | 610 files, 1.98 MB packed, 8.8 MB unpacked; no tests, scripts, calibration, env files or logs |
| `npm publish --dry-run` | **PASS** | repo-radar@0.19.0; nothing published |
| Clean install from the packed tarball | **PASS** | empty directory, production dependencies only: help, version, profiles, rules, usage exit 64 without network, live Quick and Deep analysis |
| Published tarball | **PASS** | `repo-radar-0.19.0.tgz` SHA-256 `eb8a4ad5...cc10be` (built by the workflow on Linux, Node 20, npm 10.8.2). It differs from the tarball packed locally on Windows (`1cb3a900...1e02`): no cross-platform byte-for-byte reproducibility is claimed |
| Release assets | **PASS** | tarball, `sbom.json` (CycloneDX 1.5, 249 components), `SHA256SUMS`, `release-metadata.json`; `sha256sum -c` on the downloaded files: all OK |
| Build provenance attestation | **PASS** | `gh attestation verify repo-radar-0.19.0.tgz --repo shadowhunter67/repo-radar` succeeded; certificate: repository `shadowhunter67/repo-radar`, ref `refs/tags/v0.19.0`, commit `16aee42`, workflow `release.yml@refs/tags/v0.19.0` |
| Install from the real release URL | **PASS** | `npm install -g <v0.19.0 tarball URL>` (clean prefix): `repo-radar --version` = 0.19.0 |
| Quick analysis from the published artifact | **PASS** | `sindresorhus/is-plain-obj`: commit `666df7c10035`, score 67.3, confidence 0.862, 5 findings |
| Production dependency audit | **PASS** | `npm audit --omit=dev`: 0 vulnerabilities |
| Full audit | **MANUAL** | 3 development-only advisories (`vitest`, `@vitest/mocker`, `tinypool`; 1 moderate, 2 critical per npm); they affect contributors, not the runtime package |
| Licence inventory | **MANUAL** | production closure unchanged: 55 packages (MIT 23, ISC 15, Apache-2.0 7, BlueOak-1.0.0 6, BSD-2-Clause 1, BSD-3-Clause 1, LGPL-3.0+ 1 = `openpgp`, 1 with no licence field = `@openpgp/web-stream-tools`, listed in the tree but not installed locally). Machine-generated, not legal advice |
| `openpgp` | **MANUAL** | external runtime dependency, lazily imported (`dist/trust/gpg.js`), not copied into `dist`. The Action bundle question stays open and out of scope |
| Secret scan | **PASS** | packed tarball, SBOM, metadata, checksum file and tracked tree (excluding test fixtures that hold deliberately fake keys): no token or key patterns. Not a full-history scan |
| Hosted preview | **PASS** | production reports version 0.19.0 and build `16aee42` on `/api/v1/health` and `/api/v1/ready` |
| Branch protection | **PASS** | required checks: check (20), check (22), web-e2e, package-install |
| Gate 14 (calibration labels) | **MANUAL** | unchanged; no AI review is presented as independent review |
| Public claims | **PASS** | Experimental Preview wording kept; no safety, audit or full-coverage claims |

## npm: BLOCKED

1. **Licence/distribution review not approved.** `preview-policy.json` has `npm_license_review: "pending"`; the `npm-publish` job refuses to run otherwise. A human must review the inventory, in particular the LGPL `openpgp` dependency.
2. **Trusted publishing not configured.** The `npm-publish` job uses OIDC and no token. The package owner must add a trusted publisher on npmjs.com: repository `shadowhunter67/repo-radar`, workflow `release.yml`, environment `release` (check npm's current documentation for the exact fields). Whether a brand-new package name can be created by its first trusted publication, or needs a one-time owner-side step, has not been verified: this needs owner verification against current npm behavior.
3. **Package name.** `repo-radar` returned 404 on the registry again on 2026-10-30 (unclaimed); that is not a reservation.

No npm token was requested or created, and no `NPM_TOKEN` exists in the workflow.

## Manual follow-ups

- Close the npm licence review and configure the trusted publisher (next cycle).
- Verify `TRUST_PROXY` behind Render's proxy (the hosted per-client rate limit may be shared) and Render's "after CI checks pass" setting.
- Gate 14 human review; legal decision on `openpgp` for any bundled distribution.

## Known limitations

Hosted preview on Render Free (cold starts, 512 MB), shared GitHub quota, Quick only, ephemeral jobs, public repositories only; Deep is bounded
and can still be partial; history is optional and expensive; external evidence can change over time; Gate 14 is manual; the Docker image was
last built and run against 0.17 code.
