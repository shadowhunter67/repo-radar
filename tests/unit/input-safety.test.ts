/* eslint-disable no-control-regex -- tests deliberately assert on control characters */
import { describe, expect, it, vi } from 'vitest';
import {
  HttpClient,
  HttpError,
  RateLimitError,
  TooLargeError,
  type FetchLike,
} from '../../src/util/http.js';
import { parseRepoRef, RepoRefError } from '../../src/util/repo-ref.js';
import { redactSecrets, sanitizeForTerminal } from '../../src/util/text.js';

describe('parseRepoRef', () => {
  it.each([
    ['owner/repo', 'owner', 'repo'],
    ['  owner/repo  ', 'owner', 'repo'],
    ['https://github.com/owner/repo', 'owner', 'repo'],
    ['https://github.com/owner/repo.git', 'owner', 'repo'],
    ['https://github.com/owner/repo/tree/main/src', 'owner', 'repo'],
    ['https://github.com/owner/repo/', 'owner', 'repo'],
    ['a-b/c.d_e-f', 'a-b', 'c.d_e-f'],
  ])('accepts %s', (input, owner, repo) => {
    expect(parseRepoRef(input)).toEqual({ owner, repo });
  });

  it.each([
    '',
    'owner',
    'owner/repo/extra',
    '../etc/passwd',
    'owner/..',
    'owner/.',
    '/owner/repo',
    '-owner/repo',
    'own er/repo',
    'owner/re po',
    'owner/repo?x=1',
    'owner/repo#frag',
    'owner/repo%2f..',
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com.evil.com/owner/repo',
    'https://evil.com/github.com/owner/repo',
    'https://user:pass@github.com/owner/repo',
    'https://github.com@evil.com/owner/repo',
    'https://github.com/owner',
    'https://github.com/owner/repo/other-thing',
    'https://github.com/owner/repo/.git',
    'git@github.com:owner/repo.git',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'owner\\repo',
    'a'.repeat(40) + '/repo',
    'owner/' + 'r'.repeat(101),
  ])('rejects %j', (input) => {
    expect(() => parseRepoRef(input)).toThrow(RepoRefError);
  });
});

describe('parseRepoRef URL semantics', () => {
  it('resolves dot segments exactly like a browser would (the analyzed repo is the one the URL points at)', () => {
    expect(parseRepoRef('https://github.com/owner/repo/../other')).toEqual({
      owner: 'owner',
      repo: 'other',
    });
  });
});

describe('HttpClient', () => {
  const ok = (body = '{}', headers: Record<string, string> = {}): Response =>
    new Response(body, { status: 200, headers });
  const client = (f: FetchLike, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) =>
    new HttpClient({
      fetch: f,
      allowedHosts: ['api.github.com', 'raw.githubusercontent.com'],
      authHosts: ['api.github.com'],
      retryDelayMs: 0,
      ...extra,
    });

  it('refuses hosts outside the allowlist and non-https URLs without making a request', async () => {
    const f = vi.fn(async () => ok());
    const c = client(f);
    await expect(c.request('https://evil.example/x')).rejects.toThrow(/non-allowlisted/);
    await expect(c.request('http://api.github.com/x')).rejects.toThrow(/non-allowlisted/);
    await expect(c.request('https://api.github.com.evil.example/x')).rejects.toThrow(
      /non-allowlisted/,
    );
    await expect(c.request('https://169.254.169.254/latest')).rejects.toThrow(/non-allowlisted/);
    expect(f).not.toHaveBeenCalled();
  });

  it('never follows redirects off the allowlist (SSRF guard) but follows allowlisted ones', async () => {
    const off = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/meta' } }),
    );
    await expect(client(off).request('https://api.github.com/x')).rejects.toThrow(
      /refusing redirect/,
    );
    expect(off).toHaveBeenCalledTimes(1);

    let n = 0;
    const hop: FetchLike = async (u) =>
      n++ === 0
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://raw.githubusercontent.com/a' },
          })
        : ok(u);
    expect((await client(hop).request('https://api.github.com/x')).body).toBe(
      'https://raw.githubusercontent.com/a',
    );
  });

  it('bounds redirect chains', async () => {
    const loop: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: 'https://api.github.com/again' } });
    await expect(client(loop).request('https://api.github.com/x')).rejects.toThrow(
      /unfollowable redirect/,
    );
  });

  it('sends the token only to authHosts', async () => {
    const seen: Record<string, string | undefined> = {};
    const f: FetchLike = async (u, init) => {
      seen[new URL(u).host] = (init?.headers as Record<string, string>)['Authorization'];
      return ok();
    };
    const c = client(f, { token: 'secret-token' });
    await c.request('https://api.github.com/a');
    await c.request('https://raw.githubusercontent.com/a');
    expect(seen['api.github.com']).toBe('Bearer secret-token');
    expect(seen['raw.githubusercontent.com']).toBeUndefined();
  });

  it('caps response size by declared length and by streamed bytes', async () => {
    const declared = client(async () => ok('x', { 'content-length': '999999' }));
    await expect(
      declared.request('https://api.github.com/a', { maxBytes: 100 }),
    ).rejects.toBeInstanceOf(TooLargeError);
    const streamed = client(async () => ok('y'.repeat(5000)));
    await expect(
      streamed.request('https://api.github.com/a', { maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(TooLargeError);
    expect(
      (await streamed.request('https://api.github.com/a', { maxBytes: 10_000 })).body.length,
    ).toBe(5000);
  });

  it('detects rate limiting (403 with remaining=0, and 429)', async () => {
    const limited = client(
      async () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
        }),
    );
    const e = await limited.request('https://api.github.com/a').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).resetAt?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
    await expect(
      client(async () => new Response('{}', { status: 429 })).request('https://api.github.com/a'),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('a plain 403 (not rate limited) is returned as a status, not thrown', async () => {
    const r = await client(
      async () =>
        new Response('forbidden', { status: 403, headers: { 'x-ratelimit-remaining': '42' } }),
    ).request('https://api.github.com/a');
    expect(r.status).toBe(403);
  });

  it('retries once on 5xx and on network errors, then fails', async () => {
    let calls = 0;
    const flaky: FetchLike = async () =>
      calls++ === 0 ? new Response('x', { status: 503 }) : ok('fine');
    expect((await client(flaky).request('https://api.github.com/a')).body).toBe('fine');
    const dead = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(client(dead).request('https://api.github.com/a')).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(dead).toHaveBeenCalledTimes(2);
  });

  it('caps bodies even when the runtime exposes no stream', async () => {
    const noStream = {
      status: 200,
      headers: new Headers(),
      body: null,
      text: async () => 'z'.repeat(5000),
    } as unknown as Response;
    const c = client(async () => noStream);
    await expect(c.request('https://api.github.com/a', { maxBytes: 1000 })).rejects.toBeInstanceOf(
      TooLargeError,
    );
  });

  it('scrubs an arbitrary-format token value from network errors', async () => {
    const odd = 'not-a-github-shaped-secret-123';
    const f: FetchLike = async () => {
      throw new Error(`connect failed with ${odd}`);
    };
    const e = await client(f, { token: odd })
      .request('https://api.github.com/a')
      .catch((x: Error) => x);
    expect((e as Error).message).not.toContain(odd);
  });

  it('error messages never contain the token', async () => {
    const f: FetchLike = async () => {
      throw new Error('boom with ghp_' + 'z'.repeat(36));
    };
    const e = await client(f, { token: 'ghp_' + 'z'.repeat(36) })
      .request('https://api.github.com/a')
      .catch((x: Error) => x);
    expect((e as Error).message).not.toContain('zzzz');
    expect((e as Error).message).toContain('[REDACTED]');
  });
});

describe('text utilities', () => {
  it('sanitizeForTerminal removes ANSI/OSC/control/bidi characters and collapses whitespace', () => {
    const evil = 'ok\u001b[2J\u001b[31mred\u001b[0m\u001b]0;title\u0007 a\u0000b‮rtl\n\n  x';
    const s = sanitizeForTerminal(evil);
    expect(s).toBe('okred ab rtl x'.replace('ab rtl', 'abrtl'));
    expect(s).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
  });
  it('truncates long strings', () => {
    expect(sanitizeForTerminal('a'.repeat(500), 50).length).toBe(50);
  });
  it('redactSecrets scrubs common GitHub token shapes and bearer headers', () => {
    const s = redactSecrets(
      't=ghp_' +
        'a'.repeat(36) +
        ' u=github_pat_' +
        'B'.repeat(30) +
        ' h=Bearer abcdefghijklmnopqrstuvwxyz',
    );
    expect(s).not.toMatch(/ghp_a|github_pat_B|abcdefghijklmnop/);
    expect(s.match(/\[REDACTED\]/g)?.length).toBe(3);
  });
});
