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
    const j = new JobStore(c(), async () => ({ retrieval: { completeness: 'partial' } }) as never);
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
  it('expires and tombstones', () => {
    let t = 0;
    const j = new JobStore(
      c({ jobTtlSeconds: 60 }),
      async () => Promise.resolve(report),
      () => t,
    );
    const x = j.enqueue({ owner: 'o', repo: 'r' });
    t = 61000;
    expect(j.get(x.id)?.state).toBe('expired');
    t = 361001;
    expect(j.get(x.id)).toBeUndefined();
  });
});
