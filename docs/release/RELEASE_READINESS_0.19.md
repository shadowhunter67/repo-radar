# v0.19.0 release readiness

Status words: **PASS**, **FAIL**, **MANUAL** (needs a human), **BLOCKED** (cannot proceed without an owner action).
Observations on one machine, not benchmarks. Nothing here is legal advice or a human review.

## Recommendation

| Item | Status |
|---|---|
| GitHub prerelease v0.19.0 (Experimental Preview) | **READY**, with one MANUAL step: the maintainer extends `preview-policy.json` scope to v0.19.0 (as was done for 0.17 and 0.18) and starts the release workflow |
| npm publication | **BLOCKED** (see below) |
| GitHub Action publication | **NOT IN SCOPE** (unchanged; the bundled `openpgp` question stays open) |

## Checklist

| Area | Status | Evidence |
|---|---|---|
| Analyzer, scoring, methodology, schema | **PASS** (unchanged) | schema 0.16, methodology 0.4, no new detector; Quick keeps its `report_sha256` |
| Quick / Deep invariant | **PASS** | `tests/unit/modes.test.ts`: same findings, score, confidence, facts when both can read everything |
| Unit and integration tests | **PASS** | `npm run check`: 111 files, 1626 tests, 1 skipped |
| Browser tests | **PASS** | Playwright Chromium 11/11 |
| CI (Node 20, Node 22, web-e2e, action-policy-gate) | **PASS** on the previous commit; re-verified on the release commit before tagging | new `package-install` job added |
| Packed package | **PASS** | `npm pack`: 600 files, 2.0 MB packed, 8.8 MB unpacked (dist, schemas, standards, docs, notices); no `tests`, `scripts`, `calibration`, env files or logs (`check-package-content`) |
| `bin` and shebang | **PASS** | `"repo-radar": "dist/cli.js"`, `#!/usr/bin/env node`, works through `.cmd` on Windows |
| Clean install | **PASS** | tarball installed into an empty directory (production dependencies only): `--help`, `analyze --help`, `--version`, `profiles`, `rules`, four usage errors (exit 64, proxy pointed at a dead port so any fetch would fail), schema present |
| Installed package, live, small repo | **PASS** | `analyze sindresorhus/is-plain-obj --mode quick` and `--mode deep`: same score 67.3 and commit `666df7c10035` (fully covered, so both modes agree) |
| Install from a published release URL | **PASS** | `npm install <v0.18.0 tarball URL>` gave a working `repo-radar` |
| `npm publish --dry-run` | **PASS** | repo-radar@0.19.0, 600 files; no network publish performed |
| Package contents reproducible | **PASS (this machine)** | two consecutive `npm pack` runs from the same tree gave identical SHA-256 (`7dd6bc03...ed03f1`); not claimed across platforms or npm versions |
| Production dependency audit | **PASS** | `npm audit --omit=dev`: 0 vulnerabilities |
| Full audit | **MANUAL** | 3 development-only advisories (`vitest`, `@vitest/mocker`, `tinypool`; 1 moderate, 2 critical per npm) remain; they affect contributors, not the runtime package |
| Licence inventory | **MANUAL** | production closure: 55 packages (MIT 23, ISC 15, Apache-2.0 7, BlueOak-1.0.0 6, BSD-2-Clause 1, BSD-3-Clause 1, LGPL-3.0+ 1, one with no `license` field in its manifest). The LGPL package is `openpgp` |
| `openpgp` (LGPL-3.0-or-later) | **MANUAL** | an external dependency of the npm package (installed separately, lazily imported, not copied into `dist`). The Action bundle that inlines it is out of scope. Needs a human licence decision |
| Secret scan | **PASS** | packed tarball, SBOM, metadata and the tracked tree (excluding test fixtures that hold deliberately fake keys): no token or key patterns. Not a full-history scan |
| SBOM | **PASS** | CycloneDX 1.5, 243 components, generated with `npm sbom --sbom-format cyclonedx --sbom-type application` (npm 11.13.0); an SBOM is not a complete truth |
| Checksums and metadata | **PASS** | `SHA256SUMS` over tarball, SBOM, metadata; metadata has version, node, npm, commit |
| Build provenance attestation | **MANUAL** | produced and verified by the release workflow on tagging; not claimed until `gh attestation verify` succeeds on the release asset |
| Hosted preview | **PASS** | see the final report; Quick only, `mode` refused, cold start tolerated |
| Gate 14 (calibration labels) | **MANUAL** | unchanged; no AI review is presented as independent review |
| Public claims | **PASS** | Experimental Preview wording kept; no safety, audit or full-coverage claims |

## npm: BLOCKED

1. **Licence/distribution review not approved.** `preview-policy.json` has `npm_license_review: "pending"`; the release workflow refuses
   to publish otherwise. A human must review the inventory, in particular the LGPL `openpgp` dependency.
2. **Trusted publishing not configured.** The workflow's `npm-publish` job uses OIDC and no token. On npmjs.com the package owner must add
   a trusted publisher for the package: repository `shadowhunter67/repo-radar`, workflow `release.yml`, environment `release`. npm's
   setting is per package, so check npm's current documentation on whether the first publication of a new name needs a one-time
   owner-side step.
3. **Package name.** `repo-radar` returned 404 on the registry today, i.e. it is unclaimed; that is not a reservation.

Nothing was published. No npm token was requested or created.

## Steps for the maintainer to release v0.19.0 (GitHub prerelease only)

1. Extend `docs/release/preview-policy.json` scope and approval note to v0.19.0 (the maintainer's own written decision).
2. Tag `v0.19.0` on the final commit; the workflow verifies, builds, attests and waits on the `release` environment.
3. Approve the environment; verify the attestation and checksums from the release assets.
4. Update the README download link and `docs/getting-started.md` install URL to v0.19.0.
5. Do not run the release with `publish_npm` until items 1 and 2 above are resolved.

## Known limitations

Hosted preview on Render Free (cold starts, 512 MB), shared GitHub quota, Quick only, ephemeral jobs, public repositories only;
Deep is bounded and can still be partial; history is optional and expensive; external evidence can change over time;
`TRUST_PROXY` behind Render is unverified; Render's "after CI checks pass" setting is unverified; Gate 14 is manual.
