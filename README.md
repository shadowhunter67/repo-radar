# repo-radar

**Experimental / Preview**

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
