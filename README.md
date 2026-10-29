# repo-radar

**Experimental / Preview**

[![CI](https://img.shields.io/github/actions/workflow/status/shadowhunter67/repo-radar/ci.yml?label=CI)](https://github.com/shadowhunter67/repo-radar/actions)
[![License](https://img.shields.io/github/license/shadowhunter67/repo-radar)](LICENSE)
[![Node](https://img.shields.io/node/v/repo-radar)](package.json)
[![Version](https://img.shields.io/github/package-json/v/shadowhunter67/repo-radar)](package.json)
[![Security](https://img.shields.io/badge/security-policy-blue)](SECURITY.md)

repo-radar is an evidence-driven analyzer for trust signals, software supply-chain behavior, repository capabilities,
dependencies, provenance and governance of GitHub repositories. It is static and read-only: it fetches metadata and source text,
applies bounded rules, and keeps evidence, coverage, confidence and unknown states visible. It never executes the code it
analyzes.

### [Try the Web Quick Scan](https://repo-radar-kcd0.onrender.com)

```text
https://repo-radar-kcd0.onrender.com
```

Paste a public GitHub repository and get a bounded, temporary report (Vietnamese by default, VI / EN switch). It runs on Render Free,
so the first request after a quiet period can take a minute. Large repositories can return a partial result; the page says why and
shows the exact command for a Deep Scan.

### Run it locally

```bash
repo-radar analyze sindresorhus/is-plain-obj                          # Quick Scan: fast, bounded screening
repo-radar analyze owner/repo --ref <sha> --mode deep                 # Deep Scan: higher coverage, larger budgets
```

repo-radar is **not on the npm registry yet**; install it from a release tarball or a source checkout in two commands
([Getting started](docs/getting-started.md)). **Experimental Preview:** scores are evidence-derived heuristics, not probabilities
of safety, and calibration labels have not been independently human-reviewed.

## Download

- **Latest preview release:** [v0.18.0 (Experimental Preview)](https://github.com/shadowhunter67/repo-radar/releases/tag/v0.18.0)
  — npm tarball, CycloneDX SBOM, `SHA256SUMS` and release metadata; the tarball carries a
  GitHub build-provenance attestation (`gh attestation verify repo-radar-0.18.0.tgz --repo shadowhunter67/repo-radar`).
- [All releases](https://github.com/shadowhunter67/repo-radar/releases)
- Not published yet: the npm registry package and the GitHub Action.

## Web Analyzer (Experimental Preview)

Besides the CLI there is a small web page and API that run the same engine on a **public** GitHub repository and show the
result (score, confidence and coverage separately, the exact analyzed commit, findings with evidence, and a JSON download).
An experimental preview is hosted at https://repo-radar-kcd0.onrender.com (Render Free: 0.1 CPU, 512 MB RAM, sleeps when idle, so a cold start can add about a minute; one shared server-side GitHub token; jobs are kept in memory and lost on restart; no accounts; history analysis off). To run it yourself:

```
npm ci && npm run build
GITHUB_TOKEN=... npm run web:dev      # http://127.0.0.1:8787
```

Public repositories only, no accounts, no telemetry, results kept in memory for a short time. Reports are reproducible for frozen evidence ([docs/reproducibility.md](docs/reproducibility.md)). See
[docs/web-analyzer.md](docs/web-analyzer.md) for the API and limits and [docs/deployment.md](docs/deployment.md) for running it
(including a non-root `Dockerfile`).

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

# Fast screening (the default; same budgets as the hosted Quick Scan)
node dist/cli.js analyze owner/repo --mode quick
# Higher coverage: larger retrieval budgets, still bounded
node dist/cli.js analyze owner/repo --ref <exact-sha> --mode deep
# Optional expensive collectors are separate switches, not implied by --mode deep
node dist/cli.js analyze owner/repo --mode deep --history

node dist/cli.js analyze owner/repo --format json --output report.json
node dist/cli.js analyze owner/repo --profile enterprise --enforce-profile
node dist/cli.js diff old.json new.json
```

The GitHub Action accepts the repository, profile, token, JSON output, static-scan,
enforcement, and score-floor inputs documented in [docs/action.md](docs/action.md).
Profiles are `default`, `startup`, and `enterprise`; methodology version is `0.4`.

Private repositories are supported when the supplied read-only token permits
contents access. Selected private files use the authenticated GitHub contents API,
one request per file, with the same bounded scan limits. For large private
repositories, `--no-scan` or a bounded scan is recommended; failed contents requests
remain unknown and are reported as partial coverage.

Exit codes are `0` success, `1` internal error, `2` policy failure, `3` repository
not found, `4` service unavailable/rate limited, and `64` usage error.

## Quick Scan and Deep Scan

Two retrieval profiles over the **same** analyzer: same facts, rules, scoring, findings, schema and methodology. Deep reads more
evidence; it never interprets it differently. Details and the exact budgets: [docs/modes.md](docs/modes.md).

| | Quick Scan | Deep Scan |
|---|---|---|
| Primary use | preview, screening | detailed local analysis |
| Web | yes (only mode) | no |
| CLI | `--mode quick` (default) | `--mode deep` |
| Source files fetched | up to 40 | up to 200 |
| Per-file size cap | 64 KiB | 128 KiB |
| Dependency lookups | 25 packages | 150 packages |
| History | off | optional (`--history`) |
| Runtime | shorter | longer |
| Partial possible | yes | yes |

Deep does not guarantee full coverage: it is still bounded, large repositories can still be partial, and external evidence
(registries, advisories) can change over time. Neither mode is a safety verdict.

## Documentation

[Getting started](docs/getting-started.md) · [CLI reference](docs/cli.md) · [Quick and Deep modes](docs/modes.md) · [Deep Scan guide](docs/deep-scan.md) · [Web Analyzer](docs/web-analyzer.md) · [Reproducibility](docs/reproducibility.md) · [Methodology](docs/methodology.md) · [Limitations](docs/limitations.md)

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
probabilities of safety or accuracy claims, and not malware probabilities. "Not observed"
means not observed within the analyzed coverage; it does not mean absent. Compliance
output is indicative and is not legal advice.

repo-radar sends no telemetry. It contacts only the services needed for the analysis
you request: GitHub, OSV, deps.dev, OpenSSF Scorecard, the npm, PyPI and crates.io
registries, and (with `--verify-crypto`) the Sigstore trust repository.

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
