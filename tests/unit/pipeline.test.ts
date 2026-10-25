import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { RepoNotFoundError } from '../../src/collectors/github/collector.js';
import { ReportSchema, type Report } from '../../src/report/schema.js';
import { RateLimitError } from '../../src/util/http.js';
import {
  fakeFetch,
  fixedClock,
  baseSpec,
  type FakeSpec,
  type Recorded,
} from '../helpers/fake-github.js';
import {
  archivedRepo,
  brandNameRepo,
  emptyRepo,
  goodRepo,
  noReleasesRepo,
  readmeHeavyRepo,
  unicodeNameRepo,
} from '../helpers/scenarios.js';

async function run(
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
  recorded: Recorded[] = [],
): Promise<Report> {
  return analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec, recorded),
    clock: fixedClock,
    ...extra,
  });
}
const dim = (r: Report, d: string) => r.dimensions.find((x) => x.dimension === d)!;
const ev = (r: Report, id: string) => r.evidence.find((e) => e.id === id);

describe('pipeline: healthy repository', () => {
  it('produces a schema-valid, well-scored report with identity', async () => {
    const r = await run(goodRepo());
    expect(ReportSchema.safeParse(r).success).toBe(true);
    expect(r.identity.canonical_type).toBe('task-queue');
    expect(r.identity.confidence).toBeGreaterThan(0.6);
    expect(r.identity.interfaces).toContain('library');
    for (const d of [
      'security',
      'maintenance',
      'code-quality',
      'documentation',
      'semantic-clarity',
    ]) {
      expect(dim(r, d).score, d).toBeGreaterThanOrEqual(75);
      expect(dim(r, d).sufficiency, d).toBe('sufficient');
    }
    expect(r.overall.grade).not.toBe('N/A');
    expect(r.overall.confidence).toBeGreaterThan(0.7);
  });

  it('every scored rule traces back to evidence that exists in the report', async () => {
    const r = await run(goodRepo());
    // Rule inputs resolve against raw evidence or normalized facts.
    const ids = new Set([...r.evidence.map((e) => e.id), ...r.facts.map((f) => f.id)]);
    let traced = 0;
    for (const d of r.dimensions) {
      for (const rule of d.rules) {
        if (rule.status !== 'scored') continue;
        expect(rule.evidence_ids.length).toBeGreaterThan(0);
        for (const id of rule.evidence_ids)
          expect(ids.has(id), `${rule.rule_id} -> ${id}`).toBe(true);
        traced++;
      }
    }
    expect(traced).toBeGreaterThan(30);
  });

  it('dimension scores equal the weighted mean of their rule contributions', async () => {
    const r = await run(goodRepo());
    for (const d of r.dimensions) {
      const sum = d.rules.reduce((a, x) => a + (x.contribution ?? 0), 0);
      expect(Math.abs(sum - (d.score ?? 0)), d.dimension).toBeLessThan(0.1);
    }
  });

  it('is deterministic for identical inputs', async () => {
    const a = await run(goodRepo());
    const b = await run(goodRepo());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('flags a vulnerable pinned dependency from OSV and lowers security', async () => {
    const clean = await run(goodRepo());
    const vuln = await run(goodRepo({ osvVulns: { lodash: ['GHSA-xxxx-yyyy-zzzz'] } }));
    expect(ev(vuln, 'osv.vulnerable_packages')?.value).toBe(1);
    expect(ev(vuln, 'osv.vulnerability_ids')?.value).toEqual(['GHSA-xxxx-yyyy-zzzz']);
    expect(dim(vuln, 'security').score!).toBeLessThan(dim(clean, 'security').score!);
    expect(vuln.warnings.some((w) => /known OSV advisories/.test(w.message))).toBe(true);
    expect(vuln.warnings.find((w) => /known OSV/.test(w.message))!.message).toMatch(
      /^Observed: 1 of 3 checked/,
    );
  });
});

describe('pipeline: weak and edge-case repositories', () => {
  it('near-empty repository: low scores, low confidence, no crash', async () => {
    const r = await run(emptyRepo());
    expect(ReportSchema.safeParse(r).success).toBe(true);
    expect(r.identity.canonical_type).toBe('unclassified');
    expect(dim(r, 'documentation').score!).toBeLessThan(40);
    expect(dim(r, 'semantic-clarity').score!).toBeLessThan(45);
    expect(r.overall.confidence).toBeLessThan(0.7);
    expect(r.warnings.some((w) => /No README/.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => /license/i.test(w.message))).toBe(true);
    expect(r.warnings.some((w) => /Very thin commit history/.test(w.message))).toBe(true);
  });

  it('sparse evidence is reported as insufficient instead of graded', async () => {
    const r = await run(emptyRepo(), { scorecard: false, osv: false, codeScan: false });
    const sec = dim(r, 'security');
    expect(sec.sufficiency).toBe('insufficient');
    expect(sec.grade).toBe('N/A');
    expect(r.warnings.some((w) => /Insufficient evidence to grade Security/.test(w.message))).toBe(
      true,
    );
  });

  it('archived repository: warns and scores maintenance down', async () => {
    const a = await run(archivedRepo());
    const g = await run(goodRepo());
    expect(a.warnings.some((w) => /archived/.test(w.message))).toBe(true);
    expect(dim(a, 'maintenance').score!).toBeLessThan(dim(g, 'maintenance').score! - 30);
    expect(ev(a, 'github.repo.archived')?.value).toBe(true);
  });

  it('repository without releases is not penalised by missing release rules', async () => {
    const r = await run(noReleasesRepo());
    const rules = dim(r, 'maintenance').rules;
    expect(rules.find((x) => x.rule_id === 'maintenance.release-recency')!.status).toBe(
      'not_observed',
    );
    expect(rules.find((x) => x.rule_id === 'maintenance.has-releases')!.score).toBe(3);
    expect(ev(r, 'github.releases.has_any')?.value).toBe(false);
    expect(ev(r, 'github.releases.signed_assets')).toBeUndefined();
    expect(dim(r, 'maintenance').sufficiency).toBe('sufficient');
  });

  it('tags without releases still count as having releases', async () => {
    const r = await run(goodRepo({ releases: [], hasTags: true }));
    expect(ev(r, 'github.releases.has_any')?.value).toBe(true);
  });

  it('Unicode / symbol names are normalised without touching the display name and never penalised', async () => {
    const u = await run(unicodeNameRepo());
    const g = await run(goodRepo());
    expect(u.identity.repository_name).toBe('xq⚡-Ünïcode');
    expect(u.identity.normalized_name).toBe('xq-ünïcode');
    expect(u.identity.search_name).toBe('xq unicode');
    expect(ev(u, 'identity.name_normalization_lossy')?.value).toBe(true);
    expect(dim(u, 'semantic-clarity').score).toBe(dim(g, 'semantic-clarity').score);
  });

  it('brand name unrelated to function: divergence is informational and does not change the score', async () => {
    const b = await run(brandNameRepo());
    const g = await run(goodRepo());
    expect(b.identity.canonical_type).toBe('task-queue');
    expect(b.identity.name_purpose_divergence).toBe(1);
    const rule = dim(b, 'semantic-clarity').rules.find(
      (x) => x.rule_id === 'semantic-clarity.name-purpose-divergence',
    )!;
    expect(rule.status).toBe('informational');
    expect(rule.effective_weight).toBe(0);
    expect(dim(b, 'semantic-clarity').score).toBe(dim(g, 'semantic-clarity').score);
  });

  it('polished README with a tiny implementation raises a heuristic indicator, not a verdict', async () => {
    const r = await run(readmeHeavyRepo());
    expect(ev(r, 'heuristic.substance.readme_heavy')?.value).toBe(true);
    expect(ev(r, 'heuristic.substance.readme_heavy')?.kind).toBe('heuristic');
    expect(ev(r, 'heuristic.substance.ci_without_tests')?.value).toBe(true);
    expect(dim(r, 'documentation').score!).toBeGreaterThan(dim(r, 'code-quality').score!);
    expect(dim(r, 'code-quality').score!).toBeLessThan(60);
    const text = JSON.stringify(r.warnings);
    expect(text).toMatch(/heuristic/);
    expect(text).not.toMatch(/AI[- ]generated/i);
  });

  it('truncated trees lower the confidence of file-absence evidence', async () => {
    const r = await run(goodRepo({ treeTruncated: true }));
    expect(ev(r, 'github.file.security_policy')?.confidence).toBe(1);
    const missing = goodRepo({ treeTruncated: true });
    delete missing.files['SECURITY.md'];
    const r2 = await run(missing);
    expect(ev(r2, 'github.file.security_policy')?.value).toBe(false);
    expect(ev(r2, 'github.file.security_policy')?.confidence).toBe(0.5);
    // the targeted walk replaces the generic truncation notice with a precise one
    expect(r2.diagnostics.some((d) => d.code === 'tree_incomplete')).toBe(true);
    expect(r2.retrieval).toMatchObject({
      method: 'targeted',
      complete: false,
      github_truncated: true,
    });
    const plain = await run(missing, { targetedTree: false });
    expect(plain.diagnostics.some((d) => d.code === 'tree_truncated')).toBe(true);
    expect(plain.retrieval).toMatchObject({ method: 'recursive', complete: false });
  });
});

describe('pipeline: failures and degradation', () => {
  it('rate limit on optional endpoints degrades gracefully with diagnostics', async () => {
    const r = await run(goodRepo({ rateLimited: ['/contributors', '/issues', '/pulls'] }));
    expect(ReportSchema.safeParse(r).success).toBe(true);
    expect(r.diagnostics.filter((d) => d.code === 'rate_limited').length).toBe(3);
    expect(ev(r, 'github.contributors.count')).toBeUndefined();
    const bus = dim(r, 'maintenance').rules.find((x) => x.rule_id === 'maintenance.bus-factor')!;
    expect(bus.status).toBe('not_observed');
    expect(dim(r, 'maintenance').coverage).toBeLessThan(1);
  });

  it('a transient 5xx on an optional endpoint is reported, not fatal', async () => {
    const r = await run(goodRepo({ failing: ['/releases'] }), {});
    expect(r.diagnostics.some((d) => d.source === 'github' && d.code === 'fetch_failed')).toBe(
      true,
    );
    expect(ev(r, 'github.releases.has_any')).toBeUndefined();
  });

  it('rate limit on the primary repository call is a hard RateLimitError', async () => {
    const spec = goodRepo({ rateLimited: ['/repos/acme/widget'] });
    await expect(run(spec)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('unknown repository raises RepoNotFoundError', async () => {
    await expect(
      analyzeRepository('acme/nope', { fetch: fakeFetch(goodRepo()), clock: fixedClock }),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('works without a token and says so; token is only sent to api.github.com', async () => {
    const anon: Recorded[] = [];
    const r1 = await run(goodRepo(), {}, anon);
    expect(r1.stats.authenticated).toBe(false);
    expect(r1.diagnostics.some((d) => d.code === 'no_token')).toBe(true);
    expect(anon.every((x) => !x.headers['authorization'])).toBe(true);

    const authed: Recorded[] = [];
    const r2 = await run(goodRepo(), { token: 'ghp_' + 'a'.repeat(36) }, authed);
    expect(r2.stats.authenticated).toBe(true);
    for (const req of authed) {
      const host = new URL(req.url).host;
      if (host === 'api.github.com') expect(req.headers['authorization']).toMatch(/^Bearer ghp_/);
      else expect(req.headers['authorization'], host).toBeUndefined();
    }
    expect(JSON.stringify(r2)).not.toContain('ghp_aaaa');
  });

  it('makes only the allowlisted network calls (no repo-controlled URLs)', async () => {
    const rec: Recorded[] = [];
    const spec = goodRepo();
    spec.files['package.json'] = JSON.stringify({
      name: 'x',
      homepage: 'https://evil.example/steal',
      repository: 'http://169.254.169.254/',
    });
    await run(spec, {}, rec);
    const hosts = new Set(rec.map((x) => new URL(x.url).host));
    expect([...hosts].sort()).toEqual([
      'api.github.com',
      'api.osv.dev',
      'api.securityscorecards.dev',
      'raw.githubusercontent.com',
      'registry.npmjs.org',
    ]);
  });

  it('skips Scorecard and OSV when disabled', async () => {
    const rec: Recorded[] = [];
    await run(goodRepo(), { scorecard: false, osv: false }, rec);
    expect(rec.some((x) => /securityscorecards|osv\.dev/.test(x.url))).toBe(false);
  });

  it('missing Scorecard data leaves scorecard rules unobserved (not zero)', async () => {
    const r = await run(goodRepo({ scorecard: null }));
    expect(ev(r, 'scorecard.score')).toBeUndefined();
    const rule = dim(r, 'security').rules.find((x) => x.rule_id === 'security.code-review')!;
    expect(rule.status).toBe('not_observed');
  });

  it('Scorecard -1 (inconclusive) checks are not observed', async () => {
    const spec = goodRepo();
    spec.scorecard!.checks = [
      { name: 'Code-Review', score: -1 },
      { name: 'Maintained', score: 10 },
    ];
    const r = await run(spec);
    expect(ev(r, 'scorecard.check.code_review')).toBeUndefined();
    expect(ev(r, 'scorecard.check.maintained')?.value).toBe(10);
  });

  it('stale Scorecard data lowers evidence confidence', async () => {
    const spec = goodRepo();
    spec.scorecard!.date = '2024-01-01T00:00:00Z';
    const r = await run(spec);
    expect(ev(r, 'scorecard.check.maintained')?.confidence).toBe(0.4);
  });
});

describe('profiles and policy', () => {
  it('enterprise weights supply chain and security more than default', async () => {
    const def = await run(goodRepo({ releases: [{ daysAgo: 10, assets: ['a.tgz'] }] }));
    const ent = await run(goodRepo({ releases: [{ daysAgo: 10, assets: ['a.tgz'] }] }), {
      profile: 'enterprise',
    });
    expect(ent.profile.id).toBe('enterprise');
    expect(ent.overall.dimension_weights['supply-chain']).toBe(2);
    expect(ent.overall.score).not.toBe(def.overall.score);
    // same evidence, only weighting differs
    expect(ent.evidence.length).toBe(def.evidence.length);
  });

  it('advisory minimums are reported but not enforced by default', async () => {
    const r = await run(emptyRepo(), { profile: 'enterprise' });
    expect(r.policy.source).toBe('profile');
    expect(r.policy.enforced).toBe(false);
    expect(r.policy.violations.length).toBeGreaterThan(0);
  });

  it('--min style minimums override the profile and are enforced', async () => {
    const r = await run(goodRepo(), { minimums: { security: 99 } });
    expect(r.policy.source).toBe('cli');
    expect(r.policy.enforced).toBe(true);
    expect(r.policy.violations).toEqual([
      { key: 'security', minimum: 99, actual: dim(r, 'security').score, reason: 'below_minimum' },
    ]);
  });

  it('an unverifiable floor counts as a violation', async () => {
    const r = await run(emptyRepo(), {
      minimums: { security: 10 },
      scorecard: false,
      osv: false,
      codeScan: false,
    });
    expect(r.policy.violations[0]?.reason).toBe('insufficient_evidence');
  });

  it('unknown profile is rejected', async () => {
    await expect(run(goodRepo(), { profile: '../../etc/passwd' })).rejects.toThrow(
      /unknown profile/,
    );
  });
});

describe('sanity of the minimal spec used by helpers', () => {
  it('does not request dependency history unless explicitly enabled', async () => {
    const recorded: Recorded[] = [];
    await run(goodRepo(), {}, recorded);
    expect(
      recorded.filter((x) => x.url.includes('/commits?') && x.url.includes('path=')).length,
    ).toBe(0);
    expect(recorded.length).toBeLessThanOrEqual(40);
  });

  it('baseSpec has no files and still analyses', async () => {
    const r = await run(baseSpec({ files: { 'a.txt': 'x' }, commitDaysAgo: [1], commitsTotal: 1 }));
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });
});
