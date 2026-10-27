import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportFilename } from '../../src/web/api.js';
import { loadWebConfig, type WebConfig } from '../../src/web/config.js';
import { createWebServer } from '../../src/web/server.js';

const cfg: WebConfig = {
  token: undefined,
  port: 0,
  host: '127.0.0.1',
  jobTtlSeconds: 60,
  maxConcurrency: 1,
  maxQueue: 2,
  rateLimitPerMinute: 50,
  rateLimitHourly: 500,
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
};

type Raw = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};
// node:http sends the path exactly as given (fetch would normalise dot segments), so traversal vectors are real
function raw(
  port: number,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    rq.on('error', reject);
    rq.end();
  });
}
async function serve(fn: (port: number) => Promise<void>, c: WebConfig = cfg) {
  const s = createWebServer({
    config: c,
    runAnalysis: async () => ({}) as never,
    staticRoot: join(process.cwd(), 'web', 'public'),
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  try {
    await fn((s.address() as { port: number }).port);
  } finally {
    await new Promise((r) => s.close(r));
  }
}

describe('web security: headers on every kind of response', () => {
  const expected: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  const cases: [string, string][] = [
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/api/v1/health'],
    ['GET', '/api/v1/ready'],
    ['GET', '/api/v1/jobs/AAAAAAAAAAAAAAAAAAAAAA'],
    ['GET', '/api/v1/unknown'],
    ['GET', '/does-not-exist'],
    ['POST', '/'],
    ['DELETE', '/api/v1/analyze'],
  ];
  it.each(cases)('%s %s carries the full security header set and no CORS', async (method, path) => {
    await serve(async (port) => {
      const r = await raw(port, path, method);
      for (const [k, v] of Object.entries(expected))
        expect(r.headers[k], `${method} ${path} ${k}`).toBe(v);
      const csp = String(r.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(r.headers['permissions-policy']).toBe('');
      for (const h of Object.keys(r.headers)) expect(h.startsWith('access-control-')).toBe(false);
    });
  });
  it('API responses are no-store and noindex; a 405 names the allowed method', async () => {
    await serve(async (port) => {
      const ok = await raw(port, '/api/v1/health');
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(String(ok.headers['x-robots-tag'])).toContain('noindex');
      const bad = await raw(port, '/api/v1/analyze', 'GET');
      expect(bad.status).toBe(405);
      expect(bad.headers['allow']).toBe('POST');
      expect(JSON.parse(bad.body).error.code).toBe('METHOD_NOT_ALLOWED');
    });
  });
});

describe('web security: static handler cannot leave its root', () => {
  const hostile = [
    '/../package.json',
    '/%2e%2e/package.json',
    '/%2e%2e%2fpackage.json',
    '/..%5cpackage.json',
    '/%5c..%5cpackage.json',
    '//etc/passwd',
    '/index.html%00.txt',
    '/%00',
    '/..;/package.json',
    '/.git/config',
  ];
  it.each(hostile)('%s is never served', async (path) => {
    await serve(async (port) => {
      const r = await raw(port, path);
      expect([400, 404, 405]).toContain(r.status);
      expect(r.body).not.toContain('"name": "repo-radar"');
      expect(r.body).not.toContain('root:');
    });
  });
  it('serves the app shell', async () => {
    await serve(async (port) => {
      const r = await raw(port, '/');
      expect(r.status).toBe(200);
      expect(String(r.headers['content-type'])).toContain('text/html');
      expect(r.body).toContain('repo-radar');
    });
  });
});

describe('web security: tokens never leak', () => {
  const FAKE = 'ghp_' + 'x'.repeat(36);
  it('a token in config and in an upstream error message appears in no response body, header or job error', async () => {
    const seen: string[] = [];
    const s = createWebServer({
      config: { ...cfg, token: FAKE },
      runAnalysis: async () => {
        throw new Error(`GET https://api.github.com/x?access_token=${FAKE} failed`);
      },
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as { port: number }).port;
    try {
      const post = await fetch(`http://127.0.0.1:${port}/api/v1/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: 'acme/widget' }),
      });
      seen.push(await post.clone().text(), JSON.stringify([...post.headers]));
      const { job_id } = (await post.json()) as { job_id: string };
      let finalText = '';
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/${job_id}`);
        const t = await r.text();
        seen.push(t, JSON.stringify([...r.headers]));
        finalText = t;
        if (JSON.parse(t).state === 'failed') break;
        await new Promise((r2) => setTimeout(r2, 20));
      }
      const final = JSON.parse(finalText);
      expect(final.state).toBe('failed');
      expect(final.error.code).toBe('INTERNAL_ERROR');
      expect(final.error.message).toBe('analysis failed');
      for (const x of seen) {
        expect(x).not.toContain(FAKE);
        expect(x).not.toContain('access_token');
      }
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});

describe('web security: configuration', () => {
  it('TRUST_PROXY=false must not enable proxy trust (the string "false" is not truthy)', () => {
    for (const v of ['false', 'FALSE', '0', 'no', ''])
      expect(
        loadWebConfig({ GITHUB_TOKEN: 'x', TRUST_PROXY: v } as NodeJS.ProcessEnv).trustProxy,
        v,
      ).toBe(false);
    for (const v of ['true', '1', 'TRUE'])
      expect(
        loadWebConfig({ GITHUB_TOKEN: 'x', TRUST_PROXY: v } as NodeJS.ProcessEnv).trustProxy,
        v,
      ).toBe(true);
  });
  it('production without a token fails fast', () => {
    expect(() => loadWebConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /GITHUB_TOKEN is required/,
    );
  });
  it('out-of-range numbers are rejected', () => {
    expect(() => loadWebConfig({ MAX_CONCURRENCY: '99' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadWebConfig({ PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('web security: filename builder', () => {
  it.each([
    ['../bad', 'x\\y', 'zz!!', 'repo-radar-__bad-x_y-unknown.json'],
    ['a/b', 'r', '', 'repo-radar-a_b-r-unknown.json'],
    ['o', 'r', 'a'.repeat(40), 'repo-radar-o-r-' + 'a'.repeat(12) + '.json'],
  ])('%s/%s %s -> %s', (o, r, sha, out) => {
    const name = reportFilename(o, r, sha);
    expect(name).toBe(out);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
  it('control characters, quotes and header-splitting sequences can never survive', () => {
    const name = reportFilename('o', 'r"; x=y\r\nSet-Cookie: a', 'abc');
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toMatch(/[\r\n";: ]/);
  });
});
