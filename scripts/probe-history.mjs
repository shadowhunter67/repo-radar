import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { HttpClient } from '../dist/util/http.js';
import { collectDependencyHistory } from '../dist/history/dependency.js';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const name = Object.keys(manifest.dependencies ?? {})[0] ?? 'fixture-package';
const calls = [];
const commits = [
  {
    sha: 'b'.repeat(40),
    commit: {
      author: { name: 'probe-author', date: '2024-01-02T00:00:00Z' },
      committer: { name: 'probe-committer', date: '2024-01-02T00:00:00Z' },
    },
    parents: [{ sha: 'a'.repeat(40) }],
  },
  {
    sha: 'a'.repeat(40),
    commit: {
      author: { name: 'old', date: '2024-01-01T00:00:00Z' },
      committer: { name: 'old', date: '2024-01-01T00:00:00Z' },
    },
    parents: [],
  },
];
const http = new HttpClient({
  allowedHosts: ['api.github.com'],
  fetch: async (url) => {
    calls.push(url);
    const u = new globalThis.URL(url);
    if (u.pathname.endsWith('/commits'))
      return new globalThis.Response(JSON.stringify(commits), { status: 200 });
    const present = u.searchParams.get('ref')?.startsWith('b');
    return new globalThis.Response(
      JSON.stringify({
        encoding: 'base64',
        sha: '1'.repeat(40),
        content: Buffer.from(present ? `{"dependencies":{"${name}":"*"}}` : '{}').toString(
          'base64',
        ),
      }),
      { status: 200 },
    );
  },
});
const started = Date.now();
const result = await collectDependencyHistory({
  http,
  owner: 'offline',
  repo: 'probe',
  ref: 'main',
  dependencies: [
    {
      id: `npm:${name}`,
      package: { ecosystem: 'npm', name },
      relationship: 'runtime',
      direct: true,
      resolution: 'unresolved',
      other_versions: [],
      context: 'primary',
      manifest_path: 'package.json',
      vulnerability: { state: 'not_checked', advisory_ids: [] },
      derived_from: ['probe'],
      confidence: 1,
    },
  ],
  manifests: [],
  locks: [],
});
process.stdout.write(
  JSON.stringify(
    {
      probe: 'dependency-history',
      status: result.entries[0]?.history_status,
      commits_inspected: result.entries[0]?.introduction === 'known' ? 1 : 0,
      requests: calls.length,
      bytes: calls.reduce((n, x) => n + Buffer.byteLength(x), 0),
      elapsed_ms: Date.now() - started,
    },
    null,
    2,
  ) + '\n',
);
