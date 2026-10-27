# Web Analyzer (v0.17, Experimental Preview)

The Web Analyzer is a thin web layer over the existing repo-radar engine. You enter a public GitHub repository
(`owner/repo` or `https://github.com/owner/repo`, optionally a ref), watch a job progress, and read the same report the CLI
produces. There is **no second analyzer**: the server calls the same analysis function as `repo-radar analyze`, and the JSON
you download is that report, unchanged.

It is an Experimental Preview. Calibration labels have not been independently human-reviewed (Gate 14 remains manual), and
the output is a set of observed indicators, not a safety verdict. There is **no official hosted instance** at this time; see
[deployment.md](./deployment.md) to run your own.

## Architecture

```
browser (static ES modules, textContent-only rendering)
   |  HTTP, same origin, /api/v1/*
   v
src/web server (node:http)  -- validation, rate limit, queue, TTL job store, security headers
   |  worker_threads (terminated on timeout, memory-capped)
   v
analyzeRepository  (the unchanged engine)
   |
   v
GitHub API / raw host, OSV, package registries (allowlisted by the engine)
```

The GitHub token exists only on the server and is handed to the worker as worker data. It is never sent to the browser and
never logged.

## API v1

"v1" is the version of this HTTP API. It is independent of the repo-radar product version and does **not** mean 1.0 of
anything. The report schema (0.16) and methodology (0.4) are unchanged by the web layer.

| Method and path | Purpose | Success | Notes |
| --- | --- | --- | --- |
| `POST /api/v1/analyze` | Start a job | `202 {job_id, state: "queued", poll_url}` | Body is JSON, `Content-Type: application/json`, keys `repository` (required) and `ref` (optional) only |
| `GET /api/v1/jobs/{id}` | Job status and, when finished, the report | `200` | `id` is 22 characters of `[A-Za-z0-9_-]` |
| `GET /api/v1/jobs/{id}/report` | The report as a download | `200` JSON with `Content-Disposition: attachment` | `409 JOB_NOT_READY` while queued or running |
| `GET /api/v1/health` | Liveness | `200 {ok, version, api}` | `version` is read from `package.json` at runtime |
| `GET /api/v1/ready` | Readiness | `200 {ok, queue_depth, running}` | `503` in production when no token is configured |

The job object has `job_id, state, created_at, started_at, finished_at, queue_position, stage, repository, analyzed_sha,
error, report`. The exact analyzed commit is `report.analysis_manifest.commit`; the download filename is
`repo-radar-<owner>-<repo>-<first 12 of SHA>.json`.

### Job states

| State | Meaning |
| --- | --- |
| `queued` | Waiting for a worker slot (FIFO) |
| `running` | A worker thread is analyzing; `stage` names the current phase |
| `completed` | A report exists and no completeness signal below was raised |
| `partial` | A report exists but the engine reported incomplete evidence |
| `failed` | No report; `error.code` explains why |
| `expired` | Past the TTL; the job and report are gone (`404 JOB_NOT_FOUND`) |

### How `partial` is derived

`classifyReport` in `src/web/classify.ts` reads structured fields of the real report only (it never searches text). A report
is `partial` when any of these holds:

- `retrieval.complete === false`, `retrieval.github_truncated === true`, `retrieval.stopped_by` is set and not `complete`, or
  `retrieval.failed_requests > 0`;
- any diagnostic has level `warn` or `error`, or a code matching `rate_limited`, `scan_limit` or `budget` (info-level "nothing
  published" diagnostics do not count);
- `code_analysis.scan.limits_hit` is non-empty;
- `dependency_registry_intel.coverage.failed` or `.skipped` is above zero, or the status of `dependency_registry_intel` or
  `registry_intel` is one of `unavailable, failed, rate_limited, partial, error, timeout`, or `registry_intel.limits_hit` is
  non-empty;
- `dependency_intel.vulnerability_lookup.state` is one of those bad states.

Otherwise the job is `completed`. `partial` is a statement about evidence coverage, not about quality.

### Errors

Every error is `{"error": {"code": "...", "message": "..."}}` with a stable `code`.

| Code | HTTP | When |
| --- | --- | --- |
| `INVALID_REPOSITORY` | 400 | Input is not `owner/repo` or an exact `https://github.com/owner/repo` URL |
| `INVALID_REF` | 400 | Ref fails the allowlist (characters, `..`, leading `-` or `/`, `//`, trailing `/` or `.lock`) |
| `INVALID_BODY` | 400, 413, 415 | Not JSON, wrong content type, unknown keys, or body above `REQUEST_BODY_LIMIT` |
| `REPOSITORY_NOT_FOUND` | job `failed` | Repository missing or not publicly accessible |
| `RATE_LIMITED` | 429 | Per-client limit; `Retry-After` is set |
| `QUEUE_FULL` | 503 | Queue at `MAX_QUEUE`; `Retry-After: 5` |
| `ANALYSIS_TIMEOUT` | job `failed` | Exceeded `ANALYSIS_TIMEOUT_SECONDS`; the worker is terminated |
| `UPSTREAM_UNAVAILABLE` | job `failed` | GitHub or another source was unavailable or rate limited |
| `REPORT_TOO_LARGE` | job `failed` | Report exceeded `MAX_REPORT_BYTES` |
| `JOB_NOT_FOUND` | 404 | Unknown, malformed or expired job id |
| `JOB_NOT_READY` | 409 | Report requested before the job finished |
| `METHOD_NOT_ALLOWED` | 405 | Known route, wrong method; `Allow` is set |
| `NOT_FOUND` | 404 | Unknown route under `/api/` |
| `INTERNAL_ERROR` | 500 | Unexpected server error (no details leaked) |

### Headers

Every response carries a strict Content-Security-Policy (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'
data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy:
same-origin`, and an empty `Permissions-Policy`. API responses add `Cache-Control: no-store` and `X-Robots-Tag: noindex,
nofollow`. No CORS headers are sent.

## Run locally

```
npm ci
npm run build
cp .env.example .env     # optional; then edit. Never commit real secrets.
npm run web:dev          # builds, then serves on http://127.0.0.1:8787
```

Export `GITHUB_TOKEN` in your shell for realistic rate limits; without it the engine uses unauthenticated GitHub access,
which is very limited. In `NODE_ENV=production` the server refuses to start without a token.

## Configuration

Read by `src/web/config.ts`. Out-of-range values fail at startup.

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | none | n/a | Server-side GitHub token (read-only, public data). Required when `NODE_ENV=production` |
| `PORT` | 8787 | 0-65535 | Listen port |
| `HOST` | 127.0.0.1 | any | Listen address |
| `JOB_TTL_SECONDS` | 1800 | 60-86400 | How long a job and its report stay available |
| `MAX_CONCURRENCY` | 2 | 1-8 | Simultaneous worker threads |
| `MAX_QUEUE` | 20 | 0-200 | Maximum queued plus running jobs; beyond it `QUEUE_FULL` |
| `RATE_LIMIT_PER_MINUTE` | 6 | 1-120 | Accepted analyze requests per client per minute |
| `RATE_LIMIT_HOURLY` | 40 | 1-1000 | Accepted analyze requests per client per hour |
| `ANALYSIS_TIMEOUT_SECONDS` | 300 | 30-1800 | Hard per-job limit |
| `MAX_REPORT_BYTES` | 26214400 | 1-104857600 | Largest report kept |
| `TRUST_PROXY` | false | true/false | Use the last `X-Forwarded-For` entry as client address |
| `REQUEST_BODY_LIMIT` | 4096 | 1-4096 | Maximum request body in bytes |
| `NODE_ENV` | development | any | `production` enforces the token |
| `WORKER_MAX_OLD_SPACE_MB` | 512 | 64-4096 | V8 old-space cap per worker |
| `MAX_STORED_JOBS` | 200 | 1-10000 | Upper bound on jobs held in memory |

## Privacy

- No telemetry, analytics, cookies, accounts or third-party requests from the page.
- Jobs and reports live in server memory only and disappear at the TTL or on restart. There is no database and no permalink.
- Operational logs are JSON lines on stdout: one `listening` line at startup and one `job_finished` line per job with the job
  id, final state, duration in milliseconds and, for failures, the error code. They contain no tokens, repository names,
  client addresses or report contents, and there is no access log.
- Only public repositories are analyzed. There is no private-repository authentication in the web version.

## What the page shows

Score, confidence and evidence coverage are three separate numbers and are never merged. Unknown and partial states are
shown as such. The page does not call a repository "safe" or "clean"; zero findings is displayed as "no findings were
produced by the rules that ran", with the coverage next to it. Compliance content is indicative only.

Sections: overview (repository, exact analyzed SHA, analysis time, versions), score, confidence, coverage (overall and per
dimension), findings with an evidence drawer, dependencies, releases and provenance, capabilities, governance, compliance,
technical details, and a JSON download.

## What the web version does not do

Private repositories, history analysis by default (off), permalinks or stored results, accounts, monitoring or scheduled
re-analysis, crawling, new detectors, or any scoring change.

## CLI parity

The worker (`src/web/worker.ts`) calls `analyzeRepository` with only the token, the optional ref and a stage callback, so every
other option takes the engine default; the server stores and serves the report object unmodified. What is enforced by tests:
the stage callback does not change the report (`tests/unit/web-stage.test.ts`), the served and downloaded JSON equals the
stored report, and the exact SHA and filename come from the report (`tests/unit/web-parity.test.ts`,
`tests/unit/web-api.test.ts`, and the browser test in `tests/e2e/web.spec.ts`). What is **not** proven by a unit test: that the
CLI's default flags are identical to the engine defaults. That was checked by comparing real runs of the CLI and the web on the
same commit; the result is recorded in the release notes for the version that includes it.

## Security

See the Web Analyzer section of [security-model.md](./security-model.md).
