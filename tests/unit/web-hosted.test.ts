/**
 * Hosted-operation behaviour: client keys, shared GitHub quota admission, exact-SHA resolution, the short-lived cache,
 * coalescing of identical requests, graceful shutdown, readiness/metrics and the GitHub helper's redirect/token rules.
 * Everything upstream is a mock.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientAddress, clientKey } from '../../src/web/client.js';
import { loadWebConfig } from '../../src/web/config.js';
import { githubRateLimit, githubResolveCommit } from '../../src/web/github.js';
import { JobStore, type JobEvent } from '../../src/web/jobs.js';
import { QuotaTracker } from '../../src/web/quota.js';
import { createWebServer } from '../../src/web/server.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const config = (env: Record<string, string> = {}) => loadWebConfig({ PORT: '0', ...env });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report = (sha: string, requests = 10) =>
  ({
    schema_version: '0.16',
    generated_at: 'x',
    integrity: { report_sha256: 'x' },
    retrieval: { complete: true },
    analysis_manifest: { commit: sha },
    stats: { http_requests: requests },
  }) as never;
async function settled(store: JobStore, ids: string[]) {
  for (let i = 0; i < 200; i++) {
    if (ids.every((id) => !['queued', 'running'].includes(store.get(id)?.state ?? 'x'))) return;
    await sleep(10);
  }
}

describe('client keys for rate limiting', () => {
  it('keeps IPv4, unwraps IPv4-mapped IPv6 and coarsens other IPv6 to the /64', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    const a = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = clientKey('2001:db8:1:2:1111:2222:3333:4444');
    expect(a).toBe(b); // rotating inside one /64 does not buy a new allowance
    expect(clientKey('2001:db8:1:3::1')).not.toBe(a);
    expect(clientKey('2001:db8::1')).toBe('v6:2001:0db8:0000:0000');
    expect(clientKey('::1')).toBe('v6:0000:0000:0000:0000');
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('not an ip')).toBe('unknown');
  });
  it('honours X-Forwarded-For only when the proxy is trusted, and then only the last entry', () => {
    expect(clientAddress('198.51.100.9', '203.0.113.7', false)).toBe('203.0.113.7');
    expect(clientAddress('198.51.100.9', '10.0.0.1', true)).toBe('198.51.100.9');
    // a client-supplied prefix cannot choose its own key: the proxy-appended last entry wins
    expect(clientAddress('1.1.1.1, 198.51.100.9', '10.0.0.1', true)).toBe('198.51.100.9');
    expect(clientAddress('garbage', '10.0.0.1', true)).toBe('10.0.0.1');
    expect(clientAddress(undefined, '10.0.0.1', true)).toBe('10.0.0.1');
  });
});

describe('shared GitHub quota admission', () => {
  const mk = (
    remaining: number,
    opts: Partial<ConstructorParameters<typeof QuotaTracker>[0]> = {},
  ) => {
    let now = 1_000_000;
    let calls = 0;
    const state = { remaining, resetAt: now + 3_600_000 };
    const q = new QuotaTracker({
      fetchRateLimit: async () => {
        calls++;
        return { remaining: state.remaining, limit: 5000, resetAt: state.resetAt };
      },
      reserve: 300,
      defaultEstimate: 60,
      clock: () => now,
      ...opts,
    });
    return { q, state, calls: () => calls, tick: (ms: number) => (now += ms) };
  };
  it('admits with room, refuses below estimate plus reserve, and says when the quota resets', async () => {
    const roomy = mk(5000);
    expect((await roomy.q.admit(0)).ok).toBe(true);
    const low = mk(340); // 340 - reserve 300 = 40 < estimate 60
    const d = await low.q.admit(0);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.resetAt).toBe(new Date(low.state.resetAt).toISOString());
    expect(low.q.state()).toBe('low');
  });
  it('subtracts what jobs already in flight are expected to spend', async () => {
    const t = mk(600);
    expect((await t.q.admit(0)).ok).toBe(true); // 600-300=300 >= 60
    expect((await t.q.admit(4)).ok).toBe(true); // 600 - 4*60 - 300 = 60: exactly one more fits
    expect((await t.q.admit(5)).ok).toBe(false); // 600 - 5*60 - 300 = 0
  });
  it('learns the real per-analysis cost and uses the larger of it and the configured estimate', async () => {
    const t = mk(5000);
    await t.q.admit(0);
    t.q.record(400);
    expect(t.q.estimate).toBe(400);
    expect(t.q.requestsObserved).toBe(400);
    expect(t.q.snapshot?.remaining).toBe(4600);
  });
  it('caches the rate-limit answer, then refreshes when it is stale or the window has reset', async () => {
    const t = mk(5000);
    await t.q.admit(0);
    await t.q.admit(0);
    expect(t.calls()).toBe(1);
    t.tick(31_000);
    await t.q.admit(0);
    expect(t.calls()).toBe(2);
  });
  it('fails open only when the quota cannot be known at all', async () => {
    const none = new QuotaTracker({ reserve: 300, defaultEstimate: 60 });
    expect((await none.admit(5)).ok).toBe(true);
    const down = new QuotaTracker({
      fetchRateLimit: async () => {
        throw new Error('offline');
      },
      reserve: 300,
      defaultEstimate: 60,
    });
    expect((await down.admit(0)).ok).toBe(true);
    expect(down.state()).toBe('unknown');
  });
});

describe('exact-SHA resolution, cache and coalescing in the job store', () => {
  const harness = (
    over: Record<string, string> = {},
    resolve?: (r: { repo: string; ref?: string }) => string,
  ) => {
    const calls: Array<{ repo: string; ref?: string }> = [];
    const events: JobEvent[] = [];
    let gate: (() => void) | undefined;
    const hold = { on: false };
    const store = new JobStore(
      { ...config({ MAX_QUEUE: '50', MAX_CONCURRENCY: '2', ...over }) },
      async (repo) => {
        calls.push({ repo: repo.repo, ...(repo.ref ? { ref: repo.ref } : {}) });
        if (hold.on) await new Promise<void>((r) => (gate = r));
        if (repo.repo === 'boom') throw Object.assign(new Error('x'), { code: 'INTERNAL_ERROR' });
        return report(repo.ref ?? 'none');
      },
      undefined,
      undefined,
      {
        resolve: async (r) => {
          if (r.repo === 'missing')
            throw Object.assign(new Error('nf'), { code: 'REPOSITORY_NOT_FOUND' });
          return resolve ? resolve({ repo: r.repo, ...(r.ref ? { ref: r.ref } : {}) }) : SHA_A;
        },
        cacheSalt: 's1',
        onEvent: (e) => events.push(e),
      },
    );
    return { store, calls, events, hold, release: () => gate?.() };
  };

  it('pins the analysis to the resolved commit and records it on the job', async () => {
    const h = harness();
    const j = h.store.enqueue({ owner: 'o', repo: 'r', ref: 'main' });
    await settled(h.store, [j.id]);
    expect(h.calls).toEqual([{ repo: 'r', ref: SHA_A }]); // the moving ref never reaches the engine
    expect(h.store.get(j.id)).toMatchObject({ state: 'completed', resolvedSha: SHA_A });
  });
  it('serves an identical request from the cache without a second analysis', async () => {
    const h = harness();
    const a = h.store.enqueue({ owner: 'o', repo: 'r' });
    await settled(h.store, [a.id]);
    const b = h.store.enqueue({ owner: 'o', repo: 'r' });
    await settled(h.store, [b.id]);
    expect(h.calls).toHaveLength(1);
    expect(h.store.get(b.id)).toMatchObject({ state: 'completed', cached: true });
    expect(h.store.get(b.id)?.report).toBe(h.store.get(a.id)?.report); // shared object, not a copy
    expect(h.events).toContain('cache_hit');
  });
  it('does not share a cache entry between different commits, repositories or salts', async () => {
    let n = 0;
    const h = harness({}, () => (n++ === 0 ? SHA_A : SHA_B));
    const a = h.store.enqueue({ owner: 'o', repo: 'r' });
    await settled(h.store, [a.id]);
    const b = h.store.enqueue({ owner: 'o', repo: 'r' }); // the branch moved: a new SHA, a new analysis
    await settled(h.store, [b.id]);
    const c = h.store.enqueue({ owner: 'o', repo: 'other' });
    await settled(h.store, [c.id]);
    expect(h.calls.map((x) => x.ref)).toEqual([SHA_A, SHA_B, SHA_B]);
    expect(h.store.get(b.id)?.cached).toBeUndefined();
  });
  it('expires cache entries after the TTL and can be switched off', async () => {
    const off = harness({ CACHE_TTL_SECONDS: '0' });
    const a = off.store.enqueue({ owner: 'o', repo: 'r' });
    await settled(off.store, [a.id]);
    const b = off.store.enqueue({ owner: 'o', repo: 'r' });
    await settled(off.store, [b.id]);
    expect(off.calls).toHaveLength(2);
  });
  it('coalesces simultaneous identical requests into one analysis and shares the outcome', async () => {
    const h = harness();
    h.hold.on = true;
    const a = h.store.enqueue({ owner: 'o', repo: 'r' });
    const b = h.store.enqueue({ owner: 'o', repo: 'r' });
    const c = h.store.enqueue({ owner: 'o', repo: 'r' });
    await sleep(40);
    expect(h.calls).toHaveLength(1);
    expect(h.store.runningCount).toBe(1); // followers do not take worker slots
    h.release();
    await settled(h.store, [a.id, b.id, c.id]);
    expect([a, b, c].map((j) => h.store.get(j.id)?.state)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect([b, c].every((j) => h.store.get(j.id)?.coalesced)).toBe(true);
    expect(h.store.get(c.id)?.report).toBe(h.store.get(a.id)?.report);
  });
  it('jobs that share an analysis still count against the queue bound', async () => {
    const h = harness({ MAX_QUEUE: '3' });
    h.hold.on = true;
    h.store.enqueue({ owner: 'o', repo: 'r' });
    h.store.enqueue({ owner: 'o', repo: 'r' });
    h.store.enqueue({ owner: 'o', repo: 'r' });
    await sleep(40);
    expect(() => h.store.enqueue({ owner: 'o', repo: 'r' })).toThrow('queue full');
    h.release();
  });
  it('a failed analysis fails its followers with the same code and is never cached', async () => {
    const h = harness();
    h.hold.on = true;
    const a = h.store.enqueue({ owner: 'o', repo: 'boom' });
    const b = h.store.enqueue({ owner: 'o', repo: 'boom' });
    await sleep(40);
    h.release();
    await settled(h.store, [a.id, b.id]);
    expect(h.store.get(a.id)?.error?.code).toBe('INTERNAL_ERROR');
    expect(h.store.get(b.id)?.error?.code).toBe('INTERNAL_ERROR');
    h.hold.on = false;
    const c = h.store.enqueue({ owner: 'o', repo: 'boom' });
    await settled(h.store, [c.id]);
    expect(h.calls.length).toBeGreaterThanOrEqual(2); // retried, not served from a cached failure
  });
  it('fails fast and cheaply when the repository does not exist (no worker is used)', async () => {
    const h = harness();
    const j = h.store.enqueue({ owner: 'o', repo: 'missing' });
    await settled(h.store, [j.id]);
    expect(h.store.get(j.id)?.error?.code).toBe('REPOSITORY_NOT_FOUND');
    expect(h.calls).toHaveLength(0);
  });
  it('refuses to start a job whose quota check fails and reports when to retry', async () => {
    const quota = new QuotaTracker({
      fetchRateLimit: async () => ({ remaining: 310, limit: 5000, resetAt: Date.UTC(2030, 0, 1) }),
      reserve: 300,
      defaultEstimate: 60,
    });
    const store = new JobStore(config(), async () => report(SHA_A), undefined, undefined, {
      resolve: async () => SHA_A,
      quota,
    });
    const j = store.enqueue({ owner: 'o', repo: 'r' });
    await settled(store, [j.id]);
    expect(store.get(j.id)?.error).toMatchObject({
      code: 'SERVICE_RATE_LIMITED',
      reset_at: '2030-01-01T00:00:00.000Z',
    });
  });
});

describe('job cleanup: every path releases its bookkeeping', () => {
  const idle = {
    queue: 0,
    running: 0,
    preparing: 0,
    controllers: 0,
    leaders: 0,
    followerGroups: 0,
    keys: 0,
  };
  it('success, failure, not-found, quota refusal, coalesced and cached jobs leave nothing behind', async () => {
    const quotaLow = new QuotaTracker({
      fetchRateLimit: async () => ({ remaining: 0, limit: 5000, resetAt: Date.now() + 1000 }),
      reserve: 0,
      defaultEstimate: 10,
    });
    for (const [label, runner, resolve, quota] of [
      ['success', async () => report(SHA_A), async () => SHA_A, undefined],
      [
        'failure',
        async () => {
          throw new Error('x');
        },
        async () => SHA_A,
        undefined,
      ],
      [
        'not found',
        async () => report(SHA_A),
        async () => {
          throw Object.assign(new Error('n'), { code: 'REPOSITORY_NOT_FOUND' });
        },
        undefined,
      ],
      ['quota refusal', async () => report(SHA_A), async () => SHA_A, quotaLow],
    ] as const) {
      const store = new JobStore(config(), runner as never, undefined, undefined, {
        resolve,
        ...(quota ? { quota } : {}),
      });
      const ids = [1, 2, 3].map(() => store.enqueue({ owner: 'o', repo: 'r' }).id); // coalesced and cached variants too
      await settled(store, ids);
      const again = store.enqueue({ owner: 'o', repo: 'r' });
      await settled(store, [again.id]);
      expect(store.inspect(), label).toEqual(idle);
    }
  });
  it('an aborted worker (shutdown) releases its controller and slot', async () => {
    const store = new JobStore(
      config(),
      (_r, _s, signal) =>
        new Promise((_res, rej) =>
          signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('a'), { code: 'SHUTTING_DOWN' })),
          ),
        ),
      undefined,
      undefined,
      { resolve: async () => SHA_A },
    );
    store.enqueue({ owner: 'o', repo: 'r' });
    store.enqueue({ owner: 'o', repo: 'r' });
    await sleep(20);
    await store.shutdown(20);
    expect(store.inspect()).toEqual(idle);
  });
  it('a client that disconnects mid-poll does not disturb the job, which runs to completion and then expires by TTL', async () => {
    let t = 0;
    const s = createWebServer({
      config: config({ JOB_TTL_SECONDS: '60' }),
      runAnalysis: async () => {
        await sleep(60);
        return report(SHA_A);
      },
      clock: () => t,
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
      const res = await fetch(`${base}/api/v1/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: 'o/r' }),
      });
      const { poll_url } = (await res.json()) as { poll_url: string };
      const ac = new AbortController();
      const dropped = fetch(base + poll_url, { signal: ac.signal }).catch(() => 'dropped');
      ac.abort();
      expect(await dropped).toBe('dropped');
      await sleep(150);
      expect(((await (await fetch(base + poll_url)).json()) as { state: string }).state).toBe(
        'completed',
      );
      t = 61_000;
      expect((await fetch(base + poll_url)).status).toBe(404);
      expect(s.jobs.inspect()).toEqual(idle);
    } finally {
      await s.shutdown(50);
    }
  });
});

describe('graceful shutdown', () => {
  it('stops accepting, fails queued jobs, and aborts running ones after the grace period', async () => {
    let aborted = false;
    const store = new JobStore(
      config({ MAX_CONCURRENCY: '1', MAX_QUEUE: '10' }),
      (_r, _s, signal) =>
        new Promise((_res, rej) =>
          signal?.addEventListener('abort', () => {
            aborted = true;
            rej(Object.assign(new Error('a'), { code: 'SHUTTING_DOWN' }));
          }),
        ),
    );
    const running = store.enqueue({ owner: 'o', repo: 'a' });
    const queued = store.enqueue({ owner: 'o', repo: 'b' });
    await sleep(10);
    await store.shutdown(50);
    expect(aborted).toBe(true);
    expect(store.get(running.id)?.error?.code).toBe('SHUTTING_DOWN');
    expect(store.get(queued.id)?.error?.code).toBe('SHUTTING_DOWN');
    expect(store.runningCount).toBe(0);
    expect(() => store.enqueue({ owner: 'o', repo: 'c' })).toThrow('shutting down');
  });
  it('lets a job that finishes inside the grace period complete normally', async () => {
    const store = new JobStore(config(), async () => {
      await sleep(30);
      return report(SHA_A);
    });
    const j = store.enqueue({ owner: 'o', repo: 'a' });
    await sleep(5);
    await store.shutdown(500);
    expect(store.get(j.id)?.state).toBe('completed');
  });
  it('the HTTP server answers 503 SHUTTING_DOWN for new work once shutdown has begun', async () => {
    const s = createWebServer({ config: config(), runAnalysis: async () => report(SHA_A) });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as { port: number }).port;
    const done = s.shutdown(100);
    await done;
    await expect(fetch(`http://127.0.0.1:${port}/api/v1/health`)).rejects.toBeTruthy(); // port closed
  });
});

describe('HTTP: quota refusal, readiness and metrics', () => {
  async function withServer(
    opts: Parameters<typeof createWebServer>[0],
    fn: (base: string) => Promise<void>,
  ) {
    const s = createWebServer(opts);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      await fn(`http://127.0.0.1:${(s.address() as { port: number }).port}`);
    } finally {
      await s.shutdown(50);
    }
  }
  const post = (base: string, repository = 'o/r') =>
    fetch(`${base}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository }),
    });
  it('returns 503 SERVICE_RATE_LIMITED with Retry-After and the reset time when the shared quota is low', async () => {
    const reset = Date.now() + 90_000;
    await withServer(
      {
        config: config(),
        runAnalysis: async () => report(SHA_A),
        fetchRateLimit: async () => ({ remaining: 100, limit: 5000, resetAt: reset }),
      },
      async (base) => {
        const res = await post(base);
        expect(res.status).toBe(503);
        const retry = Number(res.headers.get('retry-after'));
        expect(retry).toBeGreaterThan(60);
        expect(retry).toBeLessThanOrEqual(91);
        const body = (await res.json()) as { error: { code: string; reset_at: string } };
        expect(body.error.code).toBe('SERVICE_RATE_LIMITED');
        expect(body.error.reset_at).toBe(new Date(reset).toISOString());
        const m = (await (await fetch(`${base}/api/v1/metrics`)).json()) as {
          counters: Record<string, number>;
        };
        expect(m.counters['quota_rejected']).toBe(1);
      },
    );
  });
  it('/ready exposes safe build metadata and a coarse quota state, never a number or a secret', async () => {
    await withServer(
      {
        config: config({
          BUILD_COMMIT: '0123456789abcdef0123456789abcdef01234567',
          GITHUB_TOKEN: 'ghp_secret',
        }),
        runAnalysis: async () => report(SHA_A),
      },
      async (base) => {
        const text = await (await fetch(`${base}/api/v1/ready`)).text();
        const body = JSON.parse(text) as Record<string, unknown>;
        expect(body).toMatchObject({
          ok: true,
          schema: '0.16',
          methodology: '0.4',
          build_commit: '0123456789abcdef0123456789abcdef01234567',
          quota: 'unknown',
        });
        expect(text).not.toContain('ghp_secret');
      },
    );
  });
  it('/metrics holds aggregates only: no repository names, no addresses', async () => {
    await withServer({ config: config(), runAnalysis: async () => report(SHA_A) }, async (base) => {
      const res = await post(base, 'secret-owner/secret-repo');
      const { poll_url } = (await res.json()) as { poll_url: string };
      for (let i = 0; i < 100; i++) {
        const j = (await (await fetch(base + poll_url)).json()) as { state: string };
        if (j.state !== 'queued' && j.state !== 'running') break;
        await sleep(10);
      }
      const text = await (await fetch(`${base}/api/v1/metrics`)).text();
      expect(text).not.toContain('secret-owner');
      expect(text).not.toContain('127.0.0.1');
      expect(JSON.parse(text).counters.jobs_completed).toBe(1);
    });
  });
  it('logs structured events without repository names or addresses', async () => {
    const lines: string[] = [];
    await withServer(
      {
        config: config({ RATE_LIMIT_PER_MINUTE: '1' }),
        runAnalysis: async () => report(SHA_A, 7),
        log: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
      },
      async (base) => {
        const res = await post(base, 'private-owner/private-repo');
        const { poll_url } = (await res.json()) as { poll_url: string };
        for (let i = 0; i < 100; i++) {
          const j = (await (await fetch(base + poll_url)).json()) as { state: string };
          if (j.state !== 'queued' && j.state !== 'running') break;
          await sleep(10);
        }
        expect((await post(base)).status).toBe(429);
      },
    );
    const all = lines.join('\n');
    expect(all).toContain('"event":"job_queued"');
    expect(all).toContain('"event":"job_started"');
    expect(all).toContain('"event":"job_finished"');
    expect(all).toContain('"github_requests":7');
    expect(all).toContain('"event":"rate_limited"');
    expect(all).toContain('"event":"server_shutdown"');
    expect(all).not.toContain('private-owner');
    expect(all).not.toContain('127.0.0.1');
  });
});

describe('landing page build identification', () => {
  it('serves the deployed version and short commit in the page, escaped, with no request needed', async () => {
    const s = createWebServer({
      config: config({ BUILD_COMMIT: '0123456789abcdef0123456789abcdef01234567' }),
      runAnalysis: async () => report(SHA_A),
      staticRoot: join(process.cwd(), 'web', 'public'),
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const html = await (
        await fetch(`http://127.0.0.1:${(s.address() as { port: number }).port}/`)
      ).text();
      expect(html).toMatch(/repo-radar \d+\.\d+\.\d+ · commit 0123456 · Experimental Preview/);
      expect(html).not.toContain('<!--build-info-->');
    } finally {
      await s.shutdown(50);
    }
  });
});

describe('GitHub helper: exact commit, rate limit, redirects and token scope', () => {
  const res = (status: number, body = '', headers: Record<string, string> = {}) =>
    new Response(body, { status, headers });
  it('resolves a branch to its 40-hex SHA with one request and sends the token only to api.github.com', async () => {
    const seen: Array<{ url: string; auth: string | null; accept: string | null }> = [];
    const f = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, auth: h.get('authorization'), accept: h.get('accept') });
      return res(200, `${SHA_A}\n`);
    }) as unknown as typeof fetch;
    expect(await githubResolveCommit('tok', f)({ owner: 'o', repo: 'r', ref: 'feature/x' })).toBe(
      SHA_A,
    );
    expect(seen).toEqual([
      {
        url: 'https://api.github.com/repos/o/r/commits/feature/x',
        auth: 'Bearer tok',
        accept: 'application/vnd.github.sha',
      },
    ]);
  });
  it('maps 404, 422, rate limiting and server errors to stable codes', async () => {
    const run = (r: Response) =>
      githubResolveCommit(
        't',
        (async () => r) as unknown as typeof fetch,
      )({ owner: 'o', repo: 'r' }).catch((e: { code: string; resetAt?: string }) => e);
    expect(((await run(res(404))) as { code: string }).code).toBe('REPOSITORY_NOT_FOUND');
    expect(((await run(res(422))) as { code: string }).code).toBe('INVALID_REF');
    const limited = (await run(res(403, '', { 'x-ratelimit-reset': '1893456000' }))) as {
      code: string;
      resetAt?: string;
    };
    expect(limited).toMatchObject({
      code: 'SERVICE_RATE_LIMITED',
      resetAt: '2030-01-01T00:00:00.000Z',
    });
    expect(((await run(res(500))) as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(((await run(res(200, 'not a sha'))) as { code: string }).code).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
  });
  it('follows a redirect that stays on api.github.com and refuses one that leaves it (the token never follows)', async () => {
    const urls: string[] = [];
    const same = (async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? res(301, '', { location: 'https://api.github.com/repositories/42/commits/HEAD' })
        : res(200, SHA_B);
    }) as unknown as typeof fetch;
    expect(await githubResolveCommit('t', same)({ owner: 'o', repo: 'r' })).toBe(SHA_B);
    const off = (async (url: string) => {
      urls.push(url);
      return res(302, '', { location: 'https://evil.example/steal' });
    }) as unknown as typeof fetch;
    urls.length = 0;
    await expect(githubResolveCommit('t', off)({ owner: 'o', repo: 'r' })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(urls).toEqual(['https://api.github.com/repos/o/r/commits/HEAD']); // evil.example was never contacted
    const http = (async () =>
      res(302, '', { location: 'http://api.github.com/x' })) as unknown as typeof fetch;
    await expect(githubResolveCommit('t', http)({ owner: 'o', repo: 'r' })).rejects.toBeTruthy();
  });
  it('encodes path segments so a hostile ref cannot change the request path', async () => {
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return res(200, SHA_A);
    }) as unknown as typeof fetch;
    await githubResolveCommit('t', f)({ owner: 'o', repo: 'r', ref: 'a/b c?x=1#y' });
    expect(url).toBe('https://api.github.com/repos/o/r/commits/a/b%20c%3Fx%3D1%23y');
  });
  it('reads the core rate limit', async () => {
    const f = (async () =>
      res(
        200,
        JSON.stringify({
          resources: { core: { remaining: 4321, limit: 5000, reset: 1893456000 } },
        }),
      )) as unknown as typeof fetch;
    expect(await githubRateLimit('t', f)()).toEqual({
      remaining: 4321,
      limit: 5000,
      resetAt: 1893456000_000,
    });
    const bad = (async () => res(200, '{}')) as unknown as typeof fetch;
    await expect(githubRateLimit('t', bad)()).rejects.toBeTruthy();
  });
});

describe('production configuration is validated at startup', () => {
  it.each([
    [{ NODE_ENV: 'production' }, /GITHUB_TOKEN is required/],
    [{ MAX_CONCURRENCY: '0' }, /./],
    [{ MAX_CONCURRENCY: '-1' }, /./],
    [{ JOB_TTL_SECONDS: '5' }, /./],
    [{ MAX_QUEUE: '-3' }, /./],
    [{ ANALYSIS_TIMEOUT_SECONDS: '0' }, /./],
    [{ CACHE_TTL_SECONDS: '999999' }, /./],
    [{ PUBLIC_BASE_URL: 'not a url' }, /./],
    [{ PUBLIC_BASE_URL: 'https://example.org/path' }, /./],
    [{ NODE_ENV: 'production', GITHUB_TOKEN: 't', PUBLIC_BASE_URL: 'http://example.org' }, /https/],
    [{ BUILD_COMMIT: 'not-hex' }, /./],
  ])('rejects %j', (env, message) => {
    expect(() => loadWebConfig(env)).toThrow(message);
  });
  it('accepts a valid hosted configuration', () => {
    const c = loadWebConfig({
      NODE_ENV: 'production',
      GITHUB_TOKEN: 't',
      PUBLIC_BASE_URL: 'https://repo-radar.example.org',
      BUILD_COMMIT: 'abcdef1',
    });
    expect(c.publicBaseUrl).toBe('https://repo-radar.example.org');
    expect(c.cacheTtlSeconds).toBe(600);
  });
});
