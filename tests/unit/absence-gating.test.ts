import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { deriveFacts, ABSENCE_MIN_COVERAGE } from '../../src/facts/index.js';
import { analyzeCode, emptyCodeAnalysis } from '../../src/analysis/index.js';
import { EvidenceStore } from '../../src/evidence/store.js';
import type { Report } from '../../src/report/schema.js';
import { renderText } from '../../src/report/text.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { emptyRepo, goodRepo } from '../helpers/scenarios.js';

const run = (
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    ...extra,
  });
const rule = (r: Report, id: string) =>
  r.dimensions.flatMap((d) => d.rules).find((x) => x.rule_id === id)!;
const sec = (r: Report) => r.dimensions.find((d) => d.dimension === 'security')!;

describe('"nothing found" is only evidence when enough code was read', () => {
  it('a repository with no scannable code produces no absence facts and unobserved rules (not full marks)', async () => {
    const spec = goodRepo({
      files: { 'README.md': '# x', LICENSE: 'MIT' },
      readme: '# x\n\nA small thing for task queue jobs.',
    });
    const r = await run(spec);
    expect(r.code_analysis.scan.source_files_scanned).toBe(0);
    expect(r.facts.find((f) => f.id === 'scan.absence_reliable')?.value).toBe(false);
    expect(r.facts.some((f) => f.id === 'secret.candidates.count')).toBe(false);
    expect(r.facts.some((f) => f.id === 'capability.process_exec.observed')).toBe(false);
    const s = rule(r, 'security.hardcoded-secrets');
    expect(s.status).toBe('not_observed');
    expect(s.missing_reason).toBe('insufficient_coverage');
    expect(rule(r, 'security.install-time-download-execute').missing_reason).toBe(
      'insufficient_coverage',
    );
    expect(r.diagnostics.some((d) => d.code === 'scan_absence_withheld')).toBe(true);
    expect(renderText(r)).toMatch(/Too little code was scanned/);
  });

  it('absence does not inflate the Security score: the empty repository stays low, with a wide range', async () => {
    const withScan = await run(emptyRepo(), { scorecard: false, osv: false });
    const noScan = await run(emptyRepo(), { scorecard: false, osv: false, codeScan: false });
    // Scanning an almost empty repository must not add "clean" points.
    expect(sec(withScan).score).toBeLessThanOrEqual(sec(noScan).score! + 0.1);
    expect(sec(withScan).score_range![1] - sec(withScan).score_range![0]).toBeGreaterThan(10);
  });

  it('a repository with solid coverage does get its clean results counted', async () => {
    const r = await run(goodRepo());
    expect(r.facts.find((f) => f.id === 'scan.absence_reliable')?.value).toBe(true);
    expect(rule(r, 'security.hardcoded-secrets').score).toBe(10);
    expect(r.facts.find((f) => f.id === 'secret.candidates.count')?.value).toBe(0);
  });

  it('positive observations are always emitted, whatever the coverage', async () => {
    const spec = goodRepo({ files: { 'README.md': '# x', '.env': 'A=1' } });
    const r = await run(spec);
    expect(r.facts.find((f) => f.id === 'secret.candidates.count')?.value).toBe(1);
    expect(rule(r, 'security.hardcoded-secrets').status).toBe('scored');
  });

  it('threshold and gating are exercised directly on the fact layer', () => {
    const base = emptyCodeAnalysis();
    const low = analyzeCode({
      manifests: [],
      files: [],
      treePaths: [],
      sourceFilesTotal: 100,
      fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
    });
    expect(low.scan.source_coverage).toBe(0);
    const facts = deriveFacts({
      store: new EvidenceStore(),
      code: low,
      artifact: { type: 'library', confidence: 0.5 },
    });
    expect(facts.map((f) => f.id)).not.toContain('persistence.observed');
    expect(facts.map((f) => f.id)).toContain('execution.install_hooks.max_risk');
    expect(ABSENCE_MIN_COVERAGE).toBeGreaterThan(0);
    expect(
      deriveFacts({
        store: new EvidenceStore(),
        code: base,
        artifact: { type: 'library', confidence: 0.5 },
      }).some((f) => f.id.startsWith('capability.')),
    ).toBe(false);
  });
});
