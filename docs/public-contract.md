# Public contract (0.x preview)

This document describes the actual preview surface exposed by `dist/cli.js`. It is
not an accuracy or safety guarantee.

## Commands and stable options

Commands are `analyze`, `diff`, `batch`, `model`, `graph`, `snapshots`, `profiles`,
and `rules`. The principal stable options are `--format json`, `--ref`,
`--profile`, and `--enforce-profile`. The full option list is printed by
`repo-radar --help`; experimental switches remain bounded and may change.

| Code | Meaning |
| ---: | --- |
| 0 | report produced and policy passed |
| 1 | internal error |
| 2 | policy floor/profile failure |
| 3 | repository not found |
| 4 | service unavailable or rate limited |
| 64 | usage error |

`batch` uses the same codes: 2 if any repository failed its policy; otherwise 4 if any
repository failed or was incomplete, or the batch stopped on a budget or rate limit
(the JSON summary says which repositories and why); otherwise 0. Per-repository
failures never abort the rest of the batch.

API failures never share the policy-failure code. A report can still be produced
with unavailable or partial subsystem states; unknown is not clean.

## JSON, versions, and reproducibility

Reports carry `schema_version`, `methodology`, `analysis_manifest`, evidence IDs,
coverage, and integrity metadata. Optional additive fields are allowed within a
preview; removed, renamed, retyped, or meaningfully changed fields require a schema
bump. This repository currently bumps the minor schema for additive optional fields
as well. `docs/migration.md` records migrations. Methodology changes require a
changed score input, weight, rule-evaluation semantic, confidence/coverage meaning,
or score range; schema-only and documentation changes do not.

For a repository and exact SHA, fixed configuration, clock, and external responses,
source-bound analysis is reproducible. Current registry maintainers, live OSV,
deps.dev, and current GitHub metadata may vary. Reports can expose repository
structure, dependencies, domains, and findings; review before sharing publicly.

## Offline, credentials, and platforms

| Mode | Result |
| --- | --- |
| Recorded fixtures/unit tests | offline and deterministic within the varying-field allow-list |
| GitHub repository analysis | online; GitHub metadata/files become unavailable without access |
| OSV, deps.dev, registries, releases | online optional collectors; failures remain unknown/partial |
| Sigstore verification | online TUF retrieval when explicitly requested |
| Dependency history | opt-in/policy-triggered; long histories can cost hundreds to ~1900 requests |

`GITHUB_TOKEN` is recommended, passed through the environment, and never on the
command line. The unauthenticated limit is typically much lower than the token
limit; batch/history workloads can exhaust the 5000/hour quota. CI tests Node 20 and
22 on Linux. Windows is tested locally by maintainers; macOS is best effort.

There is no telemetry collector or analytics endpoint in the code. Network paths are
allowlisted in the security model; Sigstore's TUF client is the documented exception.
## Private repository contents

With a read-only `GITHUB_TOKEN`, private repository files are fetched through
GitHub's authenticated contents API, with the raw media type and the same file and
byte caps as public scans. Each selected file costs one API request. The report
includes an informational `private_repository_contents_api` diagnostic. A missing
token or contents API failure yields explicit unavailable/partial diagnostics and
unknown coverage; it is never interpreted as a clean scan. For large private
repositories, use `--no-scan` or keep the bounded scan selection small.
