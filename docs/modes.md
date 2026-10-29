# Quick Scan and Deep Scan

Two **retrieval profiles** over one analyzer.

```text
Quick  = conservative bounded budgets (screening, hosted preview, the engine's long-standing defaults)
Deep   = generous bounded budgets (a developer workstation)
```

## The invariant

Quick and Deep use the same facts, rules, scoring, finding semantics, report schema and methodology. Only what is **retrieved**
differs: source retrieval, request budgets, dependency lookup budgets. If both modes observe the same evidence they reach the
same conclusion about it. Deep means more evidence, not a different interpretation. This is tested
(`tests/unit/modes.test.ts`): when both can read everything, score, confidence, findings, facts and dimensions are identical;
when a repository is larger than Quick's budget, Quick is partial and Deep covers more.

## Budgets

| Budget | Quick | Deep |
|---|---|---|
| Source/script/build files fetched | 40 | 200 |
| Per-file size cap | 64 KiB | 128 KiB |
| Total scanned bytes | 2 MiB | 12 MiB |
| Reference-following rounds | 2 | 3 |
| Dependency registry packages queried | 25 | 150 |
| Dependency registry requests | 60 | 300 |
| Dependency registry time | 45 s | 180 s |
| Dependency registry response bytes | 48 MiB | 160 MiB |

Everything stays bounded: per-file limits, total byte limits, timeouts and decompression protections apply in both modes. Deep is
not a trust-all mode, never installs or executes the target (no `npm install`, no scripts, no binaries, no repository tests) and
stays static and evidence-driven. The values live in one place, `src/modes.ts`.

## What Deep does not switch on

Expensive optional collectors keep their own explicit switches and are **not** implied by `--mode deep`: dependency
introduction history (`--history`), dependency artifact inspection, cryptographic attestation verification, name intelligence.
A normal Deep scan therefore never spends thousands of GitHub requests by surprise.

## CLI

```bash
node dist/cli.js analyze owner/repo --mode quick            # default
node dist/cli.js analyze owner/repo --ref <sha> --mode deep
node dist/cli.js analyze owner/repo --mode deep --history   # explicit and expensive
```

The text report prints `Mode: Quick` or `Mode: Deep`. The JSON report does not carry the mode (the schema is unchanged); the
recorded `analysis_manifest.budgets` and the configuration digest reflect the budgets that applied. A Quick analysis keeps the
digest and the `report_sha256` it always had; Deep has its own configuration digest because it retrieves differently.

## Web

The hosted Web Analyzer is **Quick only**. It does not offer a Deep option and refuses a request that names a mode
(`400 UNSUPPORTED_ANALYSIS_MODE`). Resource caps for a small host (one worker, a short queue, a small worker heap) are applied
separately by the server and are not part of the definition of Quick.

## Limits of each mode

Quick: bounded source retrieval, bounded registry lookups, shared GitHub quota on the hosted service, cold starts and temporary
jobs on the free host, public repositories only.

Deep: still bounded, large repositories can still be partial, external evidence (registries, advisories) can change between
runs, history is optional and expensive, and nothing here is a proof of safety.

## Dogfood observation (one run, not a benchmark)

`shadowhunter67/daklak-3d-dashboard` at commit `b00adf2bda1a`, on a developer machine with a token:

| | Quick | Deep |
|---|---|---|
| Source files scanned | 40 / 401 (10%) | 200 / 401 (50%) |
| Dependency lookups | 25 / 375 | 150 / 375 |
| Files skipped as too large | 2 | 0 |
| GitHub/registry requests | 129 | 414 |
| Wall time | about 26 s | about 63 s |
| Overall evidence coverage | 100% | 100% |
| Score / confidence | 75.5 / 0.824 | 76.1 / 0.833 |
| Findings | 24 | 28 |

Deep read more files and packages, so it saw evidence Quick did not (including two extra supply-chain findings); it is not
claimed that Deep always produces more findings.
