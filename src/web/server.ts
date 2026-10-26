import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { loadWebConfig, type WebConfig } from './config.js';
import { responseHeaders } from './headers.js';
import { errorBody, reportFilename, reportSha } from './api.js';
import { JobStore, type RunAnalysis } from './jobs.js';
import { RateLimiter } from './ratelimit.js';
import { createWorkerRunner } from './runner.js';
import { serveStatic } from './static.js';
import { validateRepository, WebInputError } from './validate.js';
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
function client(req: IncomingMessage, config: WebConfig): string {
  if (config.trustProxy) {
    const x = req.headers['x-forwarded-for'];
    if (typeof x === 'string') return x.split(',').at(-1)!.trim();
  }
  return req.socket.remoteAddress ?? `unaddressed-${req.headers['user-agent'] ?? 'unknown'}`;
}
export function createWebServer(
  options: {
    config?: WebConfig;
    runAnalysis?: RunAnalysis;
    clock?: () => number;
    staticRoot?: string;
  } = {},
) {
  const config = options.config ?? loadWebConfig();
  const run = options.runAnalysis ?? createWorkerRunner(config);
  const jobs = new JobStore(config, run, options.clock);
  const limits = new RateLimiter(
    config.rateLimitPerMinute,
    config.rateLimitHourly,
    10000,
    options.clock ?? (() => Date.now()),
  );
  const root = options.staticRoot ?? join(dirname(fileURLToPath(import.meta.url)), 'public');
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (u.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && u.pathname === '/api/v1/health')
          return send(res, 200, { ok: true, version: '0.17.0', api: 'v1' });
        if (req.method === 'GET' && u.pathname === '/api/v1/ready')
          return send(res, config.nodeEnv === 'production' && !config.token ? 503 : 200, {
            ok: true,
            queue_depth: jobs.queueDepth,
            running: jobs.runningCount,
          });
        if (u.pathname === '/api/v1/analyze' && req.method === 'POST') {
          const rate = limits.check(client(req, config));
          if (!rate.allowed)
            return send(res, 429, errorBody('RATE_LIMITED', 'rate limit exceeded'), {
              'Retry-After': String(rate.retryAfter),
            });
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
          try {
            const j = jobs.enqueue(repo);
            return send(res, 202, {
              job_id: j.id,
              state: 'queued',
              poll_url: `/api/v1/jobs/${j.id}`,
            });
          } catch {
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
  return server;
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const c = loadWebConfig();
  const s = createWebServer({ config: c });
  s.listen(c.port, c.host, () =>
    console.log(
      JSON.stringify({
        event: 'listening',
        host: c.host,
        port: (s.address() as { port: number }).port,
      }),
    ),
  );
  const close = () => s.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
