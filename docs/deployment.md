# Deploying the Web Analyzer

**No official hosted instance is deployed yet.** This page is for people who want to run their own. Nothing here is a
promise that a public instance exists or will exist.

## Runtime

- Node.js 20.17 or newer (the CI matrix covers 20 and 22).
- Build once with `npm ci && npm run build`; start with `node dist/web/server.js` (`npm run web:start`).
- One process holds all jobs in memory. Do not run several replicas behind a load balancer expecting shared jobs: a poll that
  lands on another replica gets `404 JOB_NOT_FOUND`. Use one instance, or sticky routing by client.

## Required production configuration

| Setting | Requirement |
| --- | --- |
| `NODE_ENV=production` | Makes the server refuse to start without `GITHUB_TOKEN` and makes `/api/v1/ready` return 503 if it is missing |
| `GITHUB_TOKEN` | A token that can read **public** data only (a fine-grained token with no repository permissions, or a classic token with no scopes). Never a token with write or private access. It is used server-side and passed to workers; it is never sent to browsers or logged |
| `HOST` / `PORT` | Defaults are `127.0.0.1:8787`. Bind `0.0.0.0` only inside a container or behind a proxy |

Provide the token through your platform's secret store or an environment variable at run time. Do not bake it into an image,
commit it, or pass it as a build argument. See `.env.example` for every variable.

## Sizing

- `MAX_CONCURRENCY` (default 2) is the number of simultaneous worker threads. Each worker is capped at
  `WORKER_MAX_OLD_SPACE_MB` (default 512 MB) of V8 old space, so budget roughly `MAX_CONCURRENCY x WORKER_MAX_OLD_SPACE_MB`
  plus the main process and native overhead. Start with at least 2 GB for the defaults.
- Reports are kept in memory until `JOB_TTL_SECONDS` (default 1800). The worst case held is
  `MAX_STORED_JOBS x MAX_REPORT_BYTES` (200 x 25 MB by default), which is far more than a small host has; lower
  `MAX_STORED_JOBS` or `MAX_REPORT_BYTES` on small machines. Typical reports are much smaller than the cap.
- `ANALYSIS_TIMEOUT_SECONDS` (default 300) terminates a worker; large repositories may need more, small hosts less.
- `MAX_QUEUE` bounds queued plus running jobs; extra requests receive `503 QUEUE_FULL` with `Retry-After`.

## Reverse proxy

The server speaks plain HTTP. Terminate TLS at a proxy and add HSTS there (the server does not send it, because it cannot know
it is behind HTTPS).

Rate limiting is per client address. Behind a proxy, every request appears to come from the proxy unless you set
`TRUST_PROXY=true`, which makes the server use the **last** entry of `X-Forwarded-For`. Set it only when exactly one trusted
proxy that you control appends the client address; with any other topology, or when the server is reachable directly, a client
can forge the header and evade or poison the limits, so leave it `false`. The default is `false`.

Pass the proxy's own timeouts at least as high as the 30-second request timeout; analyses are polled, not held open.

## Health, readiness, shutdown, logs

- `GET /api/v1/health` is liveness (also reports the package version). `GET /api/v1/ready` is readiness and returns the queue
  depth and running count.
- `SIGTERM` and `SIGINT` close the listener and exit. In-flight jobs are not drained; their results are lost (they are
  ephemeral by design), so deploy during a quiet period.
- Logs are JSON lines on stdout: `listening` and one `job_finished` per job (job id, state, duration, error code). Send stdout to
  your log collector. There is no access log and no client address in logs.

## GitHub rate-limit budget

The server token has one GitHub budget (5000 REST requests per hour for an authenticated user token) shared by **all** users of
the instance. Each analysis spends some number of requests, reported in the report's technical details ("HTTP requests"). The
budget therefore allows about `5000 / requests-per-analysis` analyses per hour across everyone, regardless of the per-client
limits. Measure requests-per-analysis on your own mix of repositories before choosing limits: the per-client default of 40 per
hour is generous for a single user and not a protection for the shared token. When GitHub rate limits an analysis, the job
finishes `partial` or `failed` with `UPSTREAM_UNAVAILABLE` or `RATE_LIMITED` rather than waiting. If you expect public traffic,
lower `RATE_LIMIT_HOURLY` and `MAX_CONCURRENCY`, and consider a dedicated token for the instance.

## Docker

```
docker build -t repo-radar-web .
docker run --rm -p 127.0.0.1:8787:8787 -e GITHUB_TOKEN -e NODE_ENV=production repo-radar-web
```

`-e GITHUB_TOKEN` with no value forwards it from your shell without writing it into the command line or the image. The image
runs as a non-root user, listens on `0.0.0.0:8787` inside the container, and has a `HEALTHCHECK` on `/api/v1/health`. Publish
the port to loopback (as above) or to a proxy, not directly to the internet.

## Before you expose it

1. Read the Web Analyzer section of [security-model.md](./security-model.md).
2. Put it behind TLS and decide on `TRUST_PROXY` as described above.
3. Choose `RATE_LIMIT_*`, `MAX_CONCURRENCY` and `MAX_QUEUE` for your GitHub budget.
4. State publicly that results are indicators from an Experimental Preview, not a safety verdict.

## Operating notes (0.18)

- **Still no official hosted instance.** No platform was chosen; do not publish a URL for this project until one is deployed and smoke-tested.
- Set `BUILD_COMMIT` (short or full hex SHA) and `PUBLIC_BASE_URL` (https origin) through the platform; both are validated at startup.
- **Quota:** keep `QUOTA_RESERVE` above what other jobs on the same token may need; admission uses GitHub's own remaining-quota figure. `/api/v1/ready` reports only `unknown`, `ok` or `low`.
- **Shutdown:** give the platform a termination grace period longer than `SHUTDOWN_GRACE_SECONDS` (default 20 s); running jobs that do not finish in time fail with `SHUTTING_DOWN`.
- **Rollback:** deploy the previous image by its immutable tag or digest and check `/api/v1/ready` for the expected version and `build_commit`. Jobs are not durable, so a rollback or restart discards them by design.
- **Token rotation:** replace the `GITHUB_TOKEN` secret on the platform and restart; no rebuild is needed.
- **Cost guard:** `MAX_CONCURRENCY`, `WORKER_MAX_OLD_SPACE_MB`, `MAX_STORED_JOBS` and `MAX_REPORT_BYTES` bound memory; there is no uptime or response-time promise.
