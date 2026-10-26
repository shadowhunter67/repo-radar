import { describe, expect, it } from 'vitest';
import { loadWebConfig } from '../../src/web/config.js';
describe('web config', () => {
  it('defaults', () => {
    const c = loadWebConfig({});
    expect(c.port).toBe(8787);
    expect(c.host).toBe('127.0.0.1');
    expect(c.maxConcurrency).toBe(2);
  });
  it('reads limits', () => {
    const c = loadWebConfig({
      PORT: '9000',
      MAX_QUEUE: '4',
      JOB_TTL_SECONDS: '60',
      MAX_CONCURRENCY: '1',
      RATE_LIMIT_PER_MINUTE: '2',
      RATE_LIMIT_HOURLY: '3',
      ANALYSIS_TIMEOUT_SECONDS: '30',
      MAX_REPORT_BYTES: '1000',
      NODE_ENV: 'development',
    });
    expect(c).toMatchObject({
      port: 9000,
      maxQueue: 4,
      jobTtlSeconds: 60,
      maxConcurrency: 1,
      rateLimitPerMinute: 2,
    });
  });
  it('fails production without token', () =>
    expect(() => loadWebConfig({ NODE_ENV: 'production' })).toThrow('GITHUB_TOKEN'));
});
describe('web config limits', () => {
  it('allows port zero for ephemeral startup', () =>
    expect(loadWebConfig({ PORT: '0' }).port).toBe(0));
  it('reads proxy flag', () =>
    expect(loadWebConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true));
  it('reads worker cap', () =>
    expect(loadWebConfig({ WORKER_MAX_OLD_SPACE_MB: '256' }).workerMaxOldSpaceMb).toBe(256));
  it('reads stored-job cap', () =>
    expect(loadWebConfig({ MAX_STORED_JOBS: '7' }).maxStoredJobs).toBe(7));
  it('rejects bad concurrency', () =>
    expect(() => loadWebConfig({ MAX_CONCURRENCY: '0' })).toThrow());
});
