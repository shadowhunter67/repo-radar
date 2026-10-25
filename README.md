# repo-radar

**Experimental / Preview**

[![CI](https://img.shields.io/github/actions/workflow/status/shadowhunter67/repo-radar/ci.yml?label=CI)](https://github.com/shadowhunter67/repo-radar/actions)
[![License](https://img.shields.io/github/license/shadowhunter67/repo-radar)](LICENSE)
[![Node](https://img.shields.io/node/v/repo-radar)](package.json)
[![Version](https://img.shields.io/github/package-json/v/shadowhunter67/repo-radar)](package.json)
[![Security](https://img.shields.io/badge/security-policy-blue)](SECURITY.md)

Evidence-driven repository and software supply-chain intelligence for GitHub
repositories. repo-radar is static and read-only: it fetches metadata and source
text, applies bounded rules, and preserves evidence, coverage, confidence, and
unknown states.

## What it does

- identifies repository purpose and interfaces;
- observes static capabilities, install-time behavior, dependencies, releases,
  provenance, domains, governance indicators, and policy conditions;
- emits JSON reports, diffs, snapshots, graph projections, and bounded batch
  summaries;
- supports npm, Python, Cargo, Go, and selected build-system readers.

## What it does not do

It never executes, installs, or builds repository or artifact code. It is not a
malware scanner and does not issue safety, absence-of-malicious-software, compliance, or objective
trust-score claims. Capabilities are not intent. Compliance output is indicative,
not legal advice. Unknown and incomplete coverage are reported explicitly.

## Quick start

Node.js `>=20.17.0` is required.

```bash
npm ci
npm run build
export GITHUB_TOKEN=...                 # optional; never pass it on the command line
node dist/cli.js analyze owner/repo --format json --output report.json
node dist/cli.js analyze owner/repo --profile enterprise --enforce-profile
node dist/cli.js diff old.json new.json
```

The GitHub Action accepts the repository, profile, token, JSON output, static-scan,
enforcement, and score-floor inputs documented in [docs/action.md](docs/action.md).
Profiles are `default`, `startup`, and `enterprise`; methodology version is `0.4`.

Exit codes are `0` success, `1` internal error, `2` policy failure, `3` repository
not found, `4` service unavailable/rate limited, and `64` usage error.

## Feature maturity

| Area | Status |
| --- | --- |
| Static analysis, dependency normalization, release analysis | Core, stable-ish |
| Dependency history, incident correlation, governance intelligence, trust-graph queries, batch | Experimental |
| Compliance packs | Indicative |
| Dynamic analysis | Not implemented |

## Limitations

Coverage can be partial; large repositories are sampled and bounded. External APIs
can fail or rate-limit. Registry maintainers and similar data can be current-state,
not historical truth. Dependency history is opt-in/policy-triggered and may cost
hundreds to thousands of API requests. Calibration labels are AI-assisted and not
independently human-reviewed yet. Scores are evidence-derived heuristics, not
probabilities of safety or accuracy claims.

Read [docs/public-contract.md](docs/public-contract.md),
[docs/security-model.md](docs/security-model.md),
[docs/limitations.md](docs/limitations.md), and
[docs/maturity.md](docs/maturity.md) before relying on output.

## Public review

This preview is intended for maintainers, security engineers, dependency reviewers,
and researchers who can inspect evidence and review unknowns. Human calibration,
license review, public-claims review, and Gate 14 remain manual.

## Recorded example

The repository includes a historical recorded example at
[examples/hello-world.report.json](examples/hello-world.report.json). It uses an
older schema and is retained as a fixture, not as a current preview result. A
the excerpt below is generated from the pinned fake-fetch fixture in the test
suite and is clearly not a real repository.

Recorded fixture excerpt (not a real repository):

```json
{
  "label": "recorded fixture, not a real repository",
  "schema_version": "0.16",
  "score": 68.9,
  "confidence": 0.777,
  "coverage": [
    { "dimension": "security", "coverage": 0.269 },
    { "dimension": "maintenance", "coverage": 1 },
    { "dimension": "code-quality", "coverage": 0.824 },
    { "dimension": "supply-chain", "coverage": 0.846 },
    { "dimension": "community", "coverage": 1 },
    { "dimension": "documentation", "coverage": 1 },
    { "dimension": "semantic-clarity", "coverage": 1 }
  ],
  "unknown": true,
  "finding": {
    "title": "Download-and-execute chain observed in package.json#scripts.postinstall",
    "evidence_ids": ["CHAIN-001"]
  }
}
```
