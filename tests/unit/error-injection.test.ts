import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { ReportSchema } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';
import { HttpClient } from '../../src/util/http.js';

const token = 'ghp_' + 'x'.repeat(36);

describe('end-to-end unavailable evidence stays unknown', () => {
  it.each([
    [
      'primary rate limit',
      new Response('{"message":"rate limit"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      }),
    ],
    ['secondary rate limit', new Response('{"message":"secondary rate limit"}', { status: 403 })],
    [
      'retry-after rate limit',
      new Response('busy', { status: 429, headers: { 'retry-after': '1' } }),
    ],
    ['server error', new Response('boom', { status: 500 })],
    ['bad gateway', new Response('boom', { status: 502 })],
  ] as const)('%s is classified as unavailable transport evidence', async (_name, response) => {
    const client = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async () => response,
      retryDelayMs: 0,
    });
    if (
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') ||
      response.status === 429
    ) {
      try {
        await client.request('https://api.github.com/repos/acme/widget');
        expect.fail('rate limit should reject');
      } catch (error) {
        expect(error).toMatchObject({ name: 'RateLimitError' });
      }
    } else {
      const result = await client.request('https://api.github.com/repos/acme/widget');
      expect(result.status).toBe(response.status);
    }
  });

  it('network and timeout failures do not become successful responses', async () => {
    const network = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async () => {
        throw new Error('network down');
      },
      retryDelayMs: 0,
    });
    await expect(network.request('https://api.github.com/repos/acme/widget')).rejects.toThrow(
      /network error/,
    );
    const timeout = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async () => new Promise<Response>(() => {}),
      timeoutMs: 5,
      retryDelayMs: 0,
    });
    await expect(timeout.request('https://api.github.com/repos/acme/widget')).rejects.toThrow(
      /network error/,
    );
  });

  const cases = [
    ['optional GitHub releases', { rateLimited: ['/releases'] }, 'github.releases.has_any'],
    [
      'GitHub scorecard',
      { rateLimited: ['api.securityscorecards.dev'] },
      'scorecard.lookup_complete',
    ],
    ['OSV', { rateLimited: ['api.osv.dev'] }, 'osv.lookup_complete'],
    ['deps.dev', { rateLimited: ['api.deps.dev'] }, 'deps.dev.lookup_complete'],
    ['npm registry', { registryFail: { 'registry.npmjs.org': 500 } }, 'registry.lookup_complete'],
  ] as const;

  it.each(cases)(
    '%s yields a schema-valid report without a clean claim',
    async (_name, changes, fact) => {
      const report = await analyzeRepository('acme/widget', {
        fetch: fakeFetch(
          goodRepo({
            ...changes,
            files: { 'package.json': '{"name":"widget","version":"1.0.0"}' },
          } as Partial<FakeSpec>),
        ),
        clock: fixedClock,
        token,
      });
      expect(ReportSchema.safeParse(report).success).toBe(true);
      expect(report.diagnostics.length).toBeGreaterThan(0);
      expect(report.facts.find((x) => x.id === fact)?.value).not.toBe(true);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toMatch(/https?:\/\/[^" ]*ghp_/);
    },
  );

  it('primary repository rate limiting is a clear non-policy failure', async () => {
    await expect(
      analyzeRepository('acme/widget', {
        fetch: fakeFetch(goodRepo({ rateLimited: ['/repos/acme/widget'] })),
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ name: 'RateLimitError', status: 403 });
  });

  it('truncated trees produce partial retrieval rather than absence', async () => {
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(goodRepo({ treeTruncated: true, treeKeep: 0 })),
      clock: fixedClock,
      targetedTree: false,
    });
    expect(report.retrieval.complete).toBe(false);
    expect(report.diagnostics.some((d) => d.code === 'tree_truncated')).toBe(true);
  });
});
