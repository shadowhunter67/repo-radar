import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/util/http.js';
import { traceManifestHistory } from '../../src/history/dependency.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const text = (present: boolean) =>
  Buffer.from(JSON.stringify({ dependencies: present ? { widget: '1.0.0' } : {} })).toString(
    'base64',
  );

describe('dependency history reference model', () => {
  it('matches an independent parent-diff reference across 300 reproducible DAG seeds', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const present = Array.from({ length: 6 }, (_, i) => (seed * 17 + i * 11) % 5 < 2);
      const commits = present.map((_, i) => ({
        sha: sha(seed * 10 + i + 1),
        commit: {
          committer: { date: `2024-03-${String(i + 1).padStart(2, '0')}T00:00:00Z` },
        },
        parents: [{ sha: sha(seed * 10 + i) }],
      }));
      if (seed % 7 === 0) {
        commits[5] = {
          ...commits[5]!,
          parents: [{ sha: commits[4]!.sha }, { sha: commits[2]!.sha }],
        };
        present[2] = true;
        present[4] = true;
        present[5] = false;
      }
      const reference: string[] = [];
      let first = false;
      let removed = false;
      for (let i = 0; i < commits.length; i++) {
        const c = commits[i]!;
        const parentValues = (c.parents ?? []).map(
          (p) => present[commits.findIndex((x) => x.sha === p.sha)] ?? false,
        );
        const current = present[i]!;
        const add =
          c.parents?.length && c.parents.length > 1
            ? current && parentValues.every((v) => !v)
            : current && !parentValues[0];
        const del =
          c.parents?.length && c.parents.length > 1
            ? !current && parentValues.every(Boolean)
            : !current && parentValues[0];
        if (add) {
          reference.push(
            first ? (removed ? 'reintroduced' : 'introduced_again_other_line') : 'introduced',
          );
          first = true;
        }
        if (del) {
          reference.push('removed');
          removed = true;
        }
      }
      const http = new HttpClient({
        allowedHosts: ['api.github.com'],
        fetch: async (url) => {
          const u = new URL(url);
          if (u.pathname.endsWith('/commits')) {
            if (u.searchParams.get('page') === '2') return new Response('[]', { status: 200 });
            return new Response(JSON.stringify([...commits].reverse()), { status: 200 });
          }
          if (u.pathname.includes('/commits/'))
            return new Response(JSON.stringify({ files: [{ status: 'added' }] }), { status: 200 });
          const n = commits.findIndex((c) => c.sha === u.searchParams.get('ref'));
          if (n < 0) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
          return new Response(
            JSON.stringify({
              encoding: 'base64',
              sha: sha(seed * 1000 + n + 1),
              content: text(present[n] ?? false),
            }),
            { status: 200 },
          );
        },
      });
      const result = await traceManifestHistory({
        http,
        owner: 'o',
        repo: 'r',
        ref: 'main',
        path: 'package.json',
        names: ['widget'],
        budget: { maxCommits: 7, maxRequests: 1000 },
      });
      expect(
        result.entries[0]?.events.map((e) => e.kind),
        `seed ${seed}`,
      ).toEqual(reference);
    }
  });
});
