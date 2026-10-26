import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { analyzeRepository } from '../analyze.js';
import { loadWebConfig, type WebConfig } from './config.js';
import { JobStore, type RunAnalysis } from './jobs.js';
import { validateRepository, WebInputError } from './validate.js';
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': '',
};
function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, { ...headers, ...extra });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage, limit: number): Promise<string> {
  let n = 0,
    s = '';
  for await (const c of req) {
    n += Buffer.byteLength(c);
    if (n > limit) throw Object.assign(new Error(), { code: 'TOO_LARGE' });
    s += c;
  }
  return s;
}
export function createWebServer(
  options: { config?: WebConfig; runAnalysis?: RunAnalysis; clock?: () => number } = {},
) {
  const config = options.config ?? loadWebConfig();
  const run =
    options.runAnalysis ??
    (async (r, onStage) =>
      analyzeRepository(`${r.owner}/${r.repo}`, {
        token: config.token,
        ref: r.ref,
        codeScan: true,
        onStage,
      }));
  const store = new JobStore(config, run, options.clock);
  return createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (u.pathname === '/api/v1/health' && req.method === 'GET')
        return json(res, 200, { ok: true, version: '0.17.0', api: 'v1' });
      if (u.pathname === '/api/v1/ready' && req.method === 'GET')
        return json(res, config.nodeEnv === 'production' && !config.token ? 503 : 200, {
          ok: true,
        });
      if (u.pathname === '/api/v1/analyze' && req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json')
          return json(res, 415, {
            error: { code: 'INVALID_BODY', message: 'Content-Type must be application/json' },
          });
        let parsed: unknown;
        try {
          parsed = JSON.parse(await body(req, config.requestBodyLimit));
        } catch (e) {
          return json(res, (e as { code?: string }).code === 'TOO_LARGE' ? 413 : 400, {
            error: {
              code: (e as { code?: string }).code === 'TOO_LARGE' ? 'INVALID_BODY' : 'INVALID_BODY',
              message: 'invalid request body',
            },
          });
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Object.keys(parsed).some((k) => !['repository', 'ref'].includes(k)) ||
          typeof (parsed as { repository?: unknown }).repository !== 'string'
        )
          return json(res, 400, {
            error: { code: 'INVALID_BODY', message: 'invalid request body' },
          });
        const p = parsed as { repository: string; ref?: unknown };
        let repo;
        try {
          repo = validateRepository(p.repository, p.ref);
        } catch (e) {
          const x = e as WebInputError;
          return json(res, 400, { error: { code: x.code, message: x.message } });
        }
        let j;
        try {
          j = store.enqueue(repo);
        } catch {
          return json(
            res,
            503,
            { error: { code: 'QUEUE_FULL', message: 'analysis queue is full' } },
            { 'Retry-After': '5' },
          );
        }
        return json(res, 202, { job_id: j.id, state: j.state, poll_url: `/api/v1/jobs/${j.id}` });
      }
      const m = u.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(\/report)?$/);
      if (m && req.method === 'GET') {
        const j = store.get(m[1]!);
        if (!j || j.state === 'expired')
          return json(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'job not found' } });
        if (m[2] && j.report) {
          const sha =
            (j.report as unknown as { repository?: { commit?: string } }).repository?.commit
              ?.replace(/[^a-f0-9]/gi, '')
              .slice(0, 12) || 'unknown';
          return json(res, 200, j.report, {
            'Content-Disposition': `attachment; filename="repo-radar-${j.repo.owner}-${j.repo.repo}-${sha}.json"`,
          });
        }
        return json(res, 200, {
          job_id: j.id,
          state: j.state,
          created_at: j.createdAt,
          started_at: j.startedAt,
          finished_at: j.finishedAt,
          stage: j.stage,
          repository: j.repo,
          error: j.error,
          report: j.report,
        });
      }
      return json(res, 404, { error: { code: 'JOB_NOT_FOUND', message: 'not found' } });
    } catch {
      json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
  });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = loadWebConfig();
  createWebServer({ config: c }).listen(c.port, c.host, () =>
    console.log(JSON.stringify({ event: 'listening', host: c.host, port: c.port })),
  );
}
