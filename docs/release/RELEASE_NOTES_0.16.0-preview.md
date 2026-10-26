# repo-radar 0.16.0 — Experimental Preview

**This is an experimental preview, not a stable release.** There is no stable API or
1.0 guarantee: the CLI, the JSON schema (currently 0.16) and the methodology
(currently 0.4) may change between 0.x versions, with migration notes in
[docs/migration.md](../migration.md).

repo-radar provides evidence-driven, static repository and software supply-chain
intelligence for GitHub repositories. It preserves observations, evidence, coverage,
confidence and unknown states for human review.

## What it does

- identifies repository purpose and interfaces;
- observes static capabilities, install-time behaviour, dependencies, releases,
  provenance, external domains, governance indicators and policy conditions;
- emits JSON reports, revision diffs, immutable snapshots, graph projections and
  bounded batch summaries;
- supports npm, Python, Cargo and Go dependency formats and selected build-system
  readers.

## Included in this prerelease

Core static analysis, dependency normalization, release metadata, JSON reports, diffs,
snapshots, graph projections and bounded policy evaluation. Experimental features:
dependency history (optional, off by default, can cost hundreds to thousands of GitHub
API requests), governance indicators, incident correlation, trust-graph queries and
batch analysis.

## Installation and use

Attached to this release: `repo-radar-0.16.0.tgz` (npm tarball), `sbom.json`
(CycloneDX), `SHA256SUMS` and `release-metadata.json`. Verify the files first:

```bash
sha256sum -c SHA256SUMS
npm install ./repo-radar-0.16.0.tgz
npx repo-radar analyze owner/repo --format json --output report.json
```

or build from source (`npm ci && npm run build`, then `node dist/cli.js ...`). Node.js
>=20.17.0 is required; CI tests Node 20 and 22 on Linux, Windows is tested locally and
macOS is best effort. A GitHub token (environment variable `GITHUB_TOKEN`, never on the
command line) is recommended to avoid rate limits.

Not part of this release: the package has **not** been published to the npm registry
and no GitHub Action is published.

## How to read the output

A score is an evidence-derived heuristic. It is not a probability that software is
safe, not a malware probability, and not a compliance or legal determination.
Confidence and coverage say how much was actually observed: "not observed" means not
observed within the analyzed coverage, it does not mean absent, and unknown is neither
safe nor bad.

## Limitations and security model

Repository and artifact code is never executed, installed or built. Coverage is
bounded and can be partial; large repositories are sampled. External APIs can fail or
rate-limit and are reported as unavailable or partial, never as clean. Registry data can
be current-state rather than historical truth. See
[security-model](../security-model.md) for the SSRF, archive, token, snapshot, Unicode
and API-failure controls. repo-radar sends no telemetry.

Calibration labels (identity, incident and dependency-history ground truth) are
AI-assisted and have **not** been independently human-reviewed. Release gate 14 is still
MANUAL; this preview was approved by the maintainer under
[docs/release/preview-policy.json](preview-policy.json) with that disclosed, and it
makes no accuracy, detection-rate, safety, malware or compliance claim. Compliance
output is indicative and is not legal advice.
