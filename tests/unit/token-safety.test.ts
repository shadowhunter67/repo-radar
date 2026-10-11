import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { FsSnapshotStore } from '../../src/store/snapshots.js';
import { buildTrustGraph } from '../../src/graph/trust.js';
import { fakeFetch, fixedClock, sha256, type Recorded } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

describe('tokens never leave api.github.com and never reach reports, diagnostics, snapshots or the graph', () => {
  it('a GitHub token is sent only to api.github.com (not to registries, release downloads, raw files, OSV, deps.dev)', async () => {
    const s = goodRepo();
    s.files['package.json'] = JSON.stringify({ name: 'widget', version: '1.0.0' });
    s.releases = [
      {
        daysAgo: 2,
        detail: {
          tag: 'v1',
          commit: 'e'.repeat(40),
          assets: { 'a.zip': 'bytes', SHA256SUMS: `${sha256('bytes')}  a.zip\n` },
        },
      },
    ];
    const rec: Recorded[] = [];
    const r = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(s, rec),
      clock: fixedClock,
      token: TOKEN,
      verifyAssets: true,
    });
    const withAuth = rec.filter((x) => x.headers['authorization']);
    expect(withAuth.length).toBeGreaterThan(0);
    for (const x of withAuth) expect(new URL(x.url).host).toBe('api.github.com');
    for (const host of ['registry.npmjs.org', 'github.com', 'raw.githubusercontent.com'])
      expect(
        rec.filter((x) => new URL(x.url).host === host).every((x) => !x.headers['authorization']),
      ).toBe(true);
    expect(rec.some((x) => new URL(x.url).host === 'registry.npmjs.org')).toBe(true);
    expect(rec.some((x) => new URL(x.url).host === 'github.com')).toBe(true);

    const json = JSON.stringify(r);
    expect(json.includes(TOKEN)).toBe(false);
    expect(json.includes('Bearer')).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), 'rr-tok-'));
    try {
      new FsSnapshotStore(dir).putSnapshot(r);
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop() as string;
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) stack.push(p);
          else expect(readFileSync(p, 'utf8').includes(TOKEN), p).toBe(false);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(JSON.stringify(buildTrustGraph(r)).includes(TOKEN)).toBe(false);
  });

  it('an error that embeds the token in its message is redacted before it becomes a diagnostic', async () => {
    const s = goodRepo();
    const base = fakeFetch(s);
    const r = await analyzeRepository('acme/widget', {
      token: TOKEN,
      clock: fixedClock,
      fetch: async (url, init) => {
        if (String(url).includes('/contributors'))
          throw new Error(`socket hang up while sending ${TOKEN}`);
        return base(url, init);
      },
    });
    expect(JSON.stringify(r).includes(TOKEN)).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'fetch_failed')).toBe(true);
  });
});
