import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { ReportSchema, type Report } from '../../src/report/schema.js';
import { renderText } from '../../src/report/text.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

interface Call {
  url: string;
  method: string;
  body?: string;
}
async function run(
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<{ r: Report; calls: Call[] }> {
  const inner = fakeFetch(spec);
  const calls: Call[] = [];
  const r = await analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: String(init.body) } : {}),
      });
      return inner(url, init);
    },
    clock: fixedClock,
    ...extra,
  });
  return { r, calls };
}
const osvBody = (calls: Call[]) =>
  JSON.parse(calls.find((c) => c.url.includes('osv.dev'))?.body ?? '{"queries":[]}') as {
    queries: { package: { name: string; ecosystem: string }; version: string }[];
  };
const dep = (r: Report, name: string) =>
  r.dependency_intel.dependencies.find((d) => d.package.name === name)!;
const ruleOf = (r: Report, id: string) =>
  r.dimensions.flatMap((d) => d.rules).find((x) => x.rule_id === id)!;

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'widget',
    description: 'Distributed task queue for jobs',
    dependencies: deps,
    ...extra,
  });
const lockOf = (v: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'widget' },
      ...Object.fromEntries(
        Object.entries(v).map(([n, x]) => [`node_modules/${n}`, { version: x }]),
      ),
    },
  });
const withFiles = (files: Record<string, string>, over: Partial<FakeSpec> = {}) => {
  const g = goodRepo(over);
  g.files = { ...g.files, ...files };
  return g;
};

describe('exact versions reach OSV; ranges never do', () => {
  it('queries exactly the lockfile versions (direct and transitive) and records provenance', async () => {
    const { r, calls } = await run(goodRepo({ osvVulns: { bullmq: ['GHSA-aaaa-bbbb-cccc'] } }));
    const q = osvBody(calls).queries;
    expect(q.find((x) => x.package.name === 'bullmq')).toMatchObject({
      version: '5.1.0',
      package: { ecosystem: 'npm' },
    });
    expect(q.find((x) => x.package.name === 'lodash')?.version).toBe('4.17.10'); // transitive
    const d = dep(r, 'bullmq');
    expect(d).toMatchObject({
      requested: { spec: '^5.0.0', kind: 'range' },
      resolved: { version: '5.1.0', source: 'lockfile' },
      vulnerability: { state: 'checked', advisory_ids: ['GHSA-aaaa-bbbb-cccc'] },
    });
    expect(r.dependency_intel.advisories[0]).toMatchObject({
      id: 'GHSA-aaaa-bbbb-cccc',
      source: 'osv',
      package: 'bullmq',
      version: '5.1.0',
      lookup_url: 'https://api.osv.dev/v1/querybatch',
      looked_up_at: fixedClock.now().toISOString(),
    });
    expect(
      r.findings.some((f) => f.category === 'dependency' && /bullmq@5\.1\.0/.test(f.title)),
    ).toBe(true);
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('without a lockfile a range stays unresolved and is NOT sent to OSV (no "pick a current version")', async () => {
    const spec = withFiles({ 'package.json': pkg({ a: '^1.0.0', b: '2.0.0' }) });
    delete spec.files['package-lock.json'];
    const { r, calls } = await run(spec);
    expect(osvBody(calls).queries.map((x) => x.package.name)).toEqual(['b']); // only the exact pin
    expect(dep(r, 'a')).toMatchObject({
      resolution: 'unresolved',
      vulnerability: { state: 'unresolved_version' },
    });
    expect(dep(r, 'a').resolved).toBeUndefined();
    expect(dep(r, 'b')).toMatchObject({
      resolved: { source: 'manifest_pin', version: '2.0.0' },
      vulnerability: { state: 'checked' },
    });
    expect(
      r.diagnostics.some(
        (d) => d.code === 'dep_versions_unresolved' && /not "clean"/.test(d.message),
      ),
    ).toBe(true);
  });

  it('workspace, path and git dependencies are not looked up by name', async () => {
    const spec = withFiles({
      'package.json': pkg({ w: 'workspace:*', p: 'file:../p', g: 'github:u/r#main' }),
    });
    delete spec.files['package-lock.json'];
    const { r, calls } = await run(spec);
    expect(calls.some((c) => c.url.includes('osv.dev'))).toBe(false);
    for (const n of ['w', 'p', 'g'])
      expect(dep(r, n)).toMatchObject({
        resolution: 'not_registry',
        vulnerability: { state: 'not_checked' },
      });
    expect(r.findings.some((f) => /mutable git branch/.test(f.title))).toBe(true);
  });
});

describe('unknown and failure are never safe', () => {
  it('100 dependencies, 10 checked, 0 vulnerabilities: the vulnerability rule is withheld, coverage is reported', async () => {
    const declared: Record<string, string> = {};
    for (let i = 0; i < 100; i++) declared[`dep${i}`] = '^1.0.0';
    const locked: Record<string, string> = {};
    for (let i = 0; i < 10; i++) locked[`dep${i}`] = '1.2.3';
    const { r } = await run(
      withFiles({ 'package.json': pkg(declared), 'package-lock.json': lockOf(locked) }),
    );
    const s = r.dependency_intel.summary;
    expect(s).toMatchObject({
      direct_registry: 100,
      direct_resolved_exact: 10,
      direct_unresolved: 90,
      direct_vulnerability_checked: 10,
      vulnerable_total: 0,
    });
    const rule = ruleOf(r, 'security.known-vulnerabilities');
    expect(rule.status).toBe('not_observed');
    expect(rule.missing_reason).toBe('insufficient_coverage');
    expect(r.evidence.find((e) => e.id === 'osv.vulnerable_ratio')).toBeUndefined();
    expect(r.evidence.find((e) => e.id === 'osv.coverage_ratio')?.value).toBe(0.1);
    expect(r.diagnostics.some((d) => d.code === 'osv_coverage_insufficient')).toBe(true);
    expect(renderText(r, { ascii: true })).toMatch(
      /DEPENDENCY INTELLIGENCE[\s\S]*vulnerability-checked:\s+10 of 100/,
    );
  });

  it('the same low coverage WITH a vulnerability still reports the vulnerability', async () => {
    const declared: Record<string, string> = {};
    for (let i = 0; i < 20; i++) declared[`dep${i}`] = '^1.0.0';
    const { r } = await run(
      withFiles(
        {
          'package.json': pkg(declared),
          'package-lock.json': lockOf({ dep0: '1.0.0', dep1: '1.0.0' }),
        },
        { osvVulns: { dep0: ['GHSA-x'] } },
      ),
    );
    expect(r.evidence.find((e) => e.id === 'osv.vulnerable_ratio')?.value).toBe(0.5);
    expect(ruleOf(r, 'security.known-vulnerabilities').status).not.toBe('not_observed');
  });

  it('good coverage and no vulnerabilities still scores the rule (nothing is withheld unnecessarily)', async () => {
    const { r } = await run(goodRepo());
    expect(r.evidence.find((e) => e.id === 'osv.vulnerable_ratio')?.value).toBe(0);
    expect(ruleOf(r, 'security.known-vulnerabilities').score).toBe(10);
  });

  it('an OSV outage gives lookup_failed states and an unobserved rule, never a clean result', async () => {
    const { r } = await run(goodRepo({ failing: ['api.osv.dev'] }));
    expect(r.dependency_intel.vulnerability_lookup).toMatchObject({
      performed: true,
      state: 'lookup_failed',
    });
    expect(dep(r, 'bullmq').vulnerability.state).toBe('lookup_failed');
    expect(ruleOf(r, 'security.known-vulnerabilities').status).toBe('not_observed');
    expect(ruleOf(r, 'security.known-vulnerabilities').missing_reason).toBe('unavailable');
    expect(r.dependency_intel.summary.vulnerable_total).toBe(0);
    expect(r.dependency_intel.summary.vulnerability_checked_total).toBe(0);
    expect(
      r.diagnostics.some(
        (d) => d.code === 'osv_failed' && /not evidence of safety/.test(d.message),
      ),
    ).toBe(true);
  });

  it('malformed or short OSV bodies are discarded with a diagnostic', async () => {
    for (const osvRaw of [
      { results: 'nope' },
      { results: [] },
      { results: [{ vulns: [{ id: 'X' }] }] },
    ]) {
      const { r } = await run(goodRepo({ osvRaw }));
      expect(dep(r, 'bullmq').vulnerability.state).toBe('lookup_failed');
      expect(r.diagnostics.some((d) => d.code === 'osv_mismatch')).toBe(true);
    }
  });

  it('--no-osv: dependencies are "not_checked (disabled)", the rule is not_collected, no OSV request is made', async () => {
    const { r, calls } = await run(goodRepo(), { osv: false });
    expect(calls.some((c) => c.url.includes('osv.dev'))).toBe(false);
    expect(dep(r, 'bullmq').vulnerability).toMatchObject({ state: 'not_checked' });
    expect(r.dependency_intel.vulnerability_lookup).toMatchObject({
      performed: false,
      state: 'not_checked',
    });
    expect(ruleOf(r, 'security.known-vulnerabilities').missing_reason).toBe('not_collected');
  });
});

describe('deps.dev is optional and never decides safety', () => {
  const ddSpec = (over: Partial<FakeSpec> = {}) => {
    const spec = withFiles({ 'package.json': pkg({ a: '^1.0.0', bullmq: '^5.0.0' }) }, over);
    spec.depsDev = {
      '/packages/bullmq/versions/5.1.0': {
        licenses: ['MIT'],
        publishedAt: '2024-01-01T00:00:00Z',
        advisoryKeys: [{ id: 'GHSA-dd-1' }],
        relatedProjects: [{ projectKey: { id: 'github.com/taskforcesh/bullmq' } }],
        slsaProvenances: [{}],
      },
      '/packages/a': {
        versions: [
          { versionKey: { version: '1.0.0' } },
          { versionKey: { version: '1.4.0' }, isDefault: false },
          { versionKey: { version: '2.0.0' }, isDefault: true },
        ],
      },
    };
    return spec;
  };

  it('metadata for exact versions; a current-registry CANDIDATE for an unresolved range, kept apart from resolution', async () => {
    const { r } = await run(ddSpec());
    expect(r.dependency_intel.deps_dev).toMatchObject({
      state: 'ok',
      enriched: 1,
      registry_candidates: 1,
    });
    expect(dep(r, 'bullmq').package_info).toMatchObject({
      licenses: ['MIT'],
      source_repositories: ['github.com/taskforcesh/bullmq'],
      slsa_provenance_listed: true,
    });
    const a = dep(r, 'a');
    expect(a.registry_candidate).toMatchObject({ version: '1.4.0', source: 'deps.dev' });
    expect(a.registry_candidate?.note).toMatch(/NOT necessarily the version this revision used/);
    expect(a.resolution).toBe('unresolved');
    expect(a.resolved).toBeUndefined();
    expect(a.vulnerability.state).toBe('unresolved_version'); // candidate is never queried
    expect(
      r.dependency_intel.advisories.some((x) => x.source === 'deps.dev' && x.id === 'GHSA-dd-1'),
    ).toBe(true);
  });

  it('a lockfile resolution is never replaced by a registry candidate', async () => {
    const { r } = await run(ddSpec());
    expect(dep(r, 'bullmq').registry_candidate).toBeUndefined();
    expect(dep(r, 'bullmq').resolved?.source).toBe('lockfile');
  });

  it.each([
    ['500', { failing: ['api.deps.dev'] }, 'unavailable'],
    ['429', { rateLimited: ['api.deps.dev'] }, 'unavailable'],
  ])(
    'deps.dev %s: diagnostic and reduced metadata, OSV results untouched',
    async (_n, over, state) => {
      const { r } = await run(ddSpec(over as Partial<FakeSpec>));
      expect(r.dependency_intel.deps_dev.state).toBe(state);
      expect(
        r.diagnostics.some(
          (d) => d.source === 'deps.dev' && /no dependency was treated as safe/.test(d.message),
        ),
      ).toBe(true);
      expect(dep(r, 'bullmq').vulnerability.state).toBe('checked');
      expect(dep(r, 'bullmq').package_info).toBeUndefined();
    },
  );

  it('--no-deps-dev makes no deps.dev request and reports disabled', async () => {
    const { r, calls } = await run(ddSpec(), { depsDev: false });
    expect(calls.some((c) => c.url.includes('deps.dev'))).toBe(false);
    expect(r.dependency_intel.deps_dev).toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('identical requests are made once per run (in-memory memoization)', async () => {
    const spec = ddSpec();
    spec.files['package.json'] = pkg({ a: '^1.0.0' }, { devDependencies: { a: '^1.0.0' } });
    const { calls } = await run(spec);
    const pkgCalls = calls.filter((c) =>
      /api\.deps\.dev\/v3\/systems\/npm\/packages\/a$/.test(c.url),
    );
    expect(pkgCalls.length).toBe(1);
  });

  it('hostile package names are URL-encoded and can only reach api.deps.dev', async () => {
    const evil = 'a/../../x?y=1#frag@evil.test';
    const spec = withFiles({ 'package.json': pkg({ [evil]: '1.0.0', '@scope/p': '^1.0.0' }) });
    delete spec.files['package-lock.json'];
    const { calls } = await run(spec);
    const dd = calls.filter((c) => c.url.includes('deps.dev'));
    expect(dd.length).toBeGreaterThan(0);
    for (const c of dd) {
      const u = new URL(c.url);
      expect(u.host).toBe('api.deps.dev');
      expect(u.search).toBe('');
      expect(u.hash).toBe('');
      expect(u.pathname).not.toMatch(/\.\.\//);
    }
    for (const c of calls)
      expect([
        'api.github.com',
        'raw.githubusercontent.com',
        'api.securityscorecards.dev',
        'api.osv.dev',
        'api.deps.dev',
      ]).toContain(new URL(c.url).host);
  });
});

describe('auxiliary manifests do not dilute coverage', () => {
  it('example projects are listed but excluded from the direct_* numbers and the OSV coverage ratio', async () => {
    const spec = withFiles({
      'package.json': pkg({ a: '^1.0.0' }),
      'package-lock.json': lockOf({ a: '1.2.0' }),
      'examples/demo/package.json': pkg({ x: '^1.0.0', y: '^1.0.0', z: '^1.0.0' }),
    });
    const { r } = await run(spec);
    expect(r.dependency_intel.summary).toMatchObject({
      direct: 1,
      direct_registry: 1,
      direct_resolved_exact: 1,
      direct_unresolved: 0,
      auxiliary: 3,
    });
    expect(r.evidence.find((e) => e.id === 'osv.coverage_ratio')?.value).toBe(1);
    expect(dep(r, 'x')).toMatchObject({ context: 'auxiliary', resolution: 'unresolved' });
  });
});

describe('SBOM in the repository', () => {
  const sbom = (components: unknown[]) =>
    JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components });
  const c = (name: string, version: string) => ({
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
  });

  it('a valid SBOM is parsed, compared, exposed as facts, and reported', async () => {
    const { r } = await run(
      withFiles({
        'sbom.json': sbom([c('bullmq', '5.1.0'), c('redis', '4.6.0'), c('lodash', '4.17.10')]),
      }),
    );
    expect(r.dependency_intel.sboms[0]).toMatchObject({
      format: 'CycloneDX',
      status: 'parsed',
      component_count: 3,
    });
    expect(r.dependency_intel.sbom_comparisons[0]).toMatchObject({
      state: 'consistent',
      matched: 2,
    });
    expect(r.facts.find((f) => f.id === 'deps.sbom.present')?.value).toBe(true);
    expect(r.facts.find((f) => f.id === 'deps.sbom.comparison')?.value).toBe('consistent');
    expect(ruleOf(r, 'supply-chain.sbom-validated').status).toBe('informational');
    expect(renderText(r, { ascii: true })).toMatch(/SBOM comparison:\s+CONSISTENT/);
  });

  it('a mismatching SBOM yields a finding with the evidence of the disagreement', async () => {
    const { r } = await run(
      withFiles({ 'sbom.json': sbom([c('bullmq', '4.0.0'), c('redis', '4.6.0')]) }),
    );
    expect(r.dependency_intel.sbom_comparisons[0]?.state).toBe('mismatch');
    const f = r.findings.find((x) => x.category === 'sbom' && /mismatch/.test(x.title))!;
    expect(f.summary).toMatch(/bullmq/);
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBeLessThan(0.95);
  });

  it('malformed, unsupported and non-SBOM files are diagnosed and never used', async () => {
    for (const [content, code] of [
      ['{broken', 'sbom_malformed'],
      [JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '9.9' }), 'sbom_unsupported'],
      ['{}', 'sbom_not_an_sbom'],
    ] as const) {
      const { r } = await run(withFiles({ 'sbom.json': content }));
      expect(
        r.diagnostics.some((d) => d.code === code),
        code,
      ).toBe(true);
      expect(r.dependency_intel.sbom_comparisons).toEqual([]);
      expect(r.facts.find((f) => f.id === 'deps.sbom.present')?.value).toBe(false);
    }
  });

  it('--no-sbom does not fetch or ingest SBOM files', async () => {
    const { r, calls } = await run(withFiles({ 'sbom.json': sbom([c('bullmq', '5.1.0')]) }), {
      sbom: false,
    });
    expect(calls.some((x) => x.url.endsWith('/sbom.json'))).toBe(false);
    expect(r.dependency_intel.sboms).toEqual([]);
    expect(r.facts.find((f) => f.id === 'deps.sbom.present')).toBeUndefined();
  });

  it('terminal control sequences inside SBOM metadata cannot reach the text report', async () => {
    const evil = {
      type: 'library',
      name: 'bad\u001b]0;pwned\u0007name',
      version: '1.0.0',
      purl: 'pkg:npm/bad@1.0.0',
    };
    const { r } = await run(withFiles({ 'sbom.json': sbom([evil, c('bullmq', '5.1.0')]) }));
    expect(renderText(r, { verbose: true }).includes(String.fromCharCode(27))).toBe(false);
  });
});

describe('report integrity and configuration', () => {
  it('is deterministic for identical inputs and the digest reflects the dependency switches', async () => {
    const a = (await run(goodRepo())).r;
    const b = (await run(goodRepo())).r;
    expect(a.integrity.report_sha256).toBe(b.integrity.report_sha256);
    const noDd = (await run(goodRepo(), { depsDev: false })).r;
    const noSbom = (await run(goodRepo(), { sbom: false })).r;
    expect(
      new Set([
        a.methodology.config_digest,
        noDd.methodology.config_digest,
        noSbom.methodology.config_digest,
      ]).size,
    ).toBe(3);
  });

  it('declares schema 0.3 and methodology 0.3 and validates', async () => {
    const { r } = await run(goodRepo());
    expect(r).toMatchObject({ schema_version: '0.3', methodology: { version: '0.3' } });
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('the report view is bounded for very large dependency sets, with the rest counted', async () => {
    const locked: Record<string, string> = {};
    for (let i = 0; i < 2500; i++) locked[`t${i}`] = '1.0.0';
    const { r } = await run(withFiles({ 'package-lock.json': lockOf(locked) }));
    expect(r.dependency_intel.summary.discovered).toBeGreaterThan(2000);
    expect(r.dependency_intel.dependencies.length).toBeLessThanOrEqual(300);
    expect(r.dependency_intel.omitted).toBe(
      r.dependency_intel.summary.discovered - r.dependency_intel.dependencies.length,
    );
  });
});

describe('observed risk and completeness are reported separately', () => {
  it('3 vulnerable of 6 checked among 175 known dependencies: high observed risk, very low confidence', async () => {
    const declared: Record<string, string> = {};
    for (let i = 0; i < 175; i++) declared[`d${i}`] = i < 6 ? '1.0.0' : '^1.0.0';
    const spec = withFiles(
      { 'package.json': pkg(declared) },
      { osvVulns: { d0: ['GHSA-a'], d1: ['GHSA-b'], d2: ['GHSA-c'] } },
    );
    delete spec.files['package-lock.json'];
    const { r } = await run(spec);
    const ev = (id: string) => r.evidence.find((e) => e.id === id);
    expect(ev('osv.checked_packages')?.value).toBe(6);
    expect(ev('osv.vulnerable_packages')?.value).toBe(3);
    expect(ev('osv.eligible_packages')?.value).toBe(175);
    expect(ev('osv.vulnerable_ratio')?.value).toBe(0.5); // observed risk, not diluted by what could not be checked
    expect(Number(ev('osv.coverage_ratio')?.value)).toBeLessThan(0.05); // completeness
    expect(ev('osv.vulnerable_ratio')?.confidence).toBeLessThan(0.25); // ...and it lowers the confidence instead
    const rule = ruleOf(r, 'security.known-vulnerabilities');
    expect(rule.score).toBe(0);
    expect(rule.confidence).toBeLessThan(0.3);
    expect(r.identity.confidence_semantics).toBe('heuristic_uncalibrated');
  });
});

describe('JVM dependencies reach the same vulnerability pipeline, conservatively', () => {
  const POM = `<project><groupId>com.acme</groupId><artifactId>app</artifactId><version>1</version><dependencies>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.9</version></dependency>
    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency>
    <dependency><groupId>x</groupId><artifactId>ranged</artifactId><version>[1.0,2.0)</version></dependency>
  </dependencies></project>`;

  it('a literal Maven version is queried as Maven group:artifact; managed and ranged ones are not', async () => {
    const spec = withFiles(
      { 'pom.xml': POM },
      { osvVulns: { 'org.slf4j:slf4j-api': ['GHSA-mvn-1'] } },
    );
    delete spec.files['package.json'];
    delete spec.files['package-lock.json'];
    const { r, calls } = await run(spec);
    const q = osvBody(calls).queries;
    expect(q).toEqual([
      { package: { name: 'org.slf4j:slf4j-api', ecosystem: 'Maven' }, version: '2.0.9' },
    ]);
    expect(dep(r, 'org.slf4j:slf4j-api')).toMatchObject({
      resolved: { source: 'manifest_pin', version: '2.0.9', confidence: 0.6 },
      vulnerability: { state: 'checked', advisory_ids: ['GHSA-mvn-1'] },
    });
    expect(dep(r, 'com.google.guava:guava')).toMatchObject({
      resolution: 'unresolved',
      vulnerability: { state: 'unresolved_version' },
    });
    expect(dep(r, 'x:ranged').requested?.kind).toBe('range');
    expect(r.diagnostics.some((d) => d.code === 'jvm_partial_resolution')).toBe(true);
  });

  it('a gradle.lockfile gives exact versions for dependencies the build script leaves unversioned', async () => {
    const spec = withFiles({
      'build.gradle': "dependencies {\n  implementation 'com.google.guava:guava'\n}\n",
      'gradle.lockfile':
        '# comment\ncom.google.guava:guava:33.0.0-jre=compileClasspath,runtimeClasspath\nempty=annotationProcessor\n',
    });
    delete spec.files['package.json'];
    delete spec.files['package-lock.json'];
    const { r } = await run(spec);
    expect(dep(r, 'com.google.guava:guava')).toMatchObject({
      resolution: 'resolved',
      resolved: { version: '33.0.0-jre', source: 'lockfile' },
    });
    expect(r.dependency_intel.lockfiles.map((l) => l.format)).toContain('gradle.lockfile');
  });
});
