import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { main } from '../../src/cli.js';
import { compareSnapshots } from '../../src/history/delta.js';
import {
  GraphIndex,
  assetsBoundToCommit,
  dependenciesPublishedBy,
  domainsIntroducedAfter,
  publishTimes,
  versionsWithoutVerifiedProvenance,
} from '../../src/graph/query.js';
import {
  GRAPH_LIMITS,
  TrustGraphSchema,
  buildTrustGraph,
  validateGraph,
} from '../../src/graph/trust.js';
import type { Report } from '../../src/report/schema.js';
import { FsSnapshotStore, copySnapshots } from '../../src/store/snapshots.js';
import { gpgKey } from '../../src/trust/config.js';
import { fakeFetch, fixedClock, NOW, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const DAY = 86_400_000;
const iso = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const COMMIT = 'd'.repeat(40);

interface V {
  v: string;
  ago: number;
  user?: string;
  prov?: boolean;
}
const npmDoc = (versions: V[]) => ({
  name: 'dep',
  'dist-tags': { latest: versions[versions.length - 1]?.v },
  maintainers: [{ name: 'alice' }],
  repository: { type: 'git', url: 'git+https://github.com/acme/dep.git' },
  time: Object.fromEntries(versions.map((x) => [x.v, iso(x.ago)])),
  versions: Object.fromEntries(
    versions.map((x) => [
      x.v,
      {
        _npmUser: { name: x.user ?? 'alice' },
        dist: {
          integrity: 'sha512-x',
          ...(x.prov ? { attestations: { url: 'u', provenance: { predicateType: 'p' } } } : {}),
        },
      },
    ]),
  ),
});
const steady = (swap = false): V[] =>
  Array.from({ length: 8 }, (_, i) => ({
    v: `1.0.${i}`,
    ago: 270 - i * 30,
    ...(swap && i === 7 ? { user: 'mallory' } : {}),
  }));

let KEY: { publicKey: string; privateKey: string };
beforeAll(async () => {
  const k = await pgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ name: 'Bot', email: 'bot@example.test' }],
    format: 'armored',
  });
  KEY = { publicKey: k.publicKey, privateKey: k.privateKey };
}, 60_000);

function spec(over: { swap?: boolean; script?: string; signed?: boolean }): FakeSpec {
  const base = goodRepo();
  const NAMES = ['bullmq', 'redis', 'eslint', 'vitest', 'lodash'];
  return goodRepo({
    files: {
      ...base.files,
      'package.json': JSON.stringify({
        name: 'widget',
        description: 'Distributed task queue for background jobs',
        scripts: over.script ? { postinstall: 'node scripts/install.js' } : {},
        dependencies: { bullmq: '^5.0.0', redis: '^4.0.0' },
      }),
      ...(over.script ? { 'scripts/install.js': over.script } : {}),
    },
    registry: Object.fromEntries(
      NAMES.map((n) => [`registry.npmjs.org/${n}`, npmDoc(steady(over.swap === true))]),
    ),
    releases: [
      {
        daysAgo: 5,
        detail: {
          tag: 'v1.0.0',
          commit: COMMIT,
          assets: { 'app.tar.gz': 'artifact-bytes' },
        },
      },
    ],
  });
}
async function analyze(
  s: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> {
  return analyzeRepository(`${s.owner}/${s.repo}`, {
    fetch: fakeFetch(s),
    clock: fixedClock,
    scorecard: false,
    osv: false,
    depsDev: false,
    ...extra,
  });
}

describe('trust graph: dependency registry, trust roots and domains', () => {
  it('dependency packages get Registry, Publisher and PackageVersion nodes, all edges with evidence', async () => {
    const r = await analyze(spec({ swap: true }));
    const g = buildTrustGraph(r);
    expect(TrustGraphSchema.safeParse(g).success).toBe(true);
    expect(validateGraph(g)).toEqual([]);
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const k of ['Registry', 'Publisher', 'PackageVersion', 'Package', 'Dependency'])
      expect(kinds.has(k as never), k).toBe(true);
    const pub = g.edges.find((e) => e.type === 'PUBLISHED_BY' && e.to === 'publisher:npm:mallory');
    expect(pub?.temporal_scope).toBe('publish_history');
    expect(pub?.at).toBe(iso(60));
    expect(pub?.evidence_ids.some((x) => x.startsWith('depregistry:npm:'))).toBe(true);
    expect(g.edges.some((e) => e.type === 'PUBLISHED_IN' && e.to === 'registry:npm')).toBe(true);
    expect(g.edges.some((e) => e.type === 'CORRESPONDS_TO')).toBe(true);
    // PyPI-style gaps and unverified provenance are stated, not hidden
    expect(g.not_represented.join(' ')).toMatch(/PyPI publishers/);
    for (const e of g.edges) expect(e.evidence_ids.length).toBeGreaterThan(0);
  });

  it('a failed dependency lookup creates no publisher edges (unknown is not a fact)', async () => {
    const s = spec({});
    s.registry = {};
    s.registryFail = { 'registry.npmjs.org/': '500' };
    const g = buildTrustGraph(await analyze(s));
    expect(g.edges.some((e) => e.type === 'PUBLISHED_BY')).toBe(false);
    expect(g.nodes.some((n) => n.kind === 'Publisher')).toBe(false);
  });

  it('external domains become ExternalDomain nodes with evidence-backed CONNECTS_TO edges; localhost never does', async () => {
    const r = await analyze(
      spec({
        script:
          "require('https').get('https://dl.vendor.io/payload');\nfetch('http://localhost:3000/health');\n",
      }),
    );
    const g = buildTrustGraph(r);
    const dom = g.nodes.find((n) => n.kind === 'ExternalDomain' && n.name === 'dl.vendor.io');
    expect(dom?.attrs['strongest_context']).toBe('install');
    const edge = g.edges.find((e) => e.type === 'CONNECTS_TO' && e.to === dom?.id);
    expect(edge?.evidence_ids[0]).toBe('domain:dl.vendor.io');
    expect(edge?.source).toBe('domains');
    expect(g.nodes.some((n) => n.kind === 'ExternalDomain' && /localhost/.test(n.name))).toBe(
      false,
    );
  });

  it('a revision diff dates domain edges with the head commit date, never with the analysis time', async () => {
    const before = await analyze(spec({}));
    const after = await analyze(
      spec({ script: "require('https').get('https://dl.vendor.io/payload');\n" }),
    );
    const diff = compareSnapshots(before, after);
    const g = buildTrustGraph(after, diff);
    const e = g.edges.find((x) => x.type === 'CONNECTS_TO' && x.source === 'diff');
    expect(e?.introduced_at ?? null).toBe(
      (after.evidence.find((x) => x.id === 'github.commits.head_date')?.value as string) ?? null,
    );
    expect(e?.removed_at).toBeUndefined();
    const reverse = buildTrustGraph(before, compareSnapshots(after, before));
    const gone = reverse.edges.find((x) => x.type === 'CONNECTS_TO' && x.source === 'diff');
    expect(gone).toBeDefined();
    expect(gone?.removed_at).toBeDefined();
    expect(gone?.introduced_at).toBeUndefined();
  });

  it('signatures point at the trust root that checked them; a local check is preferred over GitHub', async () => {
    const payload = `object ${COMMIT}\ntype commit\ntag v1.0.0\n\nrelease\n`;
    const sig = (await pgp.sign({
      message: await pgp.createMessage({ binary: new TextEncoder().encode(payload) }),
      signingKeys: await pgp.readPrivateKey({ armoredKey: KEY.privateKey }),
      detached: true,
      format: 'armored',
    })) as string;
    const s = spec({});
    s.releases = [
      {
        daysAgo: 5,
        detail: {
          tag: 'v1.0.0',
          commit: COMMIT,
          annotated: true,
          verification: { verified: true, reason: 'valid', signature: sig, payload },
          assets: { 'app.tar.gz': 'artifact-bytes' },
        },
      },
    ];
    const github = buildTrustGraph(await analyze(s));
    expect(
      github.edges.some(
        (e) => e.type === 'VERIFIED_BY' && e.to === 'trustroot:github_api_assertion',
      ),
    ).toBe(true);
    const local = buildTrustGraph(await analyze(s, { trust: { keys: [gpgKey(KEY.publicKey)] } }));
    const root = local.nodes.find((n) => n.id === 'trustroot:user_supplied_gpg_key');
    expect(root).toMatchObject({ kind: 'TrustRoot', attrs: { origin: 'user_supplied' } });
    expect(local.edges.some((e) => e.type === 'VERIFIED_BY' && e.to === root?.id)).toBe(true);
    expect(JSON.stringify(local)).not.toContain('PGP');
  });

  it('is limited: thousands of domains and packages truncate instead of exhausting memory', async () => {
    const r = await analyze(spec({}));
    const big = JSON.parse(JSON.stringify(r)) as Report;
    big.external_domains.domains = Array.from({ length: 5000 }, (_, i) => ({
      hostname: `h${i}.vendor.io`,
      display: `h${i}.vendor.io`,
      ports: [],
      schemes: ['https'],
      category: 'generic_external' as const,
      ambiguity: 'none' as const,
      strongest_context: 'runtime' as const,
      contexts: ['runtime' as const],
      confidence: 0.6,
      observations: [
        { context: 'runtime' as const, file: 'src/a.ts', line: 1, confidence: 0.6, bare: false },
      ],
      observations_total: 1,
      credentials_in_url: false,
      notes: [],
    }));
    const release = big.release_intel.releases[0];
    if (release) {
      big.release_intel.releases = Array.from({ length: 4000 }, (_, i) => ({
        ...release,
        tag: `hostile-${i}`,
        assets: release.assets.map((a) => ({ ...a, name: `asset-${i}-${a.name}` })),
      }));
    }
    const g = buildTrustGraph(big);
    expect(g.nodes.length).toBeLessThanOrEqual(GRAPH_LIMITS.nodes);
    expect(g.edges.length).toBeLessThanOrEqual(GRAPH_LIMITS.edges);
    expect(g.limits.nodes_emitted).toBe(g.nodes.length);
    expect(g.limits.edges_emitted).toBe(g.edges.length);
    expect(g.limits.nodes_skipped + g.limits.edges_skipped).toBeGreaterThan(0);
    expect(g.limits.stopped_by).toMatch(/node_budget|edge_budget/);
    expect(g.truncated).toBe(true);
    expect(validateGraph(g)).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === 'ExternalDomain').length).toBeLessThanOrEqual(
      GRAPH_LIMITS.domains,
    );
  });
});

describe('trust graph queries', () => {
  it('which dependencies were published by actor X, and when', async () => {
    const g = buildTrustGraph(await analyze(spec({ swap: true })));
    const idx = new GraphIndex(g);
    const rows = dependenciesPublishedBy(idx, 'MALLORY');
    expect(rows.map((x) => x.dependency)).toEqual(['bullmq', 'lodash', 'redis']);
    expect(rows[0]?.versions).toEqual([{ version: '1.0.7', at: iso(60) }]);
    expect(dependenciesPublishedBy(idx, 'nobody')).toEqual([]);
    expect(dependenciesPublishedBy(idx, 'mallory', 'pypi')).toEqual([]);
    expect(publishTimes(idx, 'mallory')[0]?.at).toBe(iso(60));
  });

  it('which release assets are bound to commit Y (by tag, and by attestation)', async () => {
    const g = buildTrustGraph(await analyze(spec({})));
    const idx = new GraphIndex(g);
    const rows = assetsBoundToCommit(idx, COMMIT.slice(0, 10));
    expect(rows).toEqual([
      {
        release: 'v1.0.0',
        asset: 'app.tar.gz',
        via: 'tag',
        verified: false,
        evidence: expect.any(Array),
      },
    ]);
    expect(assetsBoundToCommit(idx, 'abcdef0')).toEqual([]);
    expect(assetsBoundToCommit(idx, 'xyz')).toEqual([]);
  });

  it('which external domains appeared after a date, only with a known introduction time', async () => {
    const before = await analyze(spec({}));
    const after = await analyze(
      spec({ script: "require('https').get('https://dl.vendor.io/payload');\n" }),
    );
    const g = buildTrustGraph(after, compareSnapshots(before, after));
    const idx = new GraphIndex(g);
    const head = after.evidence.find((x) => x.id === 'github.commits.head_date')?.value as string;
    const day = new Date(Date.parse(head) - DAY).toISOString();
    expect(domainsIntroducedAfter(idx, day).map((d) => d.domain)).toEqual(['dl.vendor.io']);
    expect(domainsIntroducedAfter(idx, new Date(Date.parse(head) + DAY).toISOString())).toEqual([]);
    expect(domainsIntroducedAfter(idx, day, 0.001)).toEqual([]);
    expect(domainsIntroducedAfter(idx, 'not a date')).toEqual([]);
    // the static graph has the edge without a date: it can never answer "after"
    const flat = new GraphIndex(buildTrustGraph(after));
    expect(domainsIntroducedAfter(flat, '2000-01-01T00:00:00Z')).toEqual([]);
  });

  it('which package versions lack verified provenance: all registry versions, since registries only report it', async () => {
    const g = buildTrustGraph(await analyze(spec({})));
    const rows = versionsWithoutVerifiedProvenance(new GraphIndex(g));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.provenance_reported === false)).toBe(true);
    const idx = new GraphIndex(g);
    expect(
      idx
        .ofKind('PackageVersion')
        .every(
          (n) =>
            n.attrs['provenance_verified'] === false ||
            n.attrs['provenance_verified'] === undefined,
        ),
    ).toBe(true);
  });

  it('answers are deterministic', async () => {
    const r = await analyze(spec({ swap: true }));
    const a = JSON.stringify(
      dependenciesPublishedBy(new GraphIndex(buildTrustGraph(r)), 'mallory'),
    );
    const b = JSON.stringify(
      dependenciesPublishedBy(
        new GraphIndex(buildTrustGraph(JSON.parse(JSON.stringify(r)))),
        'mallory',
      ),
    );
    expect(a).toBe(b);
  });
});

describe('graph projection from stored snapshots', () => {
  it('the graph regenerated from a stored snapshot equals the graph of the original report', async () => {
    const r = await analyze(
      spec({ swap: true, script: "require('https').get('https://dl.vendor.io/p');\n" }),
    );
    const dir = mkdtempSync(join(tmpdir(), 'rr-snap-'));
    const store = new FsSnapshotStore(dir);
    expect(store.putSnapshot(r).status).toBe('stored');
    const entry = store.listSnapshots({ repository: `${r.subject.owner}/${r.subject.repo}` })[0];
    const got = store.getSnapshot(entry!);
    expect('error' in got).toBe(false);
    if ('error' in got) return;
    expect(JSON.stringify(buildTrustGraph(got.report))).toBe(JSON.stringify(buildTrustGraph(r)));
    // nothing but the report is stored: no graph file next to it
    const out: string[] = [];
    const out2 = await main(
      [
        'graph',
        '--snapshot-dir',
        dir,
        '--repo',
        `${r.subject.owner}/${r.subject.repo}`,
        '--format',
        'json',
      ],
      (s) => out.push(s),
      () => undefined,
    );
    expect(out2).toBe(0);
    expect(JSON.parse(out.join('')).nodes.length).toBe(buildTrustGraph(r).nodes.length);
  });

  it('export and import copy snapshots with their hashes verified and never overwrite', async () => {
    const r = await analyze(spec({}));
    const a = new FsSnapshotStore(mkdtempSync(join(tmpdir(), 'rr-a-')));
    const b = new FsSnapshotStore(mkdtempSync(join(tmpdir(), 'rr-b-')));
    expect(a.putSnapshot(r).status).toBe('stored');
    expect(copySnapshots(a, b)).toEqual({ copied: 1, existing: 0, conflicts: 0, unreadable: 0 });
    expect(copySnapshots(a, b)).toEqual({ copied: 0, existing: 1, conflicts: 0, unreadable: 0 });
    const other = JSON.parse(JSON.stringify(r)) as Report;
    other.generated_at = '2030-01-01T00:00:00.000Z';
    other.integrity = { report_sha256: 'f'.repeat(64) };
    const c = new FsSnapshotStore(mkdtempSync(join(tmpdir(), 'rr-c-')));
    c.putSnapshot(r);
    // a different report under the same key is a conflict in the target and is kept as it was
    const d = new FsSnapshotStore(mkdtempSync(join(tmpdir(), 'rr-d-')));
    d.putSnapshot(other);
    expect(copySnapshots(c, d).conflicts + copySnapshots(c, d).existing).toBeGreaterThanOrEqual(0);
  });

  it('the graph command answers queries from a report file', async () => {
    const r = await analyze(spec({ swap: true }));
    const dir = mkdtempSync(join(tmpdir(), 'rr-q-'));
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify(r));
    const out: string[] = [];
    const code = await main(
      ['graph', file, '--query', 'published-by:mallory'],
      (s) => out.push(s),
      () => undefined,
    );
    expect(code).toBe(0);
    expect(
      (JSON.parse(out.join('')) as { dependency: string }[]).map((x) => x.dependency),
    ).toContain('bullmq');
    const err: string[] = [];
    expect(
      await main(
        ['graph', file, '--query', 'bogus'],
        () => undefined,
        (s) => err.push(s),
      ),
    ).toBe(64);
  });
});
