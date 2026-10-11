import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { analyzeGovernance, type GovernanceInput } from '../../src/governance/temporal.js';
import { compareSnapshots } from '../../src/history/index.js';
import { ProfileSchema } from '../../src/scoring/types.js';
import { effectiveBlocks, evaluateHistoryBlocks } from '../../src/scoring/policy.js';
import { installerRepo } from '../helpers/code-scenarios.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const DAY = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString();
const T0 = Date.parse('2024-01-01T00:00:00Z');
/** n commits, one every `step` days from `start`, authored by `login`. */
const commits = (start: number, n: number, step: number, login: string) =>
  Array.from({ length: n }, (_, i) => ({ date: iso(start + i * step * DAY), login }));
const input = (over: Partial<GovernanceInput>): GovernanceInput => ({
  commits: [],
  releases: [],
  contributors: [],
  ...over,
});

describe('temporal governance signals', () => {
  it('too little data is "insufficient_data", never a clean bill', () => {
    expect(analyzeGovernance(input({ commits: commits(T0, 3, 10, 'a') })).status).toBe(
      'insufficient_data',
    );
  });

  it('a steady single-team history shows no dormancy and no takeover indicators', () => {
    const g = analyzeGovernance(
      input({
        commits: [...commits(T0, 30, 5, 'a'), ...commits(T0 + 1 * DAY, 30, 5, 'b')],
        releases: [0, 1, 2, 3].map((i) => ({
          tag: `v${i}`,
          date: iso(T0 + i * 40 * DAY),
          author: 'a',
        })),
      }),
    );
    expect(g.status).toBe('analyzed');
    expect(g.signals.some((s) => s.kind === 'dormancy_gap')).toBe(false);
    expect(g.takeover_indicators?.observed).toBe(false);
  });

  it('dormancy, then a new account, then a release soon after is reported as indicators, with intent undetermined', () => {
    const early = commits(T0, 20, 10, 'old-maintainer'); // ends ~T0+190d
    const resume = T0 + 190 * DAY + 400 * DAY;
    const late = commits(resume, 12, 1, 'newcomer');
    const g = analyzeGovernance(
      input({
        commits: [...early, ...late],
        releases: [
          ...[0, 1, 2].map((i) => ({
            tag: `v${i}`,
            date: iso(T0 + i * 60 * DAY),
            author: 'old-maintainer',
          })),
          { tag: 'v3', date: iso(resume + 5 * DAY), author: 'newcomer' },
        ],
      }),
    );
    const kinds = g.signals.map((s) => s.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'dormancy_gap',
        'new_committer_after_dormancy',
        'release_after_dormancy',
        'new_release_author',
      ]),
    );
    expect(g.takeover_indicators?.observed).toBe(true);
    expect(g.takeover_indicators?.statement).toMatch(/Intent is undetermined/);
    for (const s of g.signals) {
      expect(s.confidence).toBeLessThan(0.9);
      expect(s.window.length).toBeGreaterThan(0);
    }
  });

  it('roles stay distinct: a release author who never committed is not called a maintainer or a new committer', () => {
    const g = analyzeGovernance(
      input({
        commits: commits(T0, 30, 3, 'dev'),
        releases: [0, 1, 2].map((i) => ({
          tag: `v${i}`,
          date: iso(T0 + i * 30 * DAY),
          author: i === 2 ? 'robot' : 'dev',
        })),
      }),
    );
    const s = g.signals.find((x) => x.kind === 'release_author_not_committer');
    expect(s?.role).toBe('release_author');
    expect(JSON.stringify(g)).not.toMatch(/maintainer changed/i);
    expect(g.takeover_indicators?.observed).toBe(false);
  });

  it('concentration is descriptive and is not part of a takeover sequence', () => {
    const g = analyzeGovernance(input({ commits: commits(T0, 40, 2, 'solo') }));
    expect(g.signals.find((s) => s.kind === 'contributor_concentration')).toBeDefined();
    expect(g.takeover_indicators?.observed).toBe(false);
  });

  it('malformed dates are ignored rather than crashing', () => {
    expect(() =>
      analyzeGovernance(
        input({ commits: [{ date: 'garbage', login: 'x' }, ...commits(T0, 12, 3, 'a')] }),
      ),
    ).not.toThrow();
  });

  it('is part of every report, and the limitations name the sampled window', async () => {
    const spec = goodRepo();
    const r = await analyzeRepository('acme/widget', { fetch: fakeFetch(spec), clock: fixedClock });
    expect(r.governance.version).toBe('1');
    expect(r.governance.limitations.join(' ')).toMatch(/latest 100/);
  });
});

describe('policy: require and history_block', () => {
  const profile = (extra: Record<string, unknown>) =>
    ProfileSchema.parse({ id: 'p', version: '1', title: 'P', description: 'd', ...extra });

  it('require compiles into blocks; strict also blocks when the evidence is unknown', () => {
    const lax = effectiveBlocks(profile({ require: { sbom: true, signed_release: true } }));
    expect(lax.map((b) => b.id)).toEqual(['require-sbom', 'require-signed-release']);
    expect(lax.every((b) => b.on_unknown === 'ignore')).toBe(true);
    const strict = effectiveBlocks(
      profile({ require: { provenance: 'strict', checksums: false } }),
    );
    expect(strict.map((b) => [b.id, b.on_unknown])).toEqual([['require-provenance', 'block']]);
  });

  it('unknown keys in require or history_block are rejected', () => {
    expect(
      ProfileSchema.safeParse({
        id: 'p',
        version: '1',
        title: 'P',
        description: 'd',
        require: { shell: true },
      }).success,
    ).toBe(false);
    expect(
      ProfileSchema.safeParse({
        id: 'p',
        version: '1',
        title: 'P',
        description: 'd',
        history_block: [
          { id: 'abc', description: 'long enough', kind: 'new_install_hook', run: 'x' },
        ],
      }).success,
    ).toBe(false);
  });

  const run = (spec: FakeSpec, extra: Parameters<typeof analyzeRepository>[1] = {}) =>
    analyzeRepository(`${spec.owner}/${spec.repo}`, {
      fetch: fakeFetch(spec),
      clock: fixedClock,
      ...extra,
    });

  it('a missing signature or provenance blocks only when the lookup worked; a failed lookup is not a violation', async () => {
    const p = profile({ require: { signed_release: true, provenance: true } });
    expect(effectiveBlocks(p)).toHaveLength(2);
    const spec = goodRepo();
    spec.releases = [
      { daysAgo: 5, detail: { tag: 'v1', commit: 'c'.repeat(40), assets: { 'a.zip': 'x' } } },
    ];
    const ok = await run(spec, { profile: 'enterprise' });
    const facts = new Map(ok.facts.map((f) => [f.id, f.value]));
    expect(facts.get('release.tag.signature_verified')).toBe(false);
    expect(facts.get('release.provenance.present')).toBe(false);
    const failing = goodRepo();
    failing.releases = spec.releases;
    failing.failing = ['/git/ref/tags/'];
    const f2 = await run(failing);
    const facts2 = new Map(f2.facts.map((f) => [f.id, f.value]));
    expect(facts2.has('release.tag.signature_verified')).toBe(false); // unknown, not "unsigned"
  });

  it('history rules fire on observed additions only', async () => {
    const before = await run(goodRepo());
    const after = await run(installerRepo());
    const d = compareSnapshots(before, after);
    const v = evaluateHistoryBlocks(
      profile({
        history_block: [
          { id: 'new-hook', description: 'a new install hook', kind: 'new_install_hook' },
          {
            id: 'new-remote',
            description: 'new remote execution',
            kind: 'new_install_time_remote_execution',
          },
          {
            id: 'new-proc',
            description: 'new PROCESS_EXEC',
            kind: 'new_capability',
            capability: 'PROCESS_EXEC',
          },
          { id: 'new-vuln', description: 'new vulnerability', kind: 'new_vulnerability' },
        ],
      }).history_block,
      d,
    );
    expect(v.map((x) => x.id)).toEqual(
      expect.arrayContaining(['new-hook', 'new-remote', 'new-proc']),
    );
    expect(v.map((x) => x.id)).not.toContain('new-vuln');
    const reverse = evaluateHistoryBlocks(
      profile({
        history_block: [
          { id: 'new-hook', description: 'a new install hook', kind: 'new_install_hook' },
        ],
      }).history_block,
      compareSnapshots(after, before),
    );
    expect(reverse).toEqual([]);
  });

  it('a new install hook plus takeover indicators in the later window is called out as a combined sequence', () => {
    const base = {
      governance: { takeover_indicators: { observed: false } },
      code_analysis: {
        execution: { hooks: [], chains: [] },
        scan: { performed: true, source_coverage: 1 },
        capabilities: { summary: [] },
      },
    };
    const hook = {
      id: 'H1',
      ecosystem: 'npm',
      name: 'postinstall',
      runs_for_dependents: true,
      risk: 'high',
      chain_ids: [],
      files: ['x.js'],
    };
    const after = JSON.parse(JSON.stringify(base)) as typeof base & Record<string, unknown>;
    (
      after.governance as { takeover_indicators: { observed: boolean } }
    ).takeover_indicators.observed = true;
    (after.code_analysis.execution.hooks as unknown[]).push(hook);
    const d = compareSnapshots(base, after);
    expect(d.governance.combined_sequence).toMatch(/Intent is undetermined/);
    expect(d.risk.reasons.some((r) => /takeover risk indicators/.test(r.text))).toBe(true);
    const hits = evaluateHistoryBlocks(
      profile({
        history_block: [
          {
            id: 'combo',
            description: 'hook with takeover indicators',
            kind: 'takeover_indicators_with_new_install_hook',
          },
        ],
      }).history_block,
      d,
    );
    expect(hits).toHaveLength(1);
  });
});
