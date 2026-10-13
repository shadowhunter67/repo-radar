import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { dependencyEvents, correspondDependency } from '../../src/registry/dependency-analysis.js';
import { PRIORITY_POINTS, selectCandidates } from '../../src/registry/dependency-priority.js';
import { parseNpm, parsePypi, parseCrates } from '../../src/registry/parse.js';
import type { Dependency } from '../../src/deps/model.js';
import type { Clock } from '../../src/evidence/builder.js';
import type { Report } from '../../src/report/schema.js';
import { ReportSchema } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, NOW, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const DAY = 86_400_000;
const NOW_MS = NOW.getTime();
const iso = (daysAgo: number): string => new Date(NOW_MS - daysAgo * DAY).toISOString();
const C = { name: 'dep', declaredBy: 'DEP-1', observedAt: NOW.toISOString() };

// ---- builders --------------------------------------------------------------------------------------------------
const dep = (
  over: Partial<Dependency> & { name: string; eco?: Dependency['package']['ecosystem'] },
): Dependency => {
  const { eco, name, ...rest } = over;
  return {
    id: `DEP-${name}`,
    package: { ecosystem: eco ?? 'npm', name },
    relationship: 'runtime',
    direct: true,
    resolution: 'resolved',
    resolved: { version: '1.0.0', source: 'lockfile', file: 'package-lock.json', confidence: 0.9 },
    other_versions: [],
    context: 'primary',
    vulnerability: { state: 'checked', advisory_ids: [] },
    derived_from: [],
    confidence: 0.9,
    ...rest,
  } as Dependency;
};

interface V {
  v: string;
  ago: number;
  user?: string;
  prov?: boolean;
  hook?: boolean;
  repo?: string;
  maint?: string[];
}
const npmDoc = (versions: V[], extra: Record<string, unknown> = {}) => ({
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
        ...(x.hook ? { scripts: { postinstall: 'node x.js' }, hasInstallScript: true } : {}),
        ...(x.repo ? { repository: { url: x.repo } } : {}),
        maintainers: (x.maint ?? ['alice']).map((name) => ({ name })),
        dist: {
          integrity: 'sha512-x',
          ...(x.prov ? { attestations: { url: 'u', provenance: { predicateType: 'p' } } } : {}),
        },
      },
    ]),
  ),
  ...extra,
});
/** 8 steady versions by alice, oldest first, 30 days apart, newest 60 days ago. */
const steady = (): V[] =>
  Array.from({ length: 8 }, (_, i) => ({ v: `1.0.${i}`, ago: 270 - i * 30 }));
const parsed = (versions: V[], extra: Record<string, unknown> = {}) =>
  parseNpm(npmDoc(versions, extra), C);

// ---- priority model ---------------------------------------------------------------------------------------------
describe('dependency priority model', () => {
  it('ranks direct runtime above transitive dev, vulnerable above clean, and is deterministic', () => {
    const deps = [
      dep({ name: 'zeta', direct: false, relationship: 'development' }),
      dep({ name: 'alpha' }),
      dep({
        name: 'vuln',
        direct: false,
        vulnerability: { state: 'checked', advisory_ids: ['GHSA-1'] },
      }),
      dep({ name: 'beta', relationship: 'build' }),
    ];
    const a = selectCandidates(deps).ranked.map((c) => c.name);
    const b = selectCandidates([...deps].reverse()).ranked.map((c) => c.name);
    expect(a).toEqual(b);
    expect(a[0]).toBe('alpha'); // direct 40 + runtime 30
    expect(a.indexOf('vuln')).toBeLessThan(a.indexOf('zeta'));
    expect(a.indexOf('beta')).toBeLessThan(a.indexOf('vuln'));
  });

  it('explains every ranking with named factors', () => {
    const [c] = selectCandidates([dep({ name: 'alpha', resolution: 'unresolved' })]).ranked;
    expect(c?.priority.reasons).toEqual(
      expect.arrayContaining(['direct (+40)', 'runtime (+30)', 'unpinned (+10)']),
    );
    expect(c?.priority.score).toBe(
      PRIORITY_POINTS.direct + PRIORITY_POINTS.runtime + PRIORITY_POINTS.unpinned,
    );
  });

  it('auxiliary manifests rank last and extra hints add points', () => {
    const r = selectCandidates(
      [
        dep({ name: 'aux', context: 'auxiliary' }),
        dep({ name: 'dev', relationship: 'development' }),
      ],
      new Map([['npm:dev', [{ points: 25, reason: 'newly introduced' }]]]),
    );
    expect(r.ranked[0]?.name).toBe('dev');
    expect(r.ranked[0]?.priority.reasons).toContain('newly introduced (+25)');
  });

  it('separates what cannot be looked up and merges one package requested twice', () => {
    const r = selectCandidates([
      dep({ name: 'go-lib', eco: 'Go' }),
      dep({ name: 'gitdep', resolution: 'not_registry' }),
      dep({ name: 'Bad Name!' }),
      dep({ name: 'dup', id: 'DEP-a', direct: false }),
      dep({ name: 'dup', id: 'DEP-b', direct: true }),
    ]);
    expect(r.ranked.map((c) => c.name)).toEqual(['dup']);
    expect(r.ranked[0]?.dependencyIds).toEqual(['DEP-a', 'DEP-b']);
    expect(r.ranked[0]?.direct).toBe(true);
    expect(r.ineligible.map((i) => i.reason).sort()).toEqual([
      'invalid_name',
      'not_registry_source',
      'unsupported_ecosystem',
    ]);
  });

  it('looks up the real package behind an npm alias', () => {
    const r = selectCandidates([
      dep({
        name: 'my-alias',
        requested: { spec: 'npm:real-pkg@^1', kind: 'range', alias_of: 'npm:real-pkg@^1' },
      }),
    ]);
    expect(r.ranked[0]?.name).toBe('real-pkg');
  });
});

// ---- events from publish history ----------------------------------------------------------------------------------
describe('dependency registry events', () => {
  it('a publisher that published none of the earlier versions is an event, a returning one is not', () => {
    const vs = steady();
    vs[6] = { ...vs[6]!, user: 'mallory' };
    vs[7] = { ...vs[7]!, user: 'Alice' }; // returns: case differs, same account
    const { events } = dependencyEvents(parsed(vs), []);
    const pub = events.filter((e) => e.type === 'dependency_publisher_changed');
    expect(pub).toHaveLength(1);
    expect(pub[0]?.version).toBe('1.0.6');
    expect(pub[0]?.intent).toBe('undetermined');
    expect(pub[0]?.scope).toBe('publish_history');
  });

  it('duplicate publisher spelling is not a change', () => {
    const vs = steady().map((v, i) => ({ ...v, user: i % 2 ? 'ALICE' : 'alice' }));
    expect(dependencyEvents(parsed(vs), []).events).toEqual([]);
  });

  it('records maintainer changes only from the maintainers stored WITH each version', () => {
    const vs = steady();
    vs[5] = { ...vs[5]!, maint: ['alice', 'bob'] };
    vs[6] = { ...vs[6]!, maint: ['alice', 'bob'] };
    vs[7] = { ...vs[7]!, maint: ['alice', 'bob'] };
    // the registry's CURRENT maintainer set is completely different: it must not create a dated event
    const { events } = dependencyEvents(
      parsed(vs, { maintainers: [{ name: 'eve' }, { name: 'trent' }] }),
      [],
    );
    const m = events.filter((e) => e.type === 'dependency_maintainer_changed');
    expect(m).toHaveLength(1);
    expect(m[0]?.version).toBe('1.0.5');
    expect(m[0]?.detail).toContain('added [bob]');
    expect(JSON.stringify(events)).not.toContain('eve');
  });

  it('install script, provenance loss and repository change are dated events', () => {
    const vs = steady().map((v) => ({
      ...v,
      prov: true,
      repo: 'git+https://github.com/acme/dep.git',
    }));
    vs[7] = { ...vs[7]!, prov: false, hook: true, repo: 'git+https://github.com/other/dep.git' };
    const { events } = dependencyEvents(parsed(vs), []);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'dependency_install_hook_introduced',
        'dependency_provenance_removed',
        'dependency_repository_changed',
      ]),
    );
    for (const e of events) expect(Date.parse(e.at)).toBe(NOW_MS - 60 * DAY);
  });

  it('dormancy that ended recently is an event, an old one is not', () => {
    const recentGap = steady().map((v, i) =>
      i === 7 ? { ...v, ago: 30 } : { ...v, ago: 600 - i * 30 },
    );
    expect(
      dependencyEvents(parsed(recentGap), []).events.some(
        (e) => e.type === 'dependency_dormancy_ended',
      ),
    ).toBe(true);
    const oldGap = steady().map((v, i) =>
      i >= 4 ? { ...v, ago: 1500 - (7 - i) * 30 } : { ...v, ago: 3000 - i * 30 },
    );
    expect(
      dependencyEvents(parsed(oldGap), []).events.some(
        (e) => e.type === 'dependency_dormancy_ended',
      ),
    ).toBe(false);
  });

  it('a burst after a slow history is a cadence change', () => {
    const slow = Array.from({ length: 6 }, (_, i) => ({ v: `1.0.${i}`, ago: 400 - i * 60 }));
    const burst = [
      { v: '1.1.0', ago: 4 },
      { v: '1.1.1', ago: 3 },
      { v: '1.1.2', ago: 2 },
    ];
    const { events } = dependencyEvents(parsed([...slow, ...burst]), []);
    expect(events.some((e) => e.type === 'dependency_release_cadence_changed')).toBe(true);
  });

  it('versions without a publish time never produce an event and are counted', () => {
    const vs = steady();
    vs[7] = { ...vs[7]!, user: 'mallory', hook: true };
    const doc = npmDoc(vs) as { time: Record<string, string> };
    delete doc.time['1.0.7'];
    const r = dependencyEvents(parseNpm(doc, C), []);
    expect(r.events).toEqual([]);
    expect(r.untimed).toBe(1);
  });

  it('relates each event to the version the analyzed revision resolves', () => {
    const vs = steady();
    vs[3] = { ...vs[3]!, user: 'mallory' };
    vs[4] = { ...vs[4]!, user: 'mallory' };
    const pkg = parsed(vs);
    expect(dependencyEvents(pkg, ['1.0.2']).events[0]?.relative_to_resolved).toBe('after');
    expect(dependencyEvents(pkg, ['1.0.6']).events[0]?.relative_to_resolved).toBe('before');
    expect(dependencyEvents(pkg, ['1.0.3']).events[0]?.relative_to_resolved).toBe('at');
    expect(dependencyEvents(pkg, []).events[0]?.relative_to_resolved).toBe('unknown');
  });

  it('PyPI offers no publisher history: no publisher or maintainer events', () => {
    const rel = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `1.0.${i}`,
        [{ upload_time_iso_8601: iso(300 - i * 30), digests: { sha256: 'a' }, yanked: false }],
      ]),
    );
    const pkg = parsePypi({ info: { version: '1.0.7', project_urls: {} }, releases: rel }, C);
    expect(pkg.limits.join(' ')).toMatch(/neither maintainers nor per-version publishers/);
    expect(pkg.versions.every((v) => v.publisher === null)).toBe(true);
    expect(dependencyEvents(pkg, []).events).toEqual([]);
  });

  it('crates.io publishers are read but maintainers and provenance are not invented', () => {
    const versions = Array.from({ length: 8 }, (_, i) => ({
      num: `1.0.${i}`,
      created_at: iso(300 - i * 30),
      yanked: false,
      checksum: 'x',
      published_by: { login: i === 7 ? 'mallory' : 'alice' },
    }));
    const pkg = parseCrates(
      { crate: { max_version: '1.0.7', repository: 'https://github.com/acme/dep' }, versions },
      undefined,
      C,
    );
    expect(dependencyEvents(pkg, []).events.map((e) => e.type)).toEqual([
      'dependency_publisher_changed',
    ]);
  });
});

// ---- correspondence -----------------------------------------------------------------------------------------------
describe('dependency package <-> repository correspondence', () => {
  const pkg = (over: Record<string, unknown> = {}) =>
    parseNpm(npmDoc(steady(), { homepage: 'https://github.com/acme/dep#readme', ...over }), C);

  it('the same package name proves nothing: the registry claim alone is only likely', () => {
    const p = pkg({ homepage: undefined });
    expect(p.repository.match).toBe('unknown'); // not decided at parse time: there is no analyzed repository
    expect(correspondDependency(p, []).match).toBe('likely');
  });

  it('confirmed needs a second source and a third pointer that agree', () => {
    expect(correspondDependency(pkg(), ['https://github.com/acme/dep']).match).toBe('confirmed');
    expect(
      correspondDependency(pkg({ homepage: undefined }), ['https://github.com/acme/dep']).match,
    ).toBe('likely');
  });

  it('disagreeing pointers are conflicting', () => {
    expect(correspondDependency(pkg(), ['https://github.com/evil/dep']).match).toBe('conflicting');
    expect(correspondDependency(pkg({ homepage: 'https://github.com/evil/dep' }), []).match).toBe(
      'conflicting',
    );
  });

  it('no source is missing; a non-GitHub host is not compared; a failed lookup is unknown', () => {
    expect(
      correspondDependency(pkg({ repository: undefined, homepage: undefined }), []).match,
    ).toBe('missing');
    expect(
      correspondDependency(pkg({ repository: { url: 'https://gitlab.com/acme/dep' } }), []).match,
    ).toBe('unknown');
    const failed = { ...pkg(), status: 'timeout' as const };
    expect(correspondDependency(failed, ['https://github.com/acme/dep']).match).toBe('unknown');
  });
});

// ---- end to end through the pipeline -----------------------------------------------------------------------------
async function run(
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> {
  return analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    scorecard: false,
    ...extra,
  });
}
const NAMES = ['bullmq', 'redis', 'eslint', 'vitest', 'lodash'];
const allWith = (doc: unknown): Record<string, unknown> =>
  Object.fromEntries(NAMES.map((n) => [`registry.npmjs.org/${n}`, doc]));

describe('dependency registry in a full analysis', () => {
  it('queries direct dependencies, reports coverage and validates against the schema', async () => {
    const r = await run(goodRepo({ registry: { 'registry.npmjs.org/bullmq': npmDoc(steady()) } }));
    expect(ReportSchema.safeParse(r).success).toBe(true);
    const d = r.dependency_registry_intel;
    expect(d.status).toBe('analyzed');
    expect(d.coverage.queried).toBe(d.coverage.eligible);
    expect(d.packages.find((p) => p.name === 'bullmq')?.status).toBe('ok');
    // everything else answered 404: unknown, never clean
    expect(d.packages.find((p) => p.name === 'redis')?.status).toBe('not_found');
    expect(d.coverage.failed).toBeGreaterThan(0);
    expect(r.facts.find((f) => f.id === 'registry.deps.lookup_complete')?.value).toBe(false);
    expect(r.facts.find((f) => f.id === 'registry.deps.publisher_changed')).toBeUndefined();
  });

  it('a publisher change shows up as an event, a finding, a fact and a timeline entry', async () => {
    const vs = steady();
    vs[7] = { ...vs[7]!, user: 'mallory' };
    const r = await run(goodRepo({ registry: allWith(npmDoc(vs)) }));
    const ev = r.dependency_registry_intel.events.filter(
      (e) => e.type === 'dependency_publisher_changed',
    );
    expect(ev.length).toBeGreaterThan(0);
    expect(r.facts.find((f) => f.id === 'registry.deps.publisher_changed')?.value).toBe(true);
    expect(r.findings.some((f) => /new to its sampled history/.test(f.title))).toBe(true);
    expect(
      r.timeline.events.some(
        (e) => e.type === 'dependency_publisher_changed' && e.entity?.startsWith('npm:'),
      ),
    ).toBe(true);
    for (const f of r.findings.filter((x) => x.id.startsWith('RR-DEPREG')))
      expect(f.intent).toBe('undetermined');
  });

  it('absence of events is stated only when every eligible package answered', async () => {
    const r = await run(goodRepo({ registry: allWith(npmDoc(steady())) }));
    expect(r.dependency_registry_intel.coverage.failed).toBe(0);
    expect(r.facts.find((f) => f.id === 'registry.deps.lookup_complete')?.value).toBe(true);
    expect(r.facts.find((f) => f.id === 'registry.deps.publisher_changed')?.value).toBe(false);
    expect(r.facts.find((f) => f.id === 'registry.deps.takeover_indicators')?.value).toBe(false);
  });

  it('dormancy, new publisher and install hook on ONE dependency form a takeover indicator', async () => {
    const old = Array.from({ length: 6 }, (_, i) => ({ v: `1.0.${i}`, ago: 1000 - i * 40 }));
    const vs: V[] = [...old, { v: '2.0.0', ago: 40, user: 'mallory', hook: true }];
    const reg = { ...allWith(npmDoc(steady())), 'registry.npmjs.org/bullmq': npmDoc(vs) };
    const r = await run(goodRepo({ registry: reg }));
    const c = r.timeline.correlations.find(
      (x) => x.pattern_id === 'dependency-dormancy-publisher-hook',
    );
    expect(c?.entity).toBe('npm:bullmq');
    expect(c?.statement).toMatch(/Intent is undetermined/);
    expect(r.facts.find((f) => f.id === 'registry.deps.takeover_indicators')?.value).toBe(true);
    expect(
      r.findings.some((f) => f.title === 'Dependency supply-chain takeover indicators observed'),
    ).toBe(true);
  });

  it('events of DIFFERENT dependencies never combine into one takeover indicator', async () => {
    const quiet = steady();
    const swap = quiet.map((v, i) => (i === 7 ? { ...v, user: 'mallory' } : v));
    const hook = quiet.map((v, i) => (i === 7 ? { ...v, hook: true } : v));
    const reg = {
      ...allWith(npmDoc(quiet)),
      'registry.npmjs.org/bullmq': npmDoc(swap),
      'registry.npmjs.org/redis': npmDoc(hook),
    };
    const r = await run(goodRepo({ registry: reg }));
    expect(r.timeline.correlations.filter((c) => c.pattern_id.startsWith('dependency-'))).toEqual(
      [],
    );
  });

  it.each([
    ['429', 'rate_limited'],
    ['500', 'server_error'],
    ['slow', 'timeout'],
    ['broken', 'malformed'],
    ['html', 'malformed'],
    ['big', 'too_large'],
  ])('lookup failure %s is %s: unknown, never clean', async (fail, status) => {
    const r = await run(goodRepo({ registryFail: { 'registry.npmjs.org/': fail } }));
    const d = r.dependency_registry_intel;
    expect(d.packages.length).toBeGreaterThan(0);
    for (const p of d.packages) {
      expect(p.status).toBe(status);
      expect(p.repository.match).toBe('unknown');
      expect(p.versions).toEqual([]);
    }
    expect(d.events).toEqual([]);
    expect(r.facts.find((f) => f.id === 'registry.deps.lookup_complete')?.value).toBe(false);
    // absence facts withheld: a failed registry cannot make dependencies look stable
    expect(r.facts.find((f) => f.id === 'registry.deps.publisher_changed')).toBeUndefined();
    expect(r.facts.find((f) => f.id === 'registry.deps.takeover_indicators')).toBeUndefined();
  });

  it('the package budget skips the lowest priority and says so', async () => {
    const r = await run(goodRepo(), { dependencyRegistryBudget: { maxDependencies: 2 } });
    const d = r.dependency_registry_intel;
    expect(d.coverage.queried).toBe(2);
    expect(d.coverage.skipped).toBe(d.coverage.eligible - 2);
    expect(d.skipped_counts['budget_dependencies']).toBe(d.coverage.skipped);
    expect(d.skipped.length).toBeGreaterThan(0);
    for (const s of d.skipped) {
      expect(s.reason).toBe('budget_dependencies');
      expect(s.priority.reasons.length).toBeGreaterThan(0);
    }
    // direct runtime dependencies were chosen first
    expect(d.packages.map((p) => p.name).sort()).toEqual(['bullmq', 'redis']);
    expect(d.limits_hit.join(' ')).toMatch(/not queried: dependency budget/);
    expect(d.coverage.ratio).toBeLessThan(1);
    expect(r.facts.find((f) => f.id === 'registry.deps.lookup_complete')?.value).toBe(false);
  });

  it('the request budget stops lookups; the rest are skipped, not failed', async () => {
    const r = await run(goodRepo(), {
      dependencyRegistryBudget: { maxRequests: 2, concurrency: 1 },
    });
    const d = r.dependency_registry_intel;
    expect(d.requests).toBe(2);
    expect(d.coverage.queried).toBe(2);
    expect(d.skipped_counts['budget_requests']).toBe(d.coverage.eligible - 2);
  });

  it('the time budget uses the injected clock', async () => {
    let t = NOW_MS;
    const clock: Clock = { now: () => new Date((t += 20_000)) };
    const r = await run(goodRepo(), {
      clock,
      dependencyRegistryBudget: { maxElapsedMs: 30_000, concurrency: 1 },
    });
    const d = r.dependency_registry_intel;
    expect(d.skipped_counts['budget_time']).toBeGreaterThan(0);
    expect(d.coverage.queried).toBeLessThan(d.coverage.eligible);
  });

  it('can be switched off, and is off when the registry is off', async () => {
    const a = await run(goodRepo(), { dependencyRegistry: false });
    const b = await run(goodRepo(), { registry: false });
    for (const r of [a, b]) {
      expect(r.dependency_registry_intel.status).toBe('disabled');
      expect(r.facts.some((f) => f.id.startsWith('registry.deps.'))).toBe(false);
    }
  });

  it('a package requested by several manifests is fetched once (run-local cache)', async () => {
    const base = goodRepo();
    const spec = goodRepo({
      files: {
        ...base.files,
        'packages/a/package.json': JSON.stringify({
          name: 'a',
          dependencies: { bullmq: '^5.0.0' },
        }),
        'packages/b/package.json': JSON.stringify({
          name: 'b',
          dependencies: { bullmq: '^5.0.0' },
        }),
      },
    });
    await run(spec);
    expect(spec.registryRequests.filter((u) => u.endsWith('/bullmq'))).toHaveLength(1);
  });

  it('never sends a token to a registry', async () => {
    const seen: string[] = [];
    const spec = goodRepo();
    const inner = fakeFetch(spec);
    await analyzeRepository(`${spec.owner}/${spec.repo}`, {
      fetch: async (url, init) => {
        if (!String(url).startsWith('https://api.github.com'))
          seen.push(JSON.stringify((init as RequestInit | undefined)?.headers ?? {}));
        return inner(url, init);
      },
      clock: fixedClock,
      token: 'ghp_SECRETSECRETSECRET1234567890abcd',
      scorecard: false,
    });
    expect(seen.join('')).not.toContain('SECRETSECRET');
  });
});
