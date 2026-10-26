import { describe, expect, it } from 'vitest';
import { createWebServer } from '../../src/web/server.js';
import type { WebConfig } from '../../src/web/config.js';
const config = (x: Partial<WebConfig> = {}): WebConfig => ({
  token: undefined,
  port: 0,
  host: '127.0.0.1',
  jobTtlSeconds: 60,
  maxConcurrency: 1,
  maxQueue: 2,
  rateLimitPerMinute: 6,
  rateLimitHourly: 40,
  analysisTimeoutSeconds: 30,
  maxReportBytes: 100000,
  trustProxy: false,
  requestBodyLimit: 100,
  nodeEnv: 'development',
  ...x,
});
const rep = { retrieval: { completeness: 'complete' } } as never;
async function withServer(fn: (base: string) => Promise<void>, c: WebConfig = config()) {
  const s = createWebServer({ config: c, runAnalysis: async () => rep });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const a = s.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${a.port}`);
  } finally {
    await new Promise((r) => s.close(r));
  }
}
describe('web api', () => {
  it('health ready and validation errors', () =>
    withServer(async (b) => {
      let r = await fetch(b + '/api/v1/health');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, version: '0.17.0', api: 'v1' });
      r = await fetch(b + '/api/v1/ready');
      expect(r.status).toBe(200);
      r = await fetch(b + '/api/v1/analyze', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      });
      expect(r.status).toBe(415);
      r = await fetch(b + '/api/v1/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: 'gitlab/o/r' }),
      });
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe('INVALID_REPOSITORY');
    }));
  it('creates and polls a job', () =>
    withServer(async (b) => {
      const r = await fetch(b + '/api/v1/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"repository":"o/r"}',
      });
      expect(r.status).toBe(202);
      const j = (await r.json()) as { job_id: string; state: string };
      expect(j.state).toBe('queued');
      await new Promise((r) => setTimeout(r, 10));
      const p = await fetch(b + '/api/v1/jobs/' + j.job_id);
      expect(p.status).toBe(200);
      expect((await p.json()).report).toBeTruthy();
    }));
  it('unknown job', () =>
    withServer(async (b) => {
      const r = await fetch(b + '/api/v1/jobs/nope');
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe('JOB_NOT_FOUND');
    }));
});
