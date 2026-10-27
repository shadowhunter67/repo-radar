import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { ReportSchema, type Report } from '../../src/report/schema.js';
import { canonicalStringify } from '../../src/report/canonical.js';
import { renderText } from '../../src/report/text.js';
import { benignHookRepo, FAKE_AWS_TAIL, installerRepo } from '../helpers/code-scenarios.js';
import { fakeFetch, fixedClock, type FakeSpec, type Recorded } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const run = (
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
  rec: Recorded[] = [],
): Promise<Report> =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec, rec),
    clock: fixedClock,
    ...extra,
  });
const dim = (r: Report, d: string) => r.dimensions.find((x) => x.dimension === d)!;
const rule = (r: Report, id: string) =>
  r.dimensions.flatMap((d) => d.rules).find((x) => x.rule_id === id)!;
const fact = (r: Report, id: string) => r.facts.find((f) => f.id === id);

describe('installer-like repository (capabilities observed, intent undetermined)', () => {
  it('traces postinstall -> setup.js -> persist.js with chains, persistence and secrets', async () => {
    const r = await run(installerRepo());
    expect(ReportSchema.safeParse(r).success).toBe(true);
    const hook = r.code_analysis.execution.hooks.find((h) => h.name === 'postinstall')!;
    expect(hook).toMatchObject({
      ecosystem: 'npm',
      risk: 'high',
      runs_for_dependents: true,
      analyzed: true,
    });
    expect(hook.files).toEqual(expect.arrayContaining(['scripts/setup.js', 'scripts/persist.js']));
    expect(r.code_analysis.execution.chains[0]).toMatchObject({
      kind: 'pipe-to-shell',
      file: 'scripts/setup.js',
      mode: 'DIRECT',
    });
    expect(r.code_analysis.persistence).toMatchObject({ observed: true, install_time: true });
    expect(r.code_analysis.persistence.kinds).toContain('systemd_service');
    expect(r.code_analysis.secrets.scored_count).toBe(2); // AWS key + committed env file (name only)
    expect(fact(r, 'execution.chain.install_time')?.value).toBe(true);
    expect(fact(r, 'persistence.install_time')?.value).toBe(true);
    expect(fact(r, 'capability.process_exec.install_time')?.value).toBe(true);
  });

  it('turns observations into scored rules, findings and warnings with traceable ids', async () => {
    const r = await run(installerRepo());
    const base = await run(goodRepo());
    expect(rule(r, 'security.install-time-download-execute').score).toBe(0);
    expect(rule(r, 'security.hardcoded-secrets').score).toBe(2);
    expect(rule(r, 'supply-chain.install-hooks').score).toBe(1);
    expect(dim(r, 'security').score!).toBeLessThan(dim(base, 'security').score! - 10);
    expect(dim(r, 'supply-chain').score!).toBeLessThan(dim(base, 'supply-chain').score!);
    const titles = r.findings.map((f) => f.title).join('\n');
    expect(titles).toMatch(/Download-and-execute chain/);
    expect(titles).toMatch(/hard-coded secret: aws-access-key-id/);
    expect(titles).toMatch(/Persistence capability/);
    for (const f of r.findings) {
      expect(f.intent).toBe('undetermined');
      expect(f.evidence_ids.length).toBeGreaterThan(0);
    }
    const idsInReport = new Set([
      ...r.code_analysis.execution.chains.map((c) => c.id),
      ...r.code_analysis.execution.hooks.map((h) => h.id),
      ...r.code_analysis.secrets.candidates.map((c) => c.id),
      ...r.code_analysis.capabilities.detections.map((d) => d.id),
      ...r.dependency_intel.dependencies.map((d) => d.id),
      ...r.registry_intel.packages.map((p) => `registry:${p.registry}:${p.name}`),
      ...r.dependency_registry_intel.packages.map((p) => `depregistry:${p.registry}:${p.name}`),
      ...r.dependency_registry_intel.events.map((e) => e.id),
      ...r.external_domains.domains.map((d) => `domain:${d.hostname}`),
      ...r.release_intel.releases.map((x) => `release:${x.tag}`),
      ...r.governance.signals.map((x) => x.id),
      ...r.dependency_intel.lockfiles.map((l) => l.path),
      ...r.dependency_intel.sboms.map((d) => d.path),
    ]);
    for (const f of r.findings)
      for (const id of f.evidence_ids) expect(idsInReport.has(id), `${f.id} -> ${id}`).toBe(true);
    const warnings = r.warnings.map((w) => w.message).join('\n');
    expect(warnings).toMatch(/download-and-execute chain is reachable/);
    expect(warnings).toMatch(/2 possible hard-coded secret/);
  });

  it('never leaks the secret value and never fetches the committed environment file', async () => {
    const rec: Recorded[] = [];
    const r = await run(installerRepo(), {}, rec);
    const json = JSON.stringify(r);
    expect(json).not.toContain(FAKE_AWS_TAIL);
    expect(json).not.toContain('SHOULD_NOT_BE_READ');
    expect(rec.some((x) => /\/\.env$/.test(x.url))).toBe(false);
    expect(renderText(r, { verbose: true })).not.toContain('ZZZZZZZZ');
  });

  it('every rule input, fact origin and finding link resolves inside the report', async () => {
    const r = await run(installerRepo());
    const resolvable = new Set([...r.evidence.map((e) => e.id), ...r.facts.map((f) => f.id)]);
    for (const d of r.dimensions)
      for (const ru of d.rules)
        for (const id of ru.evidence_ids)
          expect(resolvable.has(id), `${ru.rule_id} -> ${id}`).toBe(true);
    const known = new Set([
      ...resolvable,
      ...r.code_analysis.execution.chains.map((c) => c.id),
      ...r.code_analysis.execution.hooks.map((h) => h.id),
      ...r.code_analysis.secrets.candidates.map((c) => c.id),
      ...r.code_analysis.capabilities.detections.map((d) => d.id),
      ...r.dependency_intel.dependencies.map((d) => d.id),
      ...r.registry_intel.packages.map((p) => `registry:${p.registry}:${p.name}`),
      ...r.dependency_registry_intel.packages.map((p) => `depregistry:${p.registry}:${p.name}`),
      ...r.dependency_registry_intel.events.map((e) => e.id),
      ...r.external_domains.domains.map((d) => `domain:${d.hostname}`),
      ...r.release_intel.releases.map((x) => `release:${x.tag}`),
      ...r.governance.signals.map((x) => x.id),
      ...r.dependency_intel.lockfiles.map((l) => l.path),
      ...r.dependency_intel.sboms.map((d) => d.path),
    ]);
    for (const f of r.facts)
      for (const id of f.derived_from) expect(known.has(id), `${f.id} <- ${id}`).toBe(true);
    const ruleIds = new Set(r.dimensions.flatMap((d) => d.rules.map((x) => x.rule_id)));
    for (const f of r.findings)
      for (const id of f.rule_ids) expect(ruleIds.has(id), `${f.id} -> ${id}`).toBe(true);
  });

  it('text report shows capabilities, hooks, persistence, redacted secrets and findings', async () => {
    const text = renderText(await run(installerRepo()), { ascii: true });
    expect(text).toMatch(/CAPABILITIES \(static scan/);
    expect(text).toMatch(/INSTALL-TIME EXECUTION/);
    expect(text).toMatch(/npm:postinstall\s+risk HIGH/);
    expect(text).toMatch(/PERSISTENCE\n\s+OBSERVED: .*systemd_service/);
    expect(text).toMatch(/SECRETS \(values are never shown\)/);
    expect(text).toMatch(/AKIA\*{8}/);
    expect(text).toMatch(/Intent: undetermined/);
    expect(text).toMatch(/Engineering Hygiene/);
  });
});

describe('benign repositories are not alarmed', () => {
  it('husky `prepare` and a normal library: low-risk hook, no chains, no persistence, no secrets', async () => {
    const r = await run(benignHookRepo());
    const hook = r.code_analysis.execution.hooks.find((h) => h.name === 'prepare')!;
    expect(hook).toMatchObject({ risk: 'low', runs_for_dependents: false });
    expect(r.code_analysis.execution.chains).toEqual([]);
    expect(r.code_analysis.persistence.observed).toBe(false);
    expect(r.code_analysis.secrets.scored_count).toBe(0);
    expect(r.findings.filter((f) => f.severity === 'high')).toEqual([]);
    expect(rule(r, 'supply-chain.install-hooks').score).toBe(10);
    expect(rule(r, 'security.hardcoded-secrets').score).toBe(10);
    expect(r.warnings.map((w) => w.rule_id)).not.toContain('security.hardcoded-secrets');
  });

  it('"not observed" facts carry reduced confidence that follows scan coverage', async () => {
    const r = await run(goodRepo());
    const f = fact(r, 'capability.persistence.observed')!;
    expect(f.value).toBe(false);
    expect(f.confidence).toBeGreaterThanOrEqual(0.3);
    expect(f.confidence).toBeLessThanOrEqual(0.8);
  });
});

describe('scan switch, coverage and diagnostics', () => {
  it('no scan: no scan facts, rules "not collected" (not zero), a diagnostic explains', async () => {
    const r = await run(installerRepo(), { codeScan: false });
    expect(r.code_analysis.scan.performed).toBe(false);
    expect(r.facts.some((f) => f.id.startsWith('capability.') || f.id.startsWith('secret.'))).toBe(
      false,
    );
    const secrets = rule(r, 'security.hardcoded-secrets');
    expect(secrets.status).toBe('not_observed');
    expect(secrets.missing_reason).toBe('not_collected');
    expect(r.diagnostics.some((d) => d.code === 'code_scan_skipped')).toBe(true);
    expect(r.findings).toEqual([]);
    expect(renderText(r)).toMatch(/Not performed \(--no-scan\)/);
  });

  it('does not fetch the whole repository: bounded file count and size, raw files only', async () => {
    const rec: Recorded[] = [];
    const spec = goodRepo();
    for (let i = 0; i < 300; i++) spec.files[`lib/m${i}.js`] = 'module.exports = 1;';
    spec.files['lib/huge.js'] = 'x'.repeat(200_000);
    const r = await run(spec, {}, rec);
    const raw = rec.filter((x) =>
      x.url.startsWith('https://raw.githubusercontent.com/acme/widget/'),
    );
    expect(raw.length).toBeLessThan(90);
    expect(r.code_analysis.scan.files_scanned).toBeLessThan(80);
    expect(r.code_analysis.scan.skipped_over_budget).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.code === 'scan_limit')).toBe(true);
    expect(r.code_analysis.scan.source_coverage).toBeLessThan(0.5);
    expect(r.diagnostics.some((d) => d.code === 'scan_partial_coverage')).toBe(true);
  });

  it('files named by install scripts are fetched first even in a big repository', async () => {
    const spec = installerRepo();
    for (let i = 0; i < 300; i++) spec.files[`lib/m${i}.js`] = 'module.exports = 1;';
    const r = await run(spec);
    expect(r.code_analysis.execution.chains).toHaveLength(1);
  });

  it('a fetch failure of a scanned file is reported, not fatal, and lowers hook confidence', async () => {
    const r = await run(installerRepo({ failing: ['scripts/persist.js'] }));
    expect(r.diagnostics.some((d) => d.code === 'scan_fetch_failed')).toBe(true);
    const hook = r.code_analysis.execution.hooks.find((h) => h.name === 'postinstall')!;
    expect(hook.analyzed).toBe(false);
  });

  it('only the five allowlisted hosts are contacted while scanning', async () => {
    const rec: Recorded[] = [];
    await run(installerRepo(), {}, rec);
    const hosts = new Set(rec.map((x) => new URL(x.url).host));
    expect([...hosts].sort()).toEqual([
      'api.deps.dev',
      'api.github.com',
      'api.osv.dev',
      'api.securityscorecards.dev',
      'raw.githubusercontent.com',
      'registry.npmjs.org',
    ]);
  });
});

describe('artifact classification and identity layers', () => {
  it('library without bin is a library; bins make it ambiguous and expose the alternative', async () => {
    const lib = await run(goodRepo());
    expect(lib.identity.artifact_type).toBe('library');
    expect(lib.identity.domain).toBe('automation');
    expect(lib.identity.purpose_summary).toMatch(/for background job execution/);
    const spec = goodRepo();
    spec.files['package.json'] = JSON.stringify({
      name: 'widget',
      description: 'Distributed task queue for background jobs',
      bin: { w: 'cli.js' },
      dependencies: { bullmq: '5' },
    });
    const both = await run(spec);
    expect(both.identity.interfaces).toEqual(expect.arrayContaining(['cli', 'library']));
    expect(both.identity.artifact_alternatives).toContain('cli');
  });

  it('observed capabilities are copied onto the identity (layer 3)', async () => {
    const r = await run(installerRepo());
    expect(r.identity.capabilities).toEqual(
      expect.arrayContaining(['PROCESS_EXEC', 'PERSISTENCE', 'REMOTE_DOWNLOAD']),
    );
    expect((await run(installerRepo(), { codeScan: false })).identity.capabilities).toEqual([]);
  });

  it('unclassified repositories keep the uncertainty explicit', async () => {
    const r = await run(
      goodRepo({ description: 'misc stuff', topics: [], readme: 'hello', files: { 'a.txt': 'x' } }),
    );
    expect(r.identity.canonical_type).toBe('unclassified');
    expect(r.identity.artifact_type).toBe('unknown');
    expect(r.identity.domain).toBe('unknown');
    expect(r.identity.purpose_summary).toMatch(/not determined/);
  });
});

describe('report versioning and integrity', () => {
  it('records every component version and a verifiable tamper-evidence digest', async () => {
    const r = await run(goodRepo());
    expect(r.schema_version).toBe('0.16');
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe('0.17.0');
    expect(readFileSync('scripts/calibrate-incidents.mjs', 'utf8')).toContain(
      "incidentModelVersion = '0.12.0'",
    );
    expect(r.methodology).toMatchObject({
      version: '0.4',
      taxonomy_version: '0.2',
      detector_pack_version: '0.1',
      facts_version: '0.1',
    });
    expect(r.methodology.config_digest).toMatch(/^[0-9a-f]{64}$/);
    const { integrity, ...rest } = r;
    expect(integrity.format).toBe('canonical-json@1');
    expect(integrity.report_sha256).toBe(
      createHash('sha256').update(canonicalStringify(rest)).digest('hex'),
    );
    const tampered = { ...rest, overall: { ...rest.overall, score: 100 } };
    expect(createHash('sha256').update(canonicalStringify(tampered)).digest('hex')).not.toBe(
      integrity.report_sha256,
    );
  });

  it('config digest changes with the analysis configuration but not with the repository', async () => {
    const a = await run(goodRepo());
    const b = await run(goodRepo(), { codeScan: false });
    const c = await run(goodRepo(), { profile: 'enterprise' });
    expect(
      new Set([
        a.methodology.config_digest,
        b.methodology.config_digest,
        c.methodology.config_digest,
      ]).size,
    ).toBe(3);
    expect((await run(installerRepo())).methodology.config_digest).toBe(
      a.methodology.config_digest,
    );
  });

  it('is deterministic for identical inputs, including the digest', async () => {
    const x = await run(installerRepo());
    const y = await run(installerRepo());
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
  });

  it('the dimension keeps its stable id while the label says what it measures', async () => {
    expect(dim(await run(goodRepo()), 'code-quality').label).toBe('Engineering Hygiene');
  });
});
