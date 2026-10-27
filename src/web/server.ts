import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { toolVersion } from '../analyze.js';
import { REPORT_SCHEMA_VERSION } from '../report/schema.js';
import { METHODOLOGY_VERSION } from '../scoring/types.js';
import { webAnalysisOptions } from './analysis.js';
import { digestNewReport } from '../report/integrity.js';
import { explainPartial } from './classify.js';
import { clientAddress } from './client.js';
import { loadWebConfig, type WebConfig } from './config.js';
import { responseHeaders } from './headers.js';
import { errorBody, reportFilename, reportSha } from './api.js';
import { githubRateLimit, githubResolveCommit } from './github.js';
import { JobStore, type Job, type JobEvent, type RunAnalysis } from './jobs.js';
import { clientHash } from './log.js';
import { Metrics } from './metrics.js';
import { QuotaTracker, type FetchRateLimit } from './quota.js';
import { RateLimiter } from './ratelimit.js';
import { createWorkerRunner } from './runner.js';
import { serveStatic } from './static.js';
import { validateRepository, WebInputError, type WebRepo } from './validate.js';
function send(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
  api = true,
) {
  res.writeHead(status, {
    ...responseHeaders(api),
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  });
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) {
    req.destroy();
    throw Object.assign(new Error(), { code: 'TOO_LARGE' });
  }
  let n = 0,
    s = '';
  for await (const c of req) {
    n += Buffer.byteLength(c);
    if (n > limit) throw Object.assign(new Error(), { code: 'TOO_LARGE' });
    s += c;
  }
  return s;
}
export type LogFn = (event: string, fields?: Record<string, unknown>) => void;
export type WebServerOptions = {
  config?: WebConfig;
  runAnalysis?: RunAnalysis;
  clock?: () => number;
  staticRoot?: string;
  /** Exact-commit resolution. Defaults to GitHub when no custom runner is injected. */
  resolveCommit?: (repo: WebRepo, signal?: AbortSignal) => Promise<string>;
  /** Shared-quota source. Defaults to GitHub's rate-limit endpoint when a token is configured and no runner is injected. */
  fetchRateLimit?: FetchRateLimit;
  /** Structured operational log sink (events only; never report contents). */
  log?: LogFn;
};
const SECONDS = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
export function createWebServer(options: WebServerOptions = {}) {
  const config = options.config ?? loadWebConfig();
  const run = options.runAnalysis ?? createWorkerRunner(config);
  const log: LogFn = options.log ?? (() => undefined);
  const metrics = new Metrics();
  const real = !options.runAnalysis;
  const fetchRateLimit =
    options.fetchRateLimit ?? (real && config.token ? githubRateLimit(config.token) : undefined);
  const quota = new QuotaTracker({
    fetchRateLimit,
    reserve: config.quotaReserve,
    defaultEstimate: config.estimatedRequestsPerJob,
  });
  const resolve = options.resolveCommit ?? (real ? githubResolveCommit(config.token) : undefined);
  const cacheSalt = `${toolVersion()}|${digestNewReport(webAnalysisOptions({}))}`;
  const onEvent = (event: JobEvent, job: Job, fields?: Record<string, unknown>) => {
    metrics.inc(event);
    const base = { job_id: job.id };
    if (event === 'job_finished') {
      const started = job.startedAt ?? job.createdAt;
      const duration = (job.finishedAt ?? started) - started;
      metrics.inc(`jobs_${job.state}`);
      if (job.error) metrics.inc(`errors_${job.error.code}`);
      if (job.startedAt) metrics.observeDuration(duration);
      const requests = (job.report as unknown as { stats?: { http_requests?: number } } | undefined)
        ?.stats?.http_requests;
      log(job.state === 'failed' ? 'job_failed' : 'job_finished', {
        ...base,
        state: job.state,
        duration_ms: duration,
        ...(job.error ? { error_code: job.error.code } : {}),
        ...(typeof requests === 'number' ? { github_requests: requests } : {}),
        ...(job.cached ? { cached: true } : {}),
        ...(job.coalesced ? { coalesced: true } : {}),
      });
    } else log(event, { ...base, ...fields });
  };
  const jobs = new JobStore(config, run, options.clock, undefined, {
    ...(resolve ? { resolve } : {}),
    quota,
    cacheSalt,
    onEvent,
  });
  const limits = new RateLimiter(
    config.rateLimitPerMinute,
    config.rateLimitHourly,
    10000,
    options.clock ?? (() => Date.now()),
  );
  const root = options.staticRoot ?? join(dirname(fileURLToPath(import.meta.url)), 'public');
  const gauges = () => ({
    queue_depth: jobs.queueDepth,
    running: jobs.runningCount,
    stored_jobs: jobs.size,
    cache_entries: jobs.cacheSize,
    quota_state: quota.state(),
    github_requests_observed: quota.requestsObserved,
    estimated_requests_per_job: quota.estimate,
  });
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (u.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && u.pathname === '/api/v1/health')
          return send(res, 200, { ok: true, version: toolVersion(), api: 'v1' });
        if (req.method === 'GET' && u.pathname === '/api/v1/ready') {
          const ready = !(config.nodeEnv === 'production' && !config.token);
          return send(res, ready ? 200 : 503, {
            ok: ready,
            version: toolVersion(),
            schema: REPORT_SCHEMA_VERSION,
            methodology: METHODOLOGY_VERSION,
            ...(config.buildCommit ? { build_commit: config.buildCommit } : {}),
            queue_depth: jobs.queueDepth,
            running: jobs.runningCount,
            quota: quota.state(),
          });
        }
        if (req.method === 'GET' && u.pathname === '/api/v1/metrics')
          return send(res, 200, metrics.snapshot(gauges()));
        if (u.pathname === '/api/v1/analyze' && req.method === 'POST') {
          const who = clientAddress(
            req.headers['x-forwarded-for'],
            req.socket.remoteAddress,
            config.trustProxy,
          );
          const rate = limits.check(who);
          if (!rate.allowed) {
            metrics.inc('rate_limited');
            log('rate_limited', { client: clientHash(who) });
            return send(res, 429, errorBody('RATE_LIMITED', 'rate limit exceeded'), {
              'Retry-After': String(rate.retryAfter),
            });
          }
          if (req.headers['content-type']?.split(';')[0] !== 'application/json')
            return send(
              res,
              415,
              errorBody('INVALID_BODY', 'Content-Type must be application/json'),
            );
          let p: unknown;
          try {
            p = JSON.parse(await readBody(req, config.requestBodyLimit));
          } catch (e) {
            return send(
              res,
              (e as { code?: string }).code === 'TOO_LARGE' ? 413 : 400,
              errorBody('INVALID_BODY', 'invalid request body'),
            );
          }
          if (
            !p ||
            typeof p !== 'object' ||
            Object.keys(p).some((k) => !['repository', 'ref'].includes(k)) ||
            typeof (p as { repository?: unknown }).repository !== 'string'
          )
            return send(res, 400, errorBody('INVALID_BODY', 'invalid request body'));
          let repo;
          try {
            repo = validateRepository(
              (p as { repository: string }).repository,
              (p as { ref?: unknown }).ref,
            );
          } catch (e) {
            const x = e as WebInputError;
            return send(res, 400, errorBody(x.code, x.message));
          }
          // Shared GitHub budget: do not queue a job that the token cannot pay for.
          const admission = await quota.admit(jobs.inFlight);
          if (!admission.ok) {
            metrics.inc('quota_rejected');
            log('quota_low', { remaining: admission.remaining, reset_at: admission.resetAt });
            const wait = SECONDS(Date.parse(admission.resetAt) - Date.now());
            return send(
              res,
              503,
              {
                error: {
                  code: 'SERVICE_RATE_LIMITED',
                  message: 'the hosted analyzer is temporarily rate-limited',
                  reset_at: admission.resetAt,
                },
              },
              { 'Retry-After': String(Math.min(wait, 3600)) },
            );
          }
          try {
            const j = jobs.enqueue(repo);
            return send(res, 202, {
              job_id: j.id,
              state: 'queued',
              poll_url: `/api/v1/jobs/${j.id}`,
            });
          } catch (e) {
            if ((e as { code?: string }).code === 'SHUTTING_DOWN')
              return send(res, 503, errorBody('SHUTTING_DOWN', 'the server is shutting down'), {
                'Retry-After': '10',
              });
            return send(res, 503, errorBody('QUEUE_FULL', 'analysis queue is full'), {
              'Retry-After': '5',
            });
          }
        }
        const m = u.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(\/report)?$/);
        if (m && req.method === 'GET') {
          if (!/^[A-Za-z0-9_-]{22}$/.test(m[1]!))
            return send(res, 404, errorBody('JOB_NOT_FOUND', 'job not found'));
          const j = jobs.get(m[1]!);
          if (!j || j.state === 'expired')
            return send(res, 404, errorBody('JOB_NOT_FOUND', 'job not found'));
          if (m[2] && !j.report && ['queued', 'running'].includes(j.state))
            return send(res, 409, {
              error: { code: 'JOB_NOT_READY', message: 'job is not finished', state: j.state },
            });
          if (m[2] && j.report) {
            return send(res, 200, j.report, {
              'Content-Disposition': `attachment; filename="${reportFilename(j.repo.owner, j.repo.repo, reportSha(j.report))}"`,
            });
          }
          return send(res, 200, {
            job_id: j.id,
            state: j.state,
            created_at: j.createdAt,
            started_at: j.startedAt,
            finished_at: j.finishedAt,
            queue_position: jobs.queuePosition(j.id),
            stage: j.stage,
            repository: j.repo,
            analyzed_sha: j.analyzedSha,
            ...(j.resolvedSha ? { resolved_sha: j.resolvedSha } : {}),
            ...(j.cached ? { cached: true } : {}),
            ...(j.coalesced ? { coalesced: true } : {}),
            ...(j.state === 'partial' && j.report
              ? { partial_reasons: explainPartial(j.report) }
              : {}),
            error: j.error,
            report: j.report,
          });
        }
        // a known route used with the wrong method is 405 (with Allow); anything else under /api/ is 404 whatever the method
        const allow =
          u.pathname === '/api/v1/analyze'
            ? 'POST'
            : u.pathname === '/api/v1/health' ||
                u.pathname === '/api/v1/ready' ||
                u.pathname === '/api/v1/metrics' ||
                /^\/api\/v1\/jobs\/[^/]+(\/report)?$/.test(u.pathname)
              ? 'GET'
              : undefined;
        if (allow)
          return send(res, 405, errorBody('METHOD_NOT_ALLOWED', 'method not allowed'), {
            Allow: allow,
          });
        return send(res, 404, errorBody('NOT_FOUND', 'not found'));
      }
      if (req.method !== 'GET')
        return send(
          res,
          405,
          errorBody('METHOD_NOT_ALLOWED', 'method not allowed'),
          { Allow: 'GET' },
          false,
        );
      if (await serveStatic(root, u.pathname, res)) return;
      return send(res, 404, errorBody('JOB_NOT_FOUND', 'not found'), {}, false);
    } catch (e) {
      if ((e as { code?: string }).code === 'TOO_LARGE')
        return send(res, 413, errorBody('INVALID_BODY', 'request body too large'));
      return send(res, 500, errorBody('INTERNAL_ERROR', 'internal error'));
    }
  });
  server.maxHeadersCount = 100;
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  /**
   * Graceful stop: refuse new connections and new jobs, give running jobs `graceMs` to finish, then terminate the workers
   * that are left and close what remains. Safe to call once.
   */
  const shutdown = async (graceMs = config.shutdownGraceSeconds * 1000): Promise<void> => {
    log('server_shutdown', { grace_ms: graceMs });
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeIdleConnections();
    await jobs.shutdown(graceMs);
    server.closeAllConnections();
    await closed;
  };
  return Object.assign(server, { shutdown, jobs, metrics });
}
const consoleLog: LogFn = (event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const c = loadWebConfig();
  const s = createWebServer({ config: c, log: consoleLog });
  s.listen(c.port, c.host, () =>
    consoleLog('server_start', {
      host: c.host,
      port: (s.address() as { port: number }).port,
      version: toolVersion(),
      ...(c.buildCommit ? { build_commit: c.buildCommit } : {}),
    }),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void s.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
