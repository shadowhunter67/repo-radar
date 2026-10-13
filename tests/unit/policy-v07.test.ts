import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import type { ComplianceContext } from '../../src/compliance/applicability.js';
import { loadProfile } from '../../src/profiles/load.js';
import {
  effectiveBlocks,
  evaluateBlocks,
  evaluateHistoryBlocks,
} from '../../src/scoring/policy.js';
import { ProfileSchema, type Profile } from '../../src/scoring/types.js';
import type { Report } from '../../src/report/schema.js';
import { compareSnapshots } from '../../src/history/delta.js';
import { fakeFetch, fixedClock, NOW, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const DAY = 86_400_000;
const iso = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

const profile = (extra: Record<string, unknown>): Profile =>
  ProfileSchema.parse({ id: 'p', version: '1', title: 'P', description: 'd', ...extra });

/** Block evaluation only reads facts: a context made of a report's facts is enough to test policy semantics. */
const ctxOf = (r: Report): ComplianceContext =>
  ({
    fact: (id: string) => {
      const f = r.facts.find((x) => x.id === id);
      return f ? { value: f.value, confidence: f.confidence } : undefined;
    },
  }) as unknown as ComplianceContext;
const violations = (r: Report, p: Profile) => evaluateBlocks(effectiveBlocks(p), ctxOf(r));

interface V {
  v: string;
  ago: number;
  user?: string;
  prov?: boolean;
  hook?: boolean;
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
        ...(x.hook ? { hasInstallScript: true, scripts: { postinstall: 'x' } } : {}),
        maintainers: [{ name: 'alice' }],
        dist: {
          integrity: 'sha512-x',
          ...(x.prov ? { attestations: { url: 'u', provenance: { predicateType: 'p' } } } : {}),
        },
      },
    ]),
  ),
});
const steady = (patch: Partial<V> = {}, prov = false): V[] =>
  Array.from({ length: 8 }, (_, i) => ({
    v: `1.0.${i}`,
    ago: 270 - i * 30,
    prov,
    ...(i === 7 ? patch : {}),
  }));
const NAMES = ['bullmq', 'redis', 'eslint', 'vitest', 'lodash'];
const reg = (doc: unknown): Record<string, unknown> =>
  Object.fromEntries(NAMES.map((n) => [`registry.npmjs.org/${n}`, doc]));

async function run(
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> {
  return analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    scorecard: false,
    osv: false,
    depsDev: false,
    ...extra,
  });
}

describe('new require keys', () => {
  it('compile to blocks whose unknown handling follows the value: true ignores unknown, strict blocks it', () => {
    const p = profile({
      require: {
        dependency_publisher_stability: true,
        dependency_registry_match: 'strict',
        dependency_provenance_reported: true,
        no_dependency_takeover_indicators: 'strict',
        locally_verified_signature: true,
      },
    });
    const blocks = effectiveBlocks(p);
    const by = Object.fromEntries(blocks.map((b) => [b.id, b.on_unknown]));
    expect(by).toEqual({
      'require-locally-verified-signature': 'ignore',
      'require-dependency-registry-match': 'block',
      'require-dependency-publisher-stability': 'ignore',
      'require-dependency-provenance-reported': 'ignore',
      'require-no-dependency-takeover-indicators': 'block',
    });
    expect(
      effectiveBlocks(profile({ require: { dependency_publisher_stability: false } })),
    ).toEqual([]);
  });

  it('a publisher change in a dependency violates dependency_publisher_stability', async () => {
    const r = await run(goodRepo({ registry: reg(npmDoc(steady({ user: 'mallory' }))) }));
    const v = violations(r, profile({ require: { dependency_publisher_stability: true } }));
    expect(v.map((x) => [x.id, x.reason])).toEqual([
      ['require-dependency-publisher-stability', 'condition_true'],
    ]);
    expect(v[0]?.evidence).toContain('registry.deps.publisher_changed');
  });

  it('a stable history passes; a failed lookup is unknown and blocks only under strict', async () => {
    const stable = await run(goodRepo({ registry: reg(npmDoc(steady())) }));
    expect(
      violations(stable, profile({ require: { dependency_publisher_stability: 'strict' } })),
    ).toEqual([]);
    const failed = await run(goodRepo({ registryFail: { 'registry.npmjs.org/': '500' } }));
    expect(failed.facts.some((f) => f.id === 'registry.deps.publisher_changed')).toBe(false);
    expect(
      violations(failed, profile({ require: { dependency_publisher_stability: true } })),
    ).toEqual([]);
    const strict = violations(
      failed,
      profile({ require: { dependency_publisher_stability: 'strict' } }),
    );
    expect(strict.map((x) => x.reason)).toEqual(['undecidable']);
    expect(strict[0]?.missing).toEqual(['registry.deps.publisher_changed']);
  });

  it('a skipped (over budget) dependency never reads as stable: absence facts are withheld', async () => {
    const r = await run(goodRepo({ registry: reg(npmDoc(steady())) }), {
      dependencyRegistryBudget: { maxDependencies: 1 },
    });
    expect(r.facts.find((f) => f.id === 'registry.deps.publisher_changed')).toBeUndefined();
    const v = violations(r, profile({ require: { dependency_publisher_stability: 'strict' } }));
    expect(v.map((x) => x.reason)).toEqual(['undecidable']);
  });

  it('dependency_provenance_reported blocks when a looked-up npm dependency reports none', async () => {
    const none = await run(goodRepo({ registry: reg(npmDoc(steady())) }));
    expect(
      violations(none, profile({ require: { dependency_provenance_reported: true } })).map(
        (x) => x.id,
      ),
    ).toEqual(['require-dependency-provenance-reported']);
    const withProv = npmDoc(
      Array.from({ length: 8 }, (_, i) => ({ v: `1.0.${i}`, ago: 270 - i * 30, prov: true })),
    );
    const ok = await run(goodRepo({ registry: reg(withProv) }));
    expect(violations(ok, profile({ require: { dependency_provenance_reported: true } }))).toEqual(
      [],
    );
  });

  it('takeover indicators block; their absence does not', async () => {
    const old = Array.from({ length: 6 }, (_, i) => ({ v: `1.0.${i}`, ago: 1000 - i * 40 }));
    const hot = npmDoc([...old, { v: '2.0.0', ago: 40, user: 'mallory', hook: true }]);
    const r = await run(
      goodRepo({ registry: { ...reg(npmDoc(steady())), 'registry.npmjs.org/bullmq': hot } }),
    );
    const v = violations(r, profile({ require: { no_dependency_takeover_indicators: true } }));
    expect(v.map((x) => x.id)).toEqual(['require-no-dependency-takeover-indicators']);
    const calm = await run(goodRepo({ registry: reg(npmDoc(steady())) }));
    expect(
      violations(calm, profile({ require: { no_dependency_takeover_indicators: 'strict' } })),
    ).toEqual([]);
  });

  it('locally_verified_signature is unknown without trust configuration and blocks only under strict', async () => {
    const spec = goodRepo({
      releases: [
        {
          daysAgo: 5,
          detail: {
            tag: 'v1',
            commit: 'c'.repeat(40),
            assets: { 'a.tar.gz': 'x', 'a.tar.gz.asc': 'y' },
          },
        },
      ],
    });
    const r = await run(spec);
    expect(r.facts.some((f) => f.id === 'release.signatures.locally_verified')).toBe(false);
    expect(violations(r, profile({ require: { locally_verified_signature: true } }))).toEqual([]);
    expect(
      violations(r, profile({ require: { locally_verified_signature: 'strict' } })).map(
        (x) => x.reason,
      ),
    ).toEqual(['undecidable']);
  });

  it('the shipped profiles do not enforce any of the new requirements (migration is a separate decision)', () => {
    const NEW = [
      'locally_verified_signature',
      'dependency_registry_match',
      'dependency_publisher_stability',
      'dependency_provenance_reported',
      'no_dependency_takeover_indicators',
    ];
    for (const id of ['default', 'startup', 'enterprise']) {
      const req = loadProfile(id).require as Record<string, unknown>;
      for (const k of NEW) expect(req[k], `${id}.${k}`).toBeUndefined();
    }
  });
});

describe('temporal and history blocks for the new signals', () => {
  it('a temporal block can use the dependency takeover pattern', async () => {
    const old = Array.from({ length: 6 }, (_, i) => ({ v: `1.0.${i}`, ago: 1000 - i * 40 }));
    const hot = npmDoc([...old, { v: '2.0.0', ago: 40, user: 'mallory', hook: true }]);
    const r = await run(
      goodRepo({ registry: { ...reg(npmDoc(steady())), 'registry.npmjs.org/bullmq': hot } }),
    );
    const { evaluateTemporalBlocks } = await import('../../src/scoring/policy.js');
    const p = profile({
      temporal_block: [
        {
          id: 'dep-takeover',
          description: 'a dependency shows takeover indicators',
          pattern: 'dependency-takeover-indicators',
        },
      ],
    });
    expect(evaluateTemporalBlocks(p.temporal_block, r.timeline).map((x) => x.id)).toEqual([
      'dep-takeover',
    ]);
    const quiet = await run(goodRepo({ registry: reg(npmDoc(steady())) }));
    expect(evaluateTemporalBlocks(p.temporal_block, quiet.timeline)).toEqual([]);
  });

  it('history blocks: a lost verification, a source-binding conflict and a new install-time domain', () => {
    const diff = {
      dependencies: [],
      execution: [],
      capabilities: [],
      governance: { takeover_indicators_after: false },
      domains: [
        {
          kind: 'introduced',
          hostname: 'dl.vendor.io',
          category: 'generic_external',
          significance: 'active',
          certainty: 'observed',
          after: { strongest_context: 'install' },
        },
        {
          kind: 'introduced',
          hostname: 'registry.npmjs.org',
          category: 'registry',
          significance: 'active',
          certainty: 'observed',
          after: { strongest_context: 'install' },
        },
        {
          kind: 'introduced',
          hostname: 'docs.vendor.io',
          category: 'generic_external',
          significance: 'passive',
          certainty: 'observed',
          after: { strongest_context: 'docs' },
        },
      ],
      provenance: [
        {
          kind: 'provenance_verification_changed',
          subject: 'release v1',
          before: 'verified',
          after: 'not verified',
        },
        {
          kind: 'source_binding_changed',
          subject: 'release v1',
          before: 'verified_source_binding',
          after: 'source_binding_conflict',
        },
      ],
    };
    const hits = evaluateHistoryBlocks(
      [
        {
          id: 'no-install-domain',
          description: 'no new install-time domain',
          kind: 'new_install_time_domain',
        },
        {
          id: 'keep-provenance',
          description: 'verification must not be lost',
          kind: 'provenance_verification_lost',
        },
        {
          id: 'no-binding-conflict',
          description: 'no binding conflict',
          kind: 'source_binding_conflict',
        },
      ],
      diff,
    );
    expect(Object.fromEntries(hits.map((h) => [h.id, h.subjects]))).toEqual({
      'no-install-domain': ['dl.vendor.io'], // registry hosts are expected at install time; passive docs never count
      'keep-provenance': ['release v1'],
      'no-binding-conflict': ['release v1'],
    });
  });

  it('inconclusive removals and unknown states never trigger history blocks', async () => {
    const a = await run(goodRepo({ registry: reg(npmDoc(steady())) }));
    const b = await run(goodRepo({ registry: reg(npmDoc(steady())) }));
    const diff = compareSnapshots(a, b);
    const hits = evaluateHistoryBlocks(
      [
        { id: 'x1', description: 'no new install-time domain', kind: 'new_install_time_domain' },
        {
          id: 'x2',
          description: 'verification must not be lost',
          kind: 'provenance_verification_lost',
        },
        { id: 'x3', description: 'no binding conflict', kind: 'source_binding_conflict' },
      ],
      diff,
    );
    expect(hits).toEqual([]);
  });
});
