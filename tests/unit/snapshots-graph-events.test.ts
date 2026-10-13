import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { EXIT, main } from '../../src/cli.js';
import { buildTimeline } from '../../src/events/build.js';
import { BUILTIN_PATTERNS, correlate } from '../../src/events/correlate.js';
import type { TimelineEvent } from '../../src/events/model.js';
import { EMPTY_GOVERNANCE } from '../../src/governance/temporal.js';
import { buildTrustGraph, GRAPH_EDGE_TYPES, validateGraph } from '../../src/graph/trust.js';
import { EMPTY_REGISTRY_INTEL } from '../../src/registry/model.js';
import { EMPTY_RELEASE_INTEL } from '../../src/release/model.js';
import type { Report } from '../../src/report/schema.js';
import { canonicalReportHash } from '../../src/report/integrity.js';
import { effectiveBlocks, evaluateTemporalBlocks } from '../../src/scoring/policy.js';
import { ProfileSchema } from '../../src/scoring/types.js';
import { FsSnapshotStore, keyOf, validKey } from '../../src/store/snapshots.js';
import { fakeFetch, fixedClock, sha256, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const COMMIT = 'e'.repeat(40);
const run = (s: FakeSpec, extra: Parameters<typeof analyzeRepository>[1] = {}): Promise<Report> =>
  analyzeRepository(`${s.owner}/${s.repo}`, { fetch: fakeFetch(s), clock: fixedClock, ...extra });
/** goodRepo's fake serves a head commit sha; make the key explicit and the integrity digest consistent. */
const pinned = async (s: FakeSpec = goodRepo()): Promise<Report> => run(s);

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rr-snap-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshot store', () => {
  it('stores a report under repository + commit + schema + methodology + config, and reads it back verified', async () => {
    const r = await pinned();
    const store = new FsSnapshotStore(dir);
    const put = store.putSnapshot(r);
    expect(put.status).toBe('stored');
    expect(put.key).toMatchObject({
      repository: 'acme/widget',
      schema_version: r.schema_version,
      methodology: r.methodology.version,
    });
    expect(store.hasSnapshot(put.key!)).toBe(true);
    const got = store.getSnapshot(put.key!);
    expect('report' in got && got.report.integrity.report_sha256).toBe(r.integrity.report_sha256);
    expect(store.listSnapshots({ repository: 'ACME/Widget' })).toHaveLength(1);
  });

  it('storing the same report again is idempotent', async () => {
    const r = await pinned();
    const store = new FsSnapshotStore(dir);
    store.putSnapshot(r);
    expect(store.putSnapshot(r).status).toBe('exists');
    expect(store.listSnapshots()).toHaveLength(1);
  });

  it('a different report under the same key is a CONFLICT: the stored one is kept and nothing is overwritten', async () => {
    const a = await pinned();
    const changed = JSON.parse(JSON.stringify(a)) as Report;
    changed.generated_at = '2030-01-01T00:00:00.000Z';
    changed.integrity = { report_sha256: canonicalReportHash(changed) };
    const store = new FsSnapshotStore(dir);
    store.putSnapshot(a);
    const res = store.putSnapshot(changed);
    expect(res.status).toBe('conflict');
    expect(res.stored_sha256).toBe(a.integrity.report_sha256);
    const got = store.getSnapshot(res.key!);
    expect('report' in got && got.report.generated_at).toBe(a.generated_at);
    // explicit revision: both are kept, content addressed, neither replaced
    const rev = store.putSnapshot(changed, { allowRevision: true });
    expect(rev.status).toBe('revision_stored');
    expect(
      readdirSync(join(dir, 'snapshots', 'acme', 'widget', res.key!.commit)).filter((f) =>
        f.endsWith('.json'),
      ),
    ).toHaveLength(2);
    expect(store.putSnapshot(changed, { allowRevision: true }).status).toBe('exists');
  });

  it('refuses a report whose integrity digest does not match its content, and a report without a full commit sha', async () => {
    const r = await pinned();
    const store = new FsSnapshotStore(dir);
    const forged = JSON.parse(JSON.stringify(r)) as Report;
    forged.dimensions = [];
    expect(store.putSnapshot(forged).status).toBe('rejected');
    const noSha = JSON.parse(JSON.stringify(r)) as Report;
    noSha.subject.ref = null;
    expect(store.putSnapshot(noSha).status).toBe('rejected');
  });

  it('path traversal in any key component is impossible', () => {
    const base = {
      repository: 'acme/widget',
      commit: COMMIT,
      schema_version: '0.6',
      methodology: '0.4',
      config_digest: 'a'.repeat(16),
    };
    expect(validKey(base)).toBe(true);
    for (const bad of [
      { ...base, repository: '../../etc/passwd' },
      { ...base, repository: 'acme/..' },
      { ...base, repository: 'acme/.hidden' },
      { ...base, repository: 'acme\\widget' },
      { ...base, commit: '../..' },
      { ...base, schema_version: '../1' },
      { ...base, config_digest: '../../x' + 'a'.repeat(8) },
    ])
      expect(validKey(bad), JSON.stringify(bad)).toBe(false);
    const store = new FsSnapshotStore(dir);
    expect(store.getSnapshot({ ...base, repository: '../../x/y' })).toEqual({
      error: 'invalid snapshot key',
    });
  });

  it('a tampered stored file is detected on read (hash, schema, size) and never returned', async () => {
    const r = await pinned();
    const store = new FsSnapshotStore(dir);
    const put = store.putSnapshot(r);
    const raw = JSON.parse(readFileSync(put.path!, 'utf8')) as Report;
    raw.overall = { ...raw.overall, score: 100 };
    writeFileSync(put.path!, JSON.stringify(raw));
    expect(store.getSnapshot(put.key!)).toMatchObject({
      error: expect.stringMatching(/modified|schema/),
    });
    writeFileSync(put.path!, '{ not json');
    expect(store.getSnapshot(put.key!)).toMatchObject({
      error: expect.stringMatching(/unreadable/),
    });
  });

  it('hostile index lines are skipped, not trusted', async () => {
    const r = await pinned();
    const store = new FsSnapshotStore(dir);
    store.putSnapshot(r);
    writeFileSync(
      join(dir, 'index.jsonl'),
      readFileSync(join(dir, 'index.jsonl'), 'utf8') +
        '{"repository":"../x/y","commit":"x"}\nnot json\n',
    );
    expect(store.listSnapshots()).toHaveLength(1);
  });

  it('keyOf needs a full commit sha', async () => {
    const r = await pinned();
    expect(keyOf(r)?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the CLI stores with --snapshot-dir, lists, and reports a conflict instead of overwriting', async () => {
    vi.stubGlobal('fetch', fakeFetch(goodRepo()));
    let out = '';
    let err = '';
    const args = ['analyze', 'acme/widget', '--snapshot-dir', dir, '--no-scorecard'];
    expect(
      await main(
        args,
        (s) => (out += s),
        (s) => (err += s),
      ),
    ).toBe(EXIT.OK);
    expect(err).toMatch(/snapshot: stored/);
    err = '';
    await main(
      args,
      (s) => (out += s),
      (s) => (err += s),
    );
    expect(err).toMatch(/snapshot: (exists|conflict)/);
    out = '';
    expect(
      await main(
        ['snapshots', '--snapshot-dir', dir],
        (s) => (out += s),
        () => undefined,
      ),
    ).toBe(EXIT.OK);
    expect(out).toMatch(/1 snapshot\(s\)|2 snapshot\(s\)/);
    expect(
      await main(
        ['snapshots'],
        () => undefined,
        () => undefined,
      ),
    ).toBe(EXIT.USAGE);
  });
});

const ev = (
  id: string,
  type: TimelineEvent['type'],
  day: number,
  source: TimelineEvent['source'] = 'git',
): TimelineEvent => ({
  id,
  type,
  at:
    day >= 0 ? new Date(Date.parse('2025-01-01T00:00:00Z') + day * 86_400_000).toISOString() : null,
  subject: 's',
  source,
  detail: 'd',
  confidence: 0.6,
  evidence: [],
});

describe('temporal event correlation (generic patterns, synthetic fixtures)', () => {
  const ids = (events: TimelineEvent[], patternId: string): string[] | undefined =>
    correlate(events).find((c) => c.pattern_id === patternId)?.event_ids;

  it('stable publisher then a normal release: no correlation', () => {
    expect(
      correlate([
        ev('a', 'registry_publish', 0),
        ev('b', 'registry_publish', 30),
        ev('c', 'release', 31),
      ]),
    ).toEqual([]);
  });

  it('a new publisher followed by a release within a week matches; after two weeks it does not', () => {
    expect(
      ids(
        [ev('p', 'new_publisher', 0, 'registry'), ev('r', 'release', 5, 'github_release')],
        'new-publisher-then-release',
      ),
    ).toEqual(['p', 'r']);
    expect(
      ids(
        [ev('p', 'new_publisher', 0, 'registry'), ev('r', 'release', 14, 'github_release')],
        'new-publisher-then-release',
      ),
    ).toBeUndefined();
  });

  it('dormancy, then a new actor, then a release, in order', () => {
    const e = [ev('d', 'dormancy_end', 0), ev('n', 'new_committer', 3), ev('r', 'release', 10)];
    expect(ids(e, 'dormancy-new-actor-release')).toEqual(['d', 'n', 'r']);
    // wrong order: the release comes before the new actor
    expect(
      ids(
        [ev('d', 'dormancy_end', 0), ev('r', 'release', 2), ev('n', 'new_committer', 20)],
        'dormancy-new-actor-release',
      ),
    ).toBeUndefined();
  });

  it('a new install hook near an actor change matches the install-hook pattern; far away it does not', () => {
    expect(
      ids(
        [
          ev('n', 'new_publisher', 0, 'registry'),
          ev('h', 'install_hook_introduced', 30, 'analysis_diff'),
        ],
        'actor-change-then-install-hook',
      ),
    ).toEqual(['n', 'h']);
    expect(
      ids(
        [
          ev('n', 'new_publisher', 0, 'registry'),
          ev('h', 'install_hook_introduced', 400, 'analysis_diff'),
        ],
        'actor-change-then-install-hook',
      ),
    ).toBeUndefined();
  });

  it('events with an unknown time never correlate', () => {
    expect(correlate([ev('n', 'new_publisher', -1), ev('r', 'release', -1)])).toEqual([]);
  });

  it('the tightest match is reported once per pattern, and the statement never accuses', () => {
    const c = correlate([
      ev('p1', 'new_publisher', 0),
      ev('r1', 'release', 6),
      ev('p2', 'new_publisher', 10),
      ev('r2', 'release', 11),
    ]).find((x) => x.pattern_id === 'new-publisher-then-release')!;
    expect(c.event_ids).toEqual(['p2', 'r2']);
    expect(c.statement).toMatch(/Intent is undetermined/);
    expect(JSON.stringify(c)).not.toMatch(/malicious|hijack/i);
  });

  it('a hard budget bounds the search on adversarial input', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      ev(`e${i}`, i % 2 ? 'release' : 'new_publisher', i % 3),
    );
    const t0 = Date.now();
    correlate(many);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('custom patterns are plain data and validated', () => {
    const profile = ProfileSchema.safeParse({
      id: 'p',
      version: '1',
      title: 'P',
      description: 'd',
      temporal_block: [
        {
          id: 'custom',
          description: 'custom pattern',
          pattern: {
            id: 'two-steps',
            description: 'a then b',
            steps: [{ any_of: ['commit'] }, { any_of: ['release'] }],
            within_days: 2,
          },
        },
      ],
    });
    expect(profile.success).toBe(true);
    expect(
      ProfileSchema.safeParse({
        id: 'p',
        version: '1',
        title: 'P',
        description: 'd',
        temporal_block: [
          {
            id: 'abc',
            description: 'long enough',
            pattern: { id: 'x', steps: [], within_days: 1 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('temporal_block fires on the correlation of a timeline and only on observed events', () => {
    const profile = ProfileSchema.parse({
      id: 'p',
      version: '1',
      title: 'P',
      description: 'd',
      temporal_block: [
        {
          id: 'pub-release',
          description: 'new publisher then release',
          pattern: 'new-publisher-then-release',
        },
      ],
    });
    const tl = buildTimeline({
      governance: EMPTY_GOVERNANCE,
      registry: EMPTY_REGISTRY_INTEL,
      releases: EMPTY_RELEASE_INTEL,
      extra: [ev('p', 'new_publisher', 0, 'registry'), ev('r', 'release', 3, 'github_release')],
    });
    expect(evaluateTemporalBlocks(profile.temporal_block, tl).map((v) => v.id)).toEqual([
      'pub-release',
    ]);
    const empty = buildTimeline({
      governance: EMPTY_GOVERNANCE,
      registry: EMPTY_REGISTRY_INTEL,
      releases: EMPTY_RELEASE_INTEL,
    });
    expect(evaluateTemporalBlocks(profile.temporal_block, empty)).toEqual([]);
    expect(BUILTIN_PATTERNS.length).toBeGreaterThanOrEqual(4);
  });
});

describe('end to end: publisher change near a release in a real analysis', () => {
  const day = 86_400_000;
  const t0 = Date.parse('2025-06-01T00:00:00Z');
  const npm = (users: string[], gapBeforeLast: number) => {
    const times: Record<string, string> = {};
    const versions: Record<string, unknown> = {};
    users.forEach((u, i) => {
      const v = `1.0.${i}`;
      const at =
        i === users.length - 1
          ? t0 + (users.length - 2) * 20 * day + gapBeforeLast * day
          : t0 + i * 20 * day;
      times[v] = new Date(at).toISOString();
      versions[v] = { _npmUser: { name: u }, dist: { integrity: 'sha512-x' } };
    });
    return {
      name: 'widget',
      'dist-tags': { latest: `1.0.${users.length - 1}` },
      maintainers: [{ name: 'alice' }],
      repository: { url: 'git+https://github.com/acme/widget.git' },
      time: times,
      versions,
    };
  };

  it('a new npm publisher shows up as an event and, with a release soon after, as a correlation', async () => {
    const s = goodRepo();
    s.files['package.json'] = JSON.stringify({ name: 'widget', version: '1.0.0' });
    const users = ['alice', 'alice', 'alice', 'alice', 'alice', 'alice', 'mallory'];
    s.registry = { 'registry.npmjs.org/widget': npm(users, 10) };
    const last = new Date(t0 + 5 * 20 * day + 10 * day).toISOString();
    s.releases = [
      { daysAgo: 1, detail: { tag: 'v1.0.6', commit: COMMIT, assets: { 'a.zip': 'x' } } },
    ];
    s.releases[0]!.daysAgo = Math.max(
      0,
      Math.round((Date.parse('2026-01-01T00:00:00Z') - Date.parse(last)) / day),
    );
    const r = await run(s);
    expect(r.timeline.events.some((e) => e.type === 'new_publisher')).toBe(true);
    expect(r.timeline.events.some((e) => e.type === 'release')).toBe(true);
    expect(r.timeline.not_available.join(' ')).toMatch(/external_domain_/);
    for (const c of r.timeline.correlations) expect(c.statement).toMatch(/undetermined/);
  });
});

describe('trust graph', () => {
  it('projects release, attestation, package, publisher, maintainer, dependency and capability data with evidence on every edge', async () => {
    const s = goodRepo();
    s.files['package.json'] = JSON.stringify({
      name: 'widget',
      version: '1.0.0',
      dependencies: { bullmq: '^5.0.0' },
    });
    s.registry = {
      'registry.npmjs.org/widget': {
        name: 'widget',
        'dist-tags': { latest: '1.0.0' },
        maintainers: [{ name: 'alice' }],
        repository: { url: 'git+https://github.com/acme/widget.git' },
        time: { '1.0.0': '2025-01-01T00:00:00Z' },
        versions: { '1.0.0': { _npmUser: { name: 'alice' }, dist: { integrity: 'sha512-x' } } },
      },
    };
    s.releases = [
      {
        daysAgo: 3,
        detail: {
          tag: 'v1',
          commit: COMMIT,
          publishedBy: 'alice',
          annotated: true,
          verification: { verified: true, reason: 'valid' },
          assets: { 'a.zip': 'z' },
        },
      },
    ];
    const g = buildTrustGraph(await run(s));
    expect(validateGraph(g)).toEqual([]);
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const k of [
      'Repository',
      'Commit',
      'Release',
      'ReleaseAsset',
      'Package',
      'PackageVersion',
      'Publisher',
      'Maintainer',
      'Actor',
      'Dependency',
      'Signature',
    ])
      expect(kinds.has(k as never), k).toBe(true);
    for (const e of g.edges) {
      expect(e.evidence_ids.length).toBeGreaterThan(0);
      expect(GRAPH_EDGE_TYPES).toContain(e.type);
    }
    // roles are never merged even though the account name is the same string
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'publisher:npm:alice',
        'maintainer:npm:alice',
        'actor:release_author:alice',
      ]),
    );
    expect(g.edges.find((e) => e.type === 'PUBLISHED_BY')?.temporal_scope).toBe('publish_history');
    expect(g.edges.find((e) => e.type === 'MAINTAINED_BY')?.temporal_scope).toBe('current_state');
    expect(g.edges.find((e) => e.type === 'SOURCED_FROM')).toBeDefined();
  });

  it('an edge without evidence is never created', async () => {
    const r = await run(goodRepo());
    const stripped = JSON.parse(JSON.stringify(r)) as Report;
    for (const d of stripped.dependency_intel.dependencies) d.id = '';
    const g = buildTrustGraph(stripped);
    expect(g.edges.filter((e) => e.type === 'DEPENDS_ON')).toEqual([]);
    expect(g.dropped_without_evidence).toBeGreaterThan(0);
    expect(validateGraph(g)).toEqual([]);
  });

  it('validateGraph catches dangling and evidence-free edges in a hand-made graph', () => {
    const g = {
      version: '1' as const,
      nodes: [{ id: 'a', kind: 'Repository' as const, name: 'a', attrs: {} }],
      edges: [
        {
          from: 'a',
          to: 'zzz',
          type: 'DEPENDS_ON' as const,
          evidence_ids: [],
          confidence: 1,
          temporal_scope: 'revision' as const,
          source: 'diff' as const,
          at: null,
        },
      ],
      truncated: false,
      dropped_without_evidence: 0,
      not_represented: [],
    };
    expect(validateGraph(g).join(' ')).toMatch(
      /dangling[\s\S]*no evidence|no evidence[\s\S]*dangling/,
    );
  });

  it('the graph command summarizes a stored report', async () => {
    const f = join(dir, 'r.json');
    writeFileSync(f, JSON.stringify(await run(goodRepo())));
    let out = '';
    expect(
      await main(
        ['graph', f],
        (s) => (out += s),
        () => undefined,
      ),
    ).toBe(EXIT.OK);
    expect(out).toMatch(/nodes: \d+/);
    expect(
      await main(
        ['graph'],
        () => undefined,
        () => undefined,
      ),
    ).toBe(EXIT.USAGE);
  });
});

describe('policy: new requirements', () => {
  const profile = (extra: Record<string, unknown>) =>
    ProfileSchema.parse({ id: 'p', version: '1', title: 'P', description: 'd', ...extra });

  it('compile into blocks with strict/unknown semantics', () => {
    const b = effectiveBlocks(
      profile({
        require: {
          verified_provenance: true,
          verified_source_binding: 'strict',
          registry_repository_match: true,
          publisher_stability: true,
        },
      }),
    );
    expect(b.map((x) => x.id)).toEqual([
      'require-verified-provenance',
      'require-verified-source-binding',
      'require-registry-repository-match',
      'require-publisher-stability',
    ]);
    expect(b.find((x) => x.id === 'require-verified-source-binding')?.on_unknown).toBe('block');
    expect(b.find((x) => x.id === 'require-verified-provenance')?.on_unknown).toBe('ignore');
  });

  it('verified-provenance facts are unknown unless verification actually ran', async () => {
    const s = goodRepo();
    s.releases = [
      {
        daysAgo: 2,
        detail: { tag: 'v1', commit: COMMIT, assets: { 'a.zip': 'z' }, attestations: {} },
      },
    ];
    const without = await run(s);
    expect(without.facts.some((f) => f.id === 'release.provenance.verified')).toBe(false);
    const withIt = await run(s, {
      verifyCrypto: true,
      verifier: { trustRoot: 'sigstore_public_good', verify: async () => ({}) },
    });
    expect(withIt.facts.find((f) => f.id === 'release.provenance.verified')?.value).toBe(false);
  });

  it('a conflicting registry package violates the requirement; a failed lookup does not (unless strict)', async () => {
    const lax = profile({ require: { registry_repository_match: true } });
    const strict = profile({ require: { registry_repository_match: 'strict' } });
    expect(lax.require.registry_repository_match).toBe(true);
    expect(effectiveBlocks(strict)[0]?.on_unknown).toBe('block');
    const s = goodRepo();
    s.files['package.json'] = JSON.stringify({ name: 'widget', version: '1.0.0' });
    s.registry = {
      'registry.npmjs.org/widget': {
        name: 'widget',
        versions: { '1.0.0': {} },
        repository: { url: 'https://github.com/evil/widget' },
        time: { '1.0.0': '2025-01-01T00:00:00Z' },
      },
    };
    const r = await run(s);
    expect(r.facts.find((f) => f.id === 'registry.repository_match')?.value).toBe('conflicting');
  });
});

void sha256;
