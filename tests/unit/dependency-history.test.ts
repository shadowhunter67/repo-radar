import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/util/http.js';
import { collectDependencyHistory, traceManifestHistory } from '../../src/history/dependency.js';
import type { Dependency } from '../../src/deps/model.js';

const dep = (path = 'package.json'): Dependency => ({
  id: 'npm:widget',
  package: { ecosystem: 'npm', name: 'widget' },
  relationship: 'runtime',
  direct: true,
  resolution: 'resolved',
  other_versions: [],
  context: 'primary',
  manifest_path: path,
  vulnerability: { state: 'not_checked', advisory_ids: [] },
  derived_from: ['manifest:package.json'],
  confidence: 1,
});

function client(responses: Record<string, unknown>) {
  return new HttpClient({
    allowedHosts: ['api.github.com'],
    fetch: async (url) => {
      const key = new URL(url).pathname + new URL(url).search;
      const body =
        responses[key] ??
        (key.includes('/commits?')
          ? responses['/commits']
          : key.includes('ref=aaaaaaaa')
            ? responses['/contents/a']
            : key.includes('ref=bbbbbbbb')
              ? responses['/contents/b']
              : undefined);
      return new Response(body === undefined ? 'not found' : JSON.stringify(body), {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

describe('dependency history collection', () => {
  it('finds the first reachable path appearance and preserves author/committer roles', async () => {
    const commits = [
      {
        sha: 'b'.repeat(40),
        commit: {
          author: { name: 'Author', date: '2024-01-02T00:00:00Z' },
          committer: { name: 'Committer', date: '2024-01-02T00:00:00Z' },
        },
        author: { login: 'author-login' },
        committer: { login: 'committer-login' },
        parents: [{ sha: 'a'.repeat(40) }],
      },
      {
        sha: 'a'.repeat(40),
        commit: {
          author: { name: 'Old', date: '2023-01-01T00:00:00Z' },
          committer: { name: 'OldCommitter', date: '2023-01-01T00:00:00Z' },
        },
        parents: [],
      },
    ];
    const result = await collectDependencyHistory({
      http: client({
        '/commits': commits,
        '/contents/a': {
          encoding: 'base64',
          sha: '1'.repeat(40),
          content: Buffer.from('{"dependencies":{}}').toString('base64'),
        },
        '/contents/b': {
          encoding: 'base64',
          sha: '2'.repeat(40),
          content: Buffer.from('{"dependencies":{"widget":"1.0.0"}}').toString('base64'),
        },
      }),
      owner: 'o',
      repo: 'r',
      ref: 'main',
      dependencies: [dep()],
      manifests: [],
      locks: [],
    });
    expect(result.entries[0]!).toMatchObject({
      introduction: 'known',
      author: 'author-login',
      committer: 'committer-login',
      history_status: 'history_partial',
    });
    expect(result.entries[0]!.introduced_at?.commit_sha).toBe('b'.repeat(40));
  });

  it('does not query unsafe manifest paths and reports unknown', async () => {
    const result = await collectDependencyHistory({
      http: client({}),
      owner: 'o',
      repo: 'r',
      ref: 'main',
      dependencies: [dep('../package.json')],
      manifests: [],
      locks: [],
    });
    expect(result.entries[0]!.introduction).toBe('unknown');
    expect(result.entries[0]!.history_status).toBe('history_unavailable');
    expect(result.entries[0]!.introduction_commit_uncertain).toBe(true);
  });

  it('stops at the request budget instead of silently continuing', async () => {
    const result = await collectDependencyHistory({
      http: client({}),
      owner: 'o',
      repo: 'r',
      ref: 'main',
      dependencies: [dep()],
      manifests: [],
      locks: [],
      budget: { maxRequests: 0 },
    });
    expect(result.entries[0]!.history_status).toBe('history_budget_exhausted');
    expect(result.coverage.uncertain).toBe(1);
  });

  it('uses paginated history and parent-diff reads with bounded requests', async () => {
    const calls: string[] = [];
    const commits = Array.from({ length: 8 }, (_, i) => ({
      sha: String(i + 1).repeat(40).slice(0, 40),
      commit: {
        author: { name: 'a', date: `2024-01-0${i + 1}T00:00:00Z` },
        committer: { name: 'c', date: `2024-01-0${i + 1}T00:00:00Z` },
      },
      parents: i ? [{ sha: String(i).repeat(40).slice(0, 40) }] : [],
    }));
    const http = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async (url) => {
        calls.push(url);
        const u = new URL(url);
        if (u.pathname.endsWith('/commits'))
          return new Response(JSON.stringify([...commits].reverse()), { status: 200 });
        const sha = u.searchParams.get('ref') ?? '';
        const present = ['5', '6', '7', '8'].some((prefix) => sha.startsWith(prefix));
        return new Response(
          JSON.stringify({
            encoding: 'base64',
            sha: 'a'.repeat(40),
            content: Buffer.from(
              present ? '{"dependencies":{"widget":"1"}}' : '{}',
            ).toString('base64'),
          }),
          { status: 200 },
        );
      },
    });
    const result = await collectDependencyHistory({
      http,
      owner: 'o',
      repo: 'r',
      ref: 'main',
      dependencies: [dep()],
      manifests: [],
      locks: [],
      budget: { maxCommits: 8 },
    });
    expect(result.entries[0]!.introduction).toBe('known');
    expect(calls.filter((x) => x.includes('/contents/')).length).toBe(8);
    expect(result.entries[0]!.author).toBe('a');
    expect(result.entries[0]!.committer).toBe('c');
    expect(result.entries[0]!.evidence_ids.join(' ')).not.toContain('responsible');
  });

  it('keeps one-line oscillation events without monotonic assumptions', async () => {
    const sha = (n: number) => n.toString(16).padStart(40, '0');
    const present = new Set([3, 4, 7]);
    const commits = Array.from({ length: 7 }, (_, i) => ({
      sha: sha(i + 1),
      commit: { author: { name: 'a', date: `2024-02-0${i + 1}T00:00:00Z` }, committer: { name: 'c', date: `2024-02-0${i + 1}T00:00:00Z` } },
      parents: i ? [{ sha: sha(i) }] : [],
    })).reverse();
    const http = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/commits')) return new Response(JSON.stringify(commits), { status: 200 });
        if (u.pathname.includes('/commits/')) return new Response(JSON.stringify({ files: [{ status: 'added' }] }), { status: 200 });
        const n = Number.parseInt(u.searchParams.get('ref') ?? '0', 16);
        return new Response(JSON.stringify({ encoding: 'base64', sha: sha(n), content: Buffer.from(present.has(n) ? '{"dependencies":{"widget":"1"}}' : '{"dependencies":{}}').toString('base64') }), { status: 200 });
      },
    });
    const result = await collectDependencyHistory({ http, owner: 'o', repo: 'r', ref: 'main', dependencies: [dep()], manifests: [], locks: [], budget: { maxCommits: 8, maxRequests: 100 } });
    expect(result.entries[0]?.events.map((e) => e.kind)).toEqual(['introduced', 'removed', 'reintroduced']);
    expect(result.entries[0]?.introduced_at?.commit_sha).toBe(sha(3));
  });

  it.each([
    ['rate limit 403', 403, { 'x-ratelimit-remaining': '0' }, 'history_rate_limited'],
    ['rate limit 429', 429, {}, 'history_rate_limited'],
    ['server error', 500, {}, 'history_unavailable'],
  ])('%s on the listing is never an empty complete history', async (_label, status, headers, expected) => {
    const http = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async () => new Response('rate limit', { status, headers }),
    });
    const result = await collectDependencyHistory({ http, owner: 'o', repo: 'r', ref: 'main', dependencies: [dep()], manifests: [], locks: [] });
    expect(result.entries[0]).toMatchObject({ history_status: expected, introduction: 'unknown', events: [] });
    expect(result.entries[0]?.window?.complete).toBe(false);
    expect(result.stats?.request_classes[status === 500 ? 'server_error' : 'rate_limited']).toBeGreaterThan(0);
  });

  it('reproduces the reviewer chalk case: a first-page 403 is unavailable with zero commits', async () => {
    const http = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async () => new Response('API rate limit exceeded', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1890000000' } }),
    });
    const result = await collectDependencyHistory({ http, owner: 'chalk', repo: 'chalk', ref: 'main', dependencies: [dep()], manifests: [], locks: [] });
    expect(result.entries[0]?.history_status).toBe('history_rate_limited');
    expect(result.stats?.commits_scanned).toBe(0);
    expect(result.entries[0]?.events).toEqual([]);
    expect(result.stats?.rate_limit_reset_at).toBe(new Date(1890000000 * 1000).toISOString());
  });

  it('treats malformed listing JSON and network failures as unavailable', async () => {
    for (const [response, cls] of [[new Response('{', { status: 200 }), 'malformed'], [undefined, 'network']] as const) {
      const http = new HttpClient({ allowedHosts: ['api.github.com'], fetch: async () => response ?? Promise.reject(new Error('offline')) });
      const result = await collectDependencyHistory({ http, owner: 'o', repo: 'r', ref: 'main', dependencies: [dep()], manifests: [], locks: [] });
      expect(result.entries[0]?.history_status).toBe('history_unavailable');
      expect(result.stats?.request_classes[cls]).toBeGreaterThan(0);
    }
  });

  it('distinguishes an empty path from a complete scan', async () => {
    const http = new HttpClient({ allowedHosts: ['api.github.com'], fetch: async () => new Response('[]', { status: 200 }) });
    const result = await collectDependencyHistory({ http, owner: 'o', repo: 'r', ref: 'main', dependencies: [dep()], manifests: [], locks: [] });
    expect(result.entries[0]).toMatchObject({ history_status: 'history_unavailable', introduction: 'unknown', path_state: 'path_not_found_at_ref' });
    expect(result.entries[0]?.window?.complete).toBe(false);
  });

  it('reuses the preceding listed commit as the parent without extra parent blob requests', async () => {
    const sha = (n: number) => n.toString(16).padStart(40, '0');
    const commits = [1, 2, 3].map((n) => ({ sha: sha(n), commit: { committer: { date: `2024-01-0${n}T00:00:00Z` } }, parents: n > 1 ? [{ sha: sha(n - 1) }] : [] })).reverse();
    const contentCalls: string[] = [];
    const http = new HttpClient({ allowedHosts: ['api.github.com'], fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/commits')) return new Response(JSON.stringify(commits), { status: 200 });
      if (u.pathname.match(/\/commits\/[0-9a-f]{40}$/)) return new Response('{}', { status: 200 });
      contentCalls.push(url);
      return new Response(JSON.stringify({ encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from('{}').toString('base64') }), { status: 200 });
    } });
    const result = await collectDependencyHistory({ http, owner: 'o', repo: 'r', ref: 'main', dependencies: [dep()], manifests: [], locks: [], budget: { maxCommits: 3 } });
    expect(result.stats?.parent_blob_fetches).toBe(0);
    expect(contentCalls).toHaveLength(3);
  });

  it('treats a known parent-path 404 as absent and introduces dependencies at file creation', async () => {
    const parent = 'p'.repeat(40);
    const created = 'c'.repeat(40);
    const http = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/commits'))
          return new Response(JSON.stringify([{ sha: created, commit: { committer: { date: '2024-01-02T00:00:00Z' } }, parents: [{ sha: parent }] }]), { status: 200 });
        if (u.pathname.endsWith(`/commits/${created}`))
          return new Response(JSON.stringify({ files: [{ status: 'added' }] }), { status: 200 });
        if (u.searchParams.get('ref') === parent)
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('{"dependencies":{"widget":"1"}}').toString('base64') }), { status: 200 });
      },
    });
    const result = await traceManifestHistory({ http, owner: 'o', repo: 'r', ref: 'main', path: 'package.json', names: ['widget'] });
    expect(result.entries[0]).toMatchObject({ history_status: 'history_complete', introduction: 'known', introduced_with_manifest_creation: false });
    expect(result.entries[0]?.events.map((event) => event.kind)).toEqual(['introduced']);
    expect(result.entries[0]?.events[0]?.commit_sha).toBe(created);
    expect(result.entries[0]?.unknown_revisions).toBe(0);
  });

  it('keeps a ref-not-found 404 unknown rather than treating it as an absent parent path', async () => {
    const parent = 'p'.repeat(40);
    const created = 'c'.repeat(40);
    const http = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/commits')) return new Response(JSON.stringify([{ sha: created, commit: { committer: { date: '2024-01-02T00:00:00Z' } }, parents: [{ sha: parent }] }]), { status: 200 });
        if (u.pathname.endsWith(`/commits/${created}`)) return new Response(JSON.stringify({ files: [{ status: 'added' }] }), { status: 200 });
        if (u.searchParams.get('ref') === parent) return new Response(JSON.stringify({ message: 'No commit found for the ref parent' }), { status: 404 });
        return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('{"dependencies":{"widget":"1"}}').toString('base64') }), { status: 200 });
      },
    });
    const result = await traceManifestHistory({ http, owner: 'o', repo: 'r', ref: 'main', path: 'package.json', names: ['widget'] });
    expect(result.entries[0]).toMatchObject({ history_status: 'history_partial', introduction: 'unknown', events: [] });
    expect(result.entries[0]?.unknown_revisions).toBe(1);
  });

  it.each([
    ['pyproject.toml', '[tool.ruff]\nline-length = 88\n', 'urllib3'],
    ['Cargo.toml', '[workspace]\nmembers = ["crate"]\n', 'serde'],
    ['go.mod', 'module example.com/app\n', 'golang.org/x/tools'],
    ['package.json', '{"name":"app"}', 'widget'],
    ['pyproject.toml', '', 'widget'],
  ])('treats valid dependency-free %s as absent at the parent', async (path, parentText, name) => {
    const parent = 'p'.repeat(40);
    const created = 'c'.repeat(40);
    const current = path === 'pyproject.toml' && name === 'urllib3'
      ? '[project]\ndependencies = ["urllib3>=2"]\n'
      : path === 'Cargo.toml'
        ? '[package]\nname = "crate"\n[dependencies]\nserde = "1"\n'
        : path === 'go.mod'
          ? 'module example.com/app\nrequire golang.org/x/tools v1.0.0\n'
          : path === 'package.json'
            ? '{"dependencies":{"widget":"1"}}'
            : '[project]\ndependencies = ["widget"]\n';
    const http = new HttpClient({
      allowedHosts: ['api.github.com'],
      fetch: async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/commits')) return new Response(JSON.stringify([{ sha: created, commit: { committer: { date: '2024-01-02T00:00:00Z' } }, parents: [{ sha: parent }] }]), { status: 200 });
        if (u.pathname.endsWith(`/commits/${created}`)) return new Response(JSON.stringify({ files: [{ status: 'added' }] }), { status: 200 });
        const body = u.searchParams.get('ref') === parent ? parentText : current;
        return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(body).toString('base64') }), { status: 200 });
      },
    });
    const result = await traceManifestHistory({ http, owner: 'o', repo: 'r', ref: 'main', path, names: [name] });
    if (path === 'pyproject.toml' && name === 'urllib3') expect(result.entries[0]).toMatchObject({ history_status: 'history_complete', current_present: true });
    expect(result.entries[0]?.events.map((event) => event.kind)).toEqual(['introduced']);
    expect(result.entries[0]?.introduced_at?.commit_sha).toBe(created);
  });

  it('does not treat invalid TOML or BOM/trailing-comma JSON as absent', async () => {
    for (const [path, parentText, name] of [
      ['pyproject.toml', '[project\nname = "broken"', 'widget'],
      ['package.json', '\uFEFF{"dependencies":{"widget":"1",}}', 'widget'],
    ] as const) {
      const parent = 'p'.repeat(40);
      const created = 'c'.repeat(40);
      const http = new HttpClient({
        allowedHosts: ['api.github.com'],
        fetch: async (url) => {
          const u = new URL(url);
          if (u.pathname.endsWith('/commits')) return new Response(JSON.stringify([{ sha: created, commit: { committer: { date: '2024-01-02T00:00:00Z' } }, parents: [{ sha: parent }] }]), { status: 200 });
          if (u.pathname.endsWith(`/commits/${created}`)) return new Response(JSON.stringify({ files: [{ status: 'added' }] }), { status: 200 });
          const body = u.searchParams.get('ref') === parent ? parentText : '{}';
          return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(body).toString('base64') }), { status: 200 });
        },
      });
      const result = await traceManifestHistory({ http, owner: 'o', repo: 'r', ref: 'main', path, names: [name] });
      expect(result.entries[0]?.events).toEqual([]);
      expect(result.entries[0]?.history_status).toBe('history_partial');
      expect(result.entries[0]?.unknown_revisions).toBeGreaterThan(0);
    }
  });
});
