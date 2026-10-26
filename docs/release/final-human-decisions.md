# Final human decisions for the experimental preview

**Status (2026-10-26):** on the maintainer's written instruction, decisions 1 and 2
are recorded in `docs/release/preview-policy.json` (experimental public source preview
and GitHub `v0.16.0` prerelease only, with unreviewed calibration disclosed; public
wording approved). Decisions 3 (npm licence) and 4 (openpgp in the Action bundle) are
**still pending** and block only the npm and Action channels. Decision 5 is executed
by the release procedure below. Nothing here marks the calibration labels as
human-reviewed; gate 14 stays MANUAL and remains required for any validated accuracy
claim and for 1.0.

Everything that can be automated is done. What remains cannot be decided by code.

Release candidate: `main` at the commit you approve (see `git log -1`), package
`repo-radar@0.16.0`, schema 0.16, methodology 0.4. Name: **repo-radar Public Preview
(experimental)**.

## Channel status

| Channel | Status | Blocked only by |
| --- | --- | --- |
| GitHub source repository (public) | READY pending approval | Decisions 1, 2, 5 |
| GitHub prerelease (tarball, SBOM, checksums, metadata) | READY pending approval | Decisions 1, 2, 5 |
| npm package | BLOCKED | Decision 3, plus npm trusted-publishing setup (see below) |
| GitHub Action | BLOCKED | Decision 4 (openpgp is bundled into the Action file) |

## Decision 1: allow an experimental public preview while Gate 14 stays unreviewed?

Gate 14 itself (`scripts/check-release-gates.mjs`) is not changed and stays MANUAL.

- **Recommended:** yes, as a preview that is explicitly labelled "calibration not
  independently reviewed". Gate 14 then remains mandatory for any validated or stable
  accuracy claim.
- **Alternative:** have a person review the labels first
  (`docs/release/review-gate14.md`, 30-60 minutes); Gate 14 then passes properly.
- **Consequence of "yes":** the repository and prerelease may be published with the
  disclaimer already in the README; calibration remains internal engineering evidence.
- **File to change:** `docs/release/preview-policy.json`: set
  `allow_experimental_preview_with_unreviewed_calibration` to `true` and fill
  `approved_by`, `approved_on` and `rationale`. The release workflow refuses to publish
  until all four are set.

## Decision 2: approve the public wording?

- **Recommended:** approve after reading `docs/release/review-claims.md` (README, GitHub
  description, release notes, npm and Action descriptions). The wording avoids safety,
  malware-free, compliance, accuracy and "production ready" claims.
- **Alternative:** edit the quoted claims first.
- **File to change:** `docs/release/preview-policy.json`: `public_claims_review` to
  `"approved"`.
- **Consequence:** unlocks the GitHub prerelease job. Note the repository description
  still says "(private, pre-release)" and must be replaced with the text in
  `docs/release/github-metadata.md` when it goes public.

## Decision 3: approve licence and distribution status for the npm package?

repo-radar is Apache-2.0. `openpgp` (LGPL-3.0-or-later) is an external runtime
dependency of the npm package, not copied into it. `docs/release/review-licenses.md`
lists every production dependency licence; `THIRD_PARTY_NOTICES.md` ships in the
package. No legal conclusion is made in the repository.

- **Recommended:** a responsible person reads `review-licenses.md` and approves npm
  distribution as an external dependency.
- **Alternative:** do not publish to npm; the source and prerelease channels are
  unaffected.
- **File to change:** `docs/release/preview-policy.json`: `npm_license_review` to
  `"approved"`.
- **Also required for npm (technical, not a decision):** the workflow still uses a
  long-lived `NPM_TOKEN` and its publish job lacks `id-token: write` for `--provenance`.
  Configure npm trusted publishing and add a dedicated publish job before the first
  npm release. Until then npm stays BLOCKED.

## Decision 4: allow openpgp inside the Action bundle?

`dist/action/repo-radar.mjs` (about 4.7 MB) contains `openpgp` (LGPL-3.0-or-later)
linked into one file. This is a distribution question that needs a responsible
person.

- **Recommended:** keep the Action unpublished for now; the other channels do not
  depend on it. The release workflow does not attach the bundle (tested).
- **Alternative:** decide to bundle with the licence requirements satisfied, or change
  the build so the Action does not bundle openpgp, or ship an unbundled layout.
- **File to change:** `docs/release/preview-policy.json`:
  `legal_review_openpgp_action_bundle` from `"pending"` to the decision.
- **Consequence:** only the Action channel is affected.

## Decision 5: authorize actual publication

- **Recommended order:** (1) decisions 1 and 2 recorded; (2) run the workflow
  `release` with `dry_run=true` once more on the final commit and read the artifacts;
  (3) change the repository to public in GitHub settings and replace the description;
  (4) enable private vulnerability reporting (Settings, Code security; not available
  while the repository is private); (5) push a tag `v0.16.0`, approve the `release`
  environment, and let the workflow create the prerelease.
- **Alternative:** publish the source only and release later.
- **Nothing was published in this cycle:** the repository is private, no tag exists, no
  GitHub release, no npm package, no Action.
