import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { analyzeWorkflow } from '../../src/collectors/github/workflows.js';
import { scoreValue } from '../../src/scoring/engine.js';
import { loadRuleSet } from '../../src/scoring/rules.js';
import type { Report } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const run = (
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    ...extra,
  });
const ev = (r: Report, id: string) => r.evidence.find((e) => e.id === id);
const dim = (r: Report, d: string) => r.dimensions.find((x) => x.dimension === d)!;

describe('commit count from the Link header', () => {
  it('reads the page count of rel="last" from a realistic multi-link header', async () => {
    expect(ev(await run(goodRepo({ commitsTotal: 877 })), 'github.commits.total')?.value).toBe(877);
  });
  it('handles page= not being the last query parameter and reversed link order', async () => {
    const base = 'https://api.github.com/repos/acme/widget/commits';
    const r = await run(
      goodRepo({
        linkHeader: `<${base}?page=42&per_page=1>; rel="last", <${base}?page=2&per_page=1>; rel="next"`,
      }),
    );
    expect(ev(r, 'github.commits.total')?.value).toBe(42);
  });
  it('an unreadable Link header yields NO total (never a misleading 1) and a diagnostic', async () => {
    const r = await run(
      goodRepo({ linkHeader: '<https://api.github.com/x?page=abc>; rel="last"' }),
    );
    expect(ev(r, 'github.commits.total')).toBeUndefined();
    expect(r.diagnostics.some((d) => d.code === 'commit_count_unparsed')).toBe(true);
    const rule = dim(r, 'maintenance').rules.find(
      (x) => x.rule_id === 'maintenance.history-depth',
    )!;
    expect(rule.status).toBe('not_observed');
    expect(rule.missing_reason).toBe('unavailable');
  });
  it('a single-commit repository (no Link header) has total 1', async () => {
    const r = await run(goodRepo({ commitsTotal: 1, commitDaysAgo: [5], linkHeader: '' }));
    expect(ev(r, 'github.commits.total')?.value).toBe(1);
  });
});

describe('contributors / bus factor', () => {
  it('excludes bots and computes the smallest set covering half the commits', async () => {
    const r = await run(
      goodRepo({
        contributors: [
          { login: 'dependabot[bot]', contributions: 500, type: 'Bot' },
          { login: 'renovate[bot]', contributions: 500 },
          { login: 'a', contributions: 40 },
          { login: 'b', contributions: 30 },
          { login: 'c', contributions: 30 },
        ],
      }),
    );
    expect(ev(r, 'github.contributors.count')?.value).toBe(3);
    expect(ev(r, 'github.contributors.bus_factor')?.value).toBe(2);
    expect(ev(r, 'github.contributors.top_share')?.value).toBe(0.4);
  });
  it('a lone human contributor has bus factor 1 and triggers the warning', async () => {
    const r = await run(goodRepo({ contributors: [{ login: 'solo', contributions: 10 }] }));
    expect(ev(r, 'github.contributors.bus_factor')?.value).toBe(1);
    expect(r.warnings.some((w) => /bus factor 1/.test(w.message))).toBe(true);
  });
  it('code review is not applicable to a solo maintainer (not scored as zero)', async () => {
    const r = await run(goodRepo({ contributors: [{ login: 'solo', contributions: 10 }] }));
    expect(dim(r, 'security').rules.find((x) => x.rule_id === 'security.code-review')!.status).toBe(
      'not_applicable',
    );
  });
  it('only bots / zero contributions: no NaN, no bus factor evidence', async () => {
    const r = await run(
      goodRepo({
        contributors: [
          { login: 'x[bot]', contributions: 9, type: 'Bot' },
          { login: 'zero', contributions: 0 },
        ],
      }),
    );
    expect(ev(r, 'github.contributors.bus_factor')).toBeUndefined();
    expect(ev(r, 'github.contributors.top_share')).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/NaN|null,"value"/);
  });
});

describe('releases', () => {
  it('ignores drafts and releases without a publish date', async () => {
    const r = await run(
      goodRepo({
        releases: [
          { daysAgo: 1, draft: true },
          { daysAgo: 2, noDate: true },
          { daysAgo: 400, assets: ['a.tgz'] },
        ],
      }),
    );
    expect(ev(r, 'github.releases.latest_age_days')?.value).toBe(400);
    expect(ev(r, 'github.releases.median_gap_days')).toBeUndefined();
  });
  it('median gap needs at least three releases and uses the median, not the mean', async () => {
    const r = await run(
      goodRepo({ releases: [{ daysAgo: 10 }, { daysAgo: 20 }, { daysAgo: 30 }, { daysAgo: 330 }] }),
    );
    expect(ev(r, 'github.releases.median_gap_days')?.value).toBe(10);
  });
});

describe('inherited files and truncation', () => {
  it('community profile files count as present, flagged as inherited', async () => {
    const spec = goodRepo({
      community: { code_of_conduct: { name: 'CoC' }, contributing: { url: 'x' } },
    });
    delete spec.files['CODE_OF_CONDUCT.md'];
    delete spec.files['CONTRIBUTING.md'];
    const r = await run(spec);
    const coc = ev(r, 'github.file.code_of_conduct')!;
    expect(coc.value).toBe(true);
    expect(JSON.stringify(coc.metadata)).toMatch(/inherited/);
    expect(ev(r, 'github.file.contributing')?.value).toBe(true);
    expect(ev(r, 'github.file.issue_templates')?.metadata).toEqual({});
  });
  it('a local file is reported without the inherited marker', async () => {
    const r = await run(goodRepo({ community: { code_of_conduct: { name: 'CoC' } } }));
    expect(ev(r, 'github.file.code_of_conduct')?.metadata).toEqual({});
  });
  it('SECURITY.md inherited from the owner .github repo counts as a security policy', async () => {
    const spec = goodRepo({ orgFiles: { 'SECURITY.md': 'report privately' } });
    delete spec.files['SECURITY.md'];
    const r = await run(spec);
    expect(ev(r, 'github.file.security_policy')?.value).toBe(true);
    expect(JSON.stringify(ev(r, 'github.file.security_policy')?.metadata)).toMatch(/inherited/);
  });
  it('without any SECURITY.md anywhere the policy is reported missing and warned about', async () => {
    const spec = goodRepo();
    delete spec.files['SECURITY.md'];
    const r = await run(spec);
    expect(ev(r, 'github.file.security_policy')?.value).toBe(false);
    expect(r.warnings.some((w) => /security policy/i.test(w.message))).toBe(true);
  });
  it('on a truncated tree, presence of tests stays certain while absence is uncertain', async () => {
    const present = await run(goodRepo({ treeTruncated: true }));
    expect(ev(present, 'github.tree.has_tests')).toMatchObject({ value: true, confidence: 1 });
    const spec = goodRepo({ treeTruncated: true });
    for (const k of Object.keys(spec.files)) if (k.startsWith('tests/')) delete spec.files[k];
    const absent = await run(spec);
    expect(ev(absent, 'github.tree.has_tests')).toMatchObject({ value: false, confidence: 0.6 });
  });
});

describe('workflow detection edge cases', () => {
  const sha40 = 'a'.repeat(40);
  const used = (ref: string) =>
    analyzeWorkflow(`on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${ref}\n`)
      .pinnedActions;
  it('only a full 40-hex SHA counts as pinned (case-insensitive)', () => {
    expect(used(sha40)).toBe(1);
    expect(used(sha40.toUpperCase())).toBe(1);
    expect(used('a'.repeat(39))).toBe(0);
    expect(used('a'.repeat(41))).toBe(0);
    expect(used('v4')).toBe(0);
    expect(used('main')).toBe(0);
    expect(used('g'.repeat(40))).toBe(0);
  });
  const prt = (withBlock: string) =>
    analyzeWorkflow(
      `on: pull_request_target\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n${withBlock}\n`,
    ).dangerousCheckout;
  it.each([
    ['          ref: ${{ github.event.pull_request.head.sha }}', true],
    ['          ref: ${{ github.head_ref }}', true],
    ['          ref: refs/pull/${{ github.event.number }}/merge', true],
    ['          repository: ${{ github.event.pull_request.head.repo.full_name }}', true],
    ['          fetch-depth: 0', false],
    ['          ref: main', false],
  ])('pull_request_target checkout with %s -> dangerous=%s', (block, expected) => {
    expect(prt(block)).toBe(expected);
  });
  it('write-all and absent permissions are not least-privilege declarations', () => {
    expect(
      analyzeWorkflow('on: push\npermissions: write-all\njobs:\n  a:\n    steps: []')
        .hasPermissions,
    ).toBe(false);
    expect(
      analyzeWorkflow('on: push\npermissions: {}\njobs:\n  a:\n    steps: []').hasPermissions,
    ).toBe(true);
    expect(analyzeWorkflow('on: push\njobs: {}').hasPermissions).toBe(false);
  });
});

describe('OSV and Scorecard resilience', () => {
  it('survives null / malformed entries in the OSV response', async () => {
    const r = await run(
      goodRepo({ osvRaw: { results: [null, {}, { vulns: [{ id: 'GHSA-1' }, null] }] } }),
    );
    expect(ev(r, 'osv.vulnerable_packages')?.value).toBe(1);
    expect(r.diagnostics.some((d) => d.code === 'osv_failed')).toBe(false);
  });
  it('a result count mismatch is discarded entirely, not partially trusted', async () => {
    const r = await run(goodRepo({ osvRaw: { results: [{ vulns: [{ id: 'X' }] }] } }));
    expect(ev(r, 'osv.vulnerable_packages')).toBeUndefined();
    expect(r.diagnostics.some((d) => d.code === 'osv_mismatch')).toBe(true);
    expect(
      dim(r, 'security').rules.find((x) => x.rule_id === 'security.known-vulnerabilities')!
        .missing_reason,
    ).toBe('unavailable');
  });
  it('a missing results field is handled', async () => {
    const r = await run(goodRepo({ osvRaw: {} }));
    expect(ev(r, 'osv.vulnerable_packages')).toBeUndefined();
  });
  it.each([
    ['not-a-date', 0.8],
    ['2030-01-01T00:00:00Z', 0.8],
    ['2025-12-25T00:00:00Z', 1],
    ['2025-06-01T00:00:00Z', 0.7],
    ['2020-01-01T00:00:00Z', 0.4],
  ])('Scorecard date %s -> evidence confidence %s', async (date, conf) => {
    const spec = goodRepo();
    spec.scorecard!.date = date;
    expect(ev(await run(spec), 'scorecard.check.maintained')?.confidence).toBe(conf);
  });
  it('no pinned versions anywhere: vulnerability check reported as not run, not as clean', async () => {
    const spec = goodRepo();
    delete spec.files['package-lock.json'];
    const r = await run(spec);
    expect(ev(r, 'osv.vulnerable_ratio')).toBeUndefined();
    expect(r.diagnostics.some((d) => d.code === 'osv_no_exact_versions')).toBe(true);
  });
});

describe('every rule scores in the direction it claims', () => {
  const rs = loadRuleSet();
  const byId = new Map(rs.rules.map((r) => [r.id, r]));
  /** value that is "worse" is larger (lower-better evidence) or smaller (higher-better evidence) */
  const lowerIsBetter: Record<string, number[]> = {
    'security.known-vulnerabilities': [0, 0.001, 0.03, 0.07, 0.2],
    'maintenance.recent-activity': [1, 100, 200, 400, 800],
    'maintenance.release-recency': [1, 100, 200, 400, 800],
    'maintenance.issue-resolution': [1, 5, 20, 70, 200],
    'maintenance.pr-resolution': [0.5, 3, 10, 40, 100],
    'maintenance.stale-issues': [0, 0.25, 0.5, 1],
    'maintenance.stale-prs': [0, 0.25, 0.5, 1],
    'maintenance.release-cadence': [10, 100, 200, 400],
    'community.top-contributor-share': [0.3, 0.5, 0.8, 1],
    'supply-chain.dependency-count': [5, 50, 150],
  };
  const higherIsBetter: Record<string, number[]> = {
    'maintenance.commit-frequency': [0, 1, 3, 10, 30],
    'maintenance.bus-factor': [1, 2, 3, 5],
    'maintenance.history-depth': [1, 3, 10, 50, 200],
    'code-quality.test-ratio': [0, 0.02, 0.1, 0.25, 0.5],
    'community.contributor-count': [1, 2, 5, 20],
    'community.distinct-authors': [1, 2, 4, 10],
    'documentation.readme-depth': [0, 100, 300, 800, 2000],
    'documentation.examples': [0, 1, 3],
    'semantic-clarity.topics': [0, 1, 3],
    'semantic-clarity.description-quality': [0, 10, 25],
    'semantic-clarity.detected-purpose': [0, 0.3, 0.9],
    'security.token-permissions': [0, 0.5, 1],
    'supply-chain.pinned-actions': [0, 0.5, 1],
    'code-quality.ci-present': [0, 1],
  };
  const scores = (id: string, values: number[]): number[] =>
    values.map((v) => scoreValue(v, byId.get(id)!.scoring) as number);
  it.each(Object.entries(lowerIsBetter))('%s: larger value never scores higher', (id, values) => {
    const s = scores(id, values);
    for (let i = 1; i < s.length; i++)
      expect(s[i]!, `${id} @${values[i]}`).toBeLessThanOrEqual(s[i - 1]!);
    expect(s[0]!).toBeGreaterThan(s[s.length - 1]!);
  });
  it.each(Object.entries(higherIsBetter))('%s: larger value never scores lower', (id, values) => {
    const s = scores(id, values);
    for (let i = 1; i < s.length; i++)
      expect(s[i]!, `${id} @${values[i]}`).toBeGreaterThanOrEqual(s[i - 1]!);
    expect(s[s.length - 1]!).toBeGreaterThan(s[0]!);
  });
  it('boolean "bad thing present" rules score the bad value lower', () => {
    for (const id of [
      'security.dangerous-workflow',
      'security.expression-injection',
      'maintenance.not-archived',
    ]) {
      const sc = byId.get(id)!.scoring;
      const bad = id === 'maintenance.not-archived' ? true : true;
      expect(scoreValue(bad, sc), id).toBeLessThan(scoreValue(!bad, sc)!);
    }
    for (const id of ['code-quality.ci-without-tests', 'code-quality.readme-heavy']) {
      expect(scoreValue(true, byId.get(id)!.scoring), id).toBeLessThan(
        scoreValue(false, byId.get(id)!.scoring)!,
      );
    }
    const lic = byId.get('supply-chain.license-detected')!.scoring;
    expect(scoreValue('none', lic)).toBeLessThan(scoreValue('NOASSERTION', lic)!);
    expect(scoreValue('NOASSERTION', lic)).toBeLessThan(scoreValue('MIT', lic)!);
  });
  it('every rule listed in the direction tables exists', () => {
    for (const id of [...Object.keys(lowerIsBetter), ...Object.keys(higherIsBetter)])
      expect(byId.has(id), id).toBe(true);
  });
});

describe('hostile-input performance (ReDoS regression)', () => {
  const wf = (run: string): string =>
    `on: push\njobs:\n  a:\n    steps:\n      - run: ${JSON.stringify(run)}\n`;

  it('a 400 KB single-line run script cannot stall workflow analysis', () => {
    // Before the fix `mvn ` x 100k took ~26 s (quadratic look-ahead).
    const t0 = Date.now();
    for (const run of [
      'mvn '.repeat(100_000),
      'gradlew '.repeat(60_000),
      '${{ github.event.issue.'.repeat(20_000),
      'x'.repeat(400_000),
    ]) {
      analyzeWorkflow(wf(run));
    }
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('still recognises Maven/Gradle test commands within the bounded window', () => {
    expect(analyzeWorkflow(wf('./mvnw -B verify test')).runsTests).toBe(true);
    expect(analyzeWorkflow(wf('./gradlew clean test')).runsTests).toBe(true);
    expect(analyzeWorkflow(wf('mvn package')).runsTests).toBe(false);
  });

  it('the identity classifier tolerates multi-megabyte declared text', async () => {
    const { HeuristicClassifier, loadDefaultTaxonomy } =
      await import('../../src/identity/index.js');
    const { parseManifest } = await import('../../src/collectors/manifests/parse.js');
    const huge = 'a task queue for background jobs '.repeat(200_000);
    const manifest = parseManifest(
      'package.json',
      JSON.stringify({ name: 'x', description: huge }),
    )!;
    const t0 = Date.now();
    new HeuristicClassifier(loadDefaultTaxonomy()).classify({
      owner: 'o',
      repo: 'r',
      displayName: 'r',
      description: huge,
      topics: [],
      readme: huge,
      treePaths: [],
      manifests: [manifest],
      hasDockerfile: false,
      hasActionYml: false,
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/o/r',
    });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
