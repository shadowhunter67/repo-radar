/**
 * Quick and Deep are two retrieval profiles over ONE analyzer. Deep reads more; it never interprets differently.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { main } from '../../src/cli.js';
import { LIMITS } from '../../src/limits.js';
import { getAnalysisProfile, isAnalysisMode } from '../../src/modes.js';
import { renderText } from '../../src/report/text.js';
import { explainPartial } from '../../src/web/classify.js';
import { webAnalysisOptions } from '../../src/web/analysis.js';
import { loadWebConfig } from '../../src/web/config.js';
import { createWebServer } from '../../src/web/server.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const run = (spec: FakeSpec, mode: 'quick' | 'deep') =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    mode,
  });
/** More source files than Quick's scan budget, none of them large. */
const manyFiles = (n: number): FakeSpec => {
  const base = goodRepo();
  const files = { ...base.files };
  for (let i = 0; i < n; i++) files[`src/gen/dir${i % 10}/mod${i}.js`] = `exports.v${i} = ${i};\n`;
  return { ...base, files };
};

describe('profiles', () => {
  it('Quick keeps the long-standing engine budgets, Deep is strictly larger on every retrieval budget', () => {
    const q = getAnalysisProfile('quick');
    const d = getAnalysisProfile('deep');
    expect(q.scan).toEqual({
      maxFiles: LIMITS.maxScanFiles,
      maxFileBytes: LIMITS.maxScanFileBytes,
      maxTotalBytes: LIMITS.maxScanTotalBytes,
      maxRefRounds: LIMITS.maxRefRounds,
    });
    expect(q.dependencyRegistry).toEqual({}); // engine defaults
    expect(d.scan.maxFiles).toBeGreaterThan(q.scan.maxFiles);
    expect(d.scan.maxFileBytes).toBeGreaterThan(q.scan.maxFileBytes);
    expect(d.scan.maxTotalBytes).toBeGreaterThan(q.scan.maxTotalBytes);
    expect(d.scan.maxRefRounds).toBeGreaterThanOrEqual(q.scan.maxRefRounds);
    expect(d.dependencyRegistry.maxDependencies!).toBeGreaterThan(25);
    // still bounded: Deep is generous, not unlimited
    expect(d.scan.maxTotalBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(Number.isFinite(d.scan.maxFiles)).toBe(true);
  });
  it('profiles are copies, the default is Quick, and only the two modes exist', () => {
    const p = getAnalysisProfile();
    expect(p.mode).toBe('quick');
    p.scan.maxFiles = 1;
    expect(getAnalysisProfile('quick').scan.maxFiles).toBe(LIMITS.maxScanFiles);
    expect(isAnalysisMode('quick') && isAnalysisMode('deep')).toBe(true);
    expect(isAnalysisMode('turbo')).toBe(false);
    expect(isAnalysisMode(undefined)).toBe(false);
  });
});

describe('the same analysis, different budgets', () => {
  it('when both modes can read everything, findings, score, confidence, facts and dimensions are identical', async () => {
    const spec = goodRepo();
    const quick = await run(spec, 'quick');
    const deep = await run(spec, 'deep');
    expect(deep.overall).toEqual(quick.overall);
    expect(deep.findings).toEqual(quick.findings);
    expect(deep.facts).toEqual(quick.facts);
    expect(deep.dimensions).toEqual(quick.dimensions);
    expect(deep.code_analysis).toEqual(quick.code_analysis);
    expect(deep.evidence).toEqual(quick.evidence);
    expect(deep.schema_version).toBe(quick.schema_version);
    expect(deep.methodology.version).toBe(quick.methodology.version);
    // only the recorded budget and the configuration digest legitimately differ
    expect(deep.analysis_manifest.budgets.max_scan_bytes ?? 0).toBeGreaterThan(
      quick.analysis_manifest.budgets.max_scan_bytes ?? 0,
    );
    expect(deep.methodology.config_digest).not.toBe(quick.methodology.config_digest);
  });

  it('Quick keeps the digest it always had (an analysis without a mode is a Quick analysis)', async () => {
    const spec = goodRepo();
    const implicit = await analyzeRepository(`${spec.owner}/${spec.repo}`, {
      fetch: fakeFetch(spec),
      clock: fixedClock,
    });
    const quick = await run(spec, 'quick');
    expect(quick.integrity.report_sha256).toBe(implicit.integrity.report_sha256);
  });

  it('a repository larger than the Quick budget is partial in Quick and better covered in Deep', async () => {
    const spec = manyFiles(120);
    const quick = await run(spec, 'quick');
    const deep = await run(spec, 'deep');
    const qs = quick.code_analysis.scan;
    const ds = deep.code_analysis.scan;
    expect(qs.skipped_over_budget).toBeGreaterThan(0);
    expect(ds.skipped_over_budget).toBe(0);
    expect(ds.files_scanned).toBeGreaterThan(qs.files_scanned);
    expect(ds.source_files_scanned).toBeGreaterThan(qs.source_files_scanned);
    expect(ds.source_coverage).toBeGreaterThan(qs.source_coverage);
    // the Quick reasons are structured: a code and the number of files, not prose
    const reasons = explainPartial(quick);
    expect(reasons.find((r) => r.code === 'SOURCE_SCAN_BUDGET_EXHAUSTED')).toMatchObject({
      count: qs.skipped_over_budget,
    });
    expect(
      explainPartial(deep).find((r) => r.code === 'SOURCE_SCAN_BUDGET_EXHAUSTED'),
    ).toBeUndefined();
    // Deep read more evidence; it is NOT asserted to produce more findings
    expect(deep.stats.evidence_count).toBeGreaterThanOrEqual(quick.stats.evidence_count);
  }, 60_000);
});

describe('the hosted analyzer is Quick only', () => {
  it('web analysis options always carry the Quick mode', () => {
    expect(webAnalysisOptions({}).mode).toBe('quick');
    expect(webAnalysisOptions({ ref: 'main' }, { token: 't' }).mode).toBe('quick');
  });
  it('a request that names a mode is refused with a clear code, even "quick"', async () => {
    const s = createWebServer({
      config: loadWebConfig({ PORT: '0' }),
      runAnalysis: async () => ({}) as never,
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const port = (s.address() as { port: number }).port;
      for (const mode of ['deep', 'quick', 'turbo']) {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repository: 'o/r', mode }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
          'UNSUPPORTED_ANALYSIS_MODE',
        );
      }
    } finally {
      await s.shutdown(50);
    }
  });
});

describe('CLI', () => {
  const capture = async (args: string[]) => {
    let out = '';
    let err = '';
    const code = await main(
      args,
      (s) => (out += s),
      (s) => (err += s),
    );
    return { code, out, err };
  };
  it('--help explains both modes and says Deep is bounded', async () => {
    const { out } = await capture(['--help']);
    expect(out).toContain('--mode <quick|deep>');
    expect(out).toMatch(/quick\s+fast bounded scan/);
    expect(out).toMatch(/deep\s+higher-coverage local scan/);
    expect(out).toContain('still bounded');
    expect(out).toContain('--history');
  });
  it('an unknown mode is a usage error and nothing is fetched', async () => {
    const { code, err } = await capture(['analyze', 'o/r', '--mode', 'turbo']);
    expect(code).toBe(64);
    expect(err).toContain('--mode must be "quick" or "deep"');
  });
  it('the text report says which mode ran', async () => {
    const spec = goodRepo();
    const r = await run(spec, 'quick');
    expect(renderText(r, { mode: 'quick' })).toContain('Mode: Quick');
    expect(renderText(r, { mode: 'deep' })).toContain('Mode: Deep');
    expect(renderText(r)).not.toContain('Mode:');
  });
});
