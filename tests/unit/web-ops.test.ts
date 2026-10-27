import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWebServer } from '../../src/web/server.js';
import { JobStore } from '../../src/web/jobs.js';
import { loadWebConfig } from '../../src/web/config.js';

const config = loadWebConfig({ PORT: '0', NODE_ENV: 'development' });
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

describe('web operations', () => {
  it('health reports the package.json version at runtime, not a hard-coded string', async () => {
    const s = createWebServer({ config, runAnalysis: async () => ({}) as never });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const port = (s.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, version: pkg.version, api: 'v1' });
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  it('answers the request after the per-minute limit with 429 and Retry-After over HTTP', async () => {
    const s = createWebServer({
      config: loadWebConfig({ PORT: '0', RATE_LIMIT_PER_MINUTE: '2', MAX_QUEUE: '50' }),
      runAnalysis: async () => ({ retrieval: { complete: true } }) as never,
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const port = (s.address() as { port: number }).port;
      const post = () =>
        fetch(`http://127.0.0.1:${port}/api/v1/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repository: 'o/r' }),
        });
      expect((await post()).status).toBe(202);
      expect((await post()).status).toBe(202);
      const limited = await post();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
        'RATE_LIMITED',
      );
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  it('reports every finished job to the log hook with state and error code only', async () => {
    const seen: Array<{ state: string; code?: string }> = [];
    const store = new JobStore(
      config,
      async (repo) => {
        if (repo.repo === 'missing')
          throw Object.assign(new Error('x'), { code: 'REPOSITORY_NOT_FOUND' });
        return { retrieval: { complete: true } } as never;
      },
      undefined,
      (j) => seen.push({ state: j.state, ...(j.error ? { code: j.error.code } : {}) }),
    );
    store.enqueue({ owner: 'o', repo: 'ok' });
    store.enqueue({ owner: 'o', repo: 'missing' });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([
      { state: 'completed' },
      { state: 'failed', code: 'REPOSITORY_NOT_FOUND' },
    ]);
  });

  it('a throwing log hook never breaks the queue', async () => {
    const store = new JobStore(
      config,
      async () => ({ retrieval: { complete: true } }) as never,
      undefined,
      () => {
        throw new Error('log sink down');
      },
    );
    const a = store.enqueue({ owner: 'o', repo: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.get(a.id)?.state).toBe('completed');
    expect(store.runningCount).toBe(0);
  });
});
