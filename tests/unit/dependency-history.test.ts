import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/util/http.js';
import { collectDependencyHistory } from '../../src/history/dependency.js';
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
      history_status: 'history_complete',
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
          return new Response(JSON.stringify(commits), { status: 200 });
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
    expect(calls.filter((x) => x.includes('/contents/')).length).toBe(15);
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
        if (u.pathname.endsWith('/commits/' + sha(7))) return new Response(JSON.stringify({ files: [{ status: 'modified' }] }), { status: 200 });
        const n = Number.parseInt(u.searchParams.get('ref') ?? '0', 16);
        return new Response(JSON.stringify({ encoding: 'base64', sha: sha(n), content: Buffer.from(present.has(n) ? '{"dependencies":{"widget":"1"}}' : '{"dependencies":{}}').toString('base64') }), { status: 200 });
      },
    });
    const result = await collectDependencyHistory({ http, owner: 'o', repo: 'r', ref: 'main', dependencies: [dep()], manifests: [], locks: [], budget: { maxCommits: 8, maxRequests: 100 } });
    expect(result.entries[0]?.events.map((e) => e.kind)).toEqual(['introduced', 'removed', 'reintroduced']);
    expect(result.entries[0]?.introduced_at?.commit_sha).toBe(sha(3));
  });
});
