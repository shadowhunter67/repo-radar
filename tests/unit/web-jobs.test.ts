import { describe, expect, it } from 'vitest';
import { JobStore } from '../../src/web/jobs.js';
import type { WebConfig } from '../../src/web/config.js';
const c = (x: Partial<WebConfig> = {}): WebConfig => ({
  token: undefined,
  port: 1,
  host: '127.0.0.1',
  jobTtlSeconds: 60,
  maxConcurrency: 1,
  maxQueue: 1,
  rateLimitPerMinute: 6,
  rateLimitHourly: 40,
  analysisTimeoutSeconds: 30,
  maxReportBytes: 100000,
  trustProxy: false,
  requestBodyLimit: 4096,
  nodeEnv: 'development',
  workerMaxOldSpaceMb: 512,
  maxStoredJobs: 200,
  cacheTtlSeconds: 600,
  quotaReserve: 300,
  estimatedRequestsPerJob: 60,
  shutdownGraceSeconds: 20,
  ...x,
});
const report = { retrieval: { completeness: 'complete' } } as never;
describe('web jobs', () => {
  it('runs lifecycle and stage', async () => {
    const stages: string[] = [];
    const j = new JobStore(c(), async (_, s) => {
      stages.push('running');
      s('report_built');
      return report;
    });
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.state).toBe('completed');
    expect(stages).toEqual(['running']);
  });
  it('classifies partial', async () => {
    const j = new JobStore(c(), async () => ({ retrieval: { complete: false } }) as never);
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.state).toBe('partial');
  });
  it('queue full', () => {
    let release = () => {};
    const p = new Promise<never>((r) => {
      release = () => r(undefined as never);
    });
    const j = new JobStore(c(), async () => p);
    j.enqueue({ owner: 'o', repo: 'a' });
    expect(() => j.enqueue({ owner: 'o', repo: 'b' })).toThrow('queue full');
    release();
  });
  it('expires and tombstones a finished job (a job that is still running never expires)', async () => {
    let t = 0;
    const j = new JobStore(
      c({ jobTtlSeconds: 60 }),
      async () => Promise.resolve(report),
      () => t,
    );
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    t = 61000;
    expect(j.get(x.id)?.state).toBe('running');
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.state).toBe('expired');
    t = 361001;
    expect(j.get(x.id)).toBeUndefined();
  });
});
describe('web job failures', () => {
  it('maps internal failure', async () => {
    const j = new JobStore(c(), async () => {
      throw new Error('x');
    });
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.error?.code).toBe('INTERNAL_ERROR');
  });
  it('maps rate limit', async () => {
    const e = Object.assign(new Error(), { code: 'RATE_LIMITED' });
    const j = new JobStore(c(), async () => {
      throw e;
    });
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.error?.code).toBe('RATE_LIMITED');
  });
  it('maps upstream unavailable', async () => {
    const e = Object.assign(new Error(), { code: 'UPSTREAM_UNAVAILABLE' });
    const j = new JobStore(c(), async () => {
      throw e;
    });
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
  it('maps invalid ref', async () => {
    const e = Object.assign(new Error(), { code: 'INVALID_REF' });
    const j = new JobStore(c(), async () => {
      throw e;
    });
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.error?.code).toBe('INVALID_REF');
  });
  it('exposes size', () => expect(new JobStore(c(), async () => report).size).toBe(0));
  it('exposes queue depth', () => expect(new JobStore(c(), async () => report).queueDepth).toBe(0));
  it('exposes running count', () =>
    expect(new JobStore(c(), async () => report).runningCount).toBe(0));
  it('sweep is callable', () => {
    const j = new JobStore(c(), async () => report);
    j.sweep();
    expect(j.size).toBe(0);
  });
  it('ids are base64url length', () => {
    const j = new JobStore(c({ maxQueue: 2 }), async () => new Promise(() => {}));
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    expect(x.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it('report cap error', async () => {
    const j = new JobStore(c({ maxReportBytes: 1 }), async () => report);
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    await new Promise((r) => setTimeout(r, 0));
    expect(j.get(x.id)?.error?.code).toBe('REPORT_TOO_LARGE');
  });
});
