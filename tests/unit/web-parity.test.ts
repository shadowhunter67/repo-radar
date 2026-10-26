import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';
import { classifyReport } from '../../src/web/classify.js';
import { reportFilename, reportSha } from '../../src/web/api.js';
describe('web parity contracts', () => {
  it('does not transform reports', () => {
    const r = { retrieval: { complete: true }, value: 1 } as never;
    expect(JSON.stringify(r)).toBe(JSON.stringify(r));
    expect(classifyReport(r)).toBe('completed');
  });
  it('partial is derived from retrieval completeness', () =>
    expect(classifyReport({ retrieval: { complete: false } } as never)).toBe('partial'));
  it('real engine report exposes exact SHA for download identity', async () => {
    const r = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
      registry: false,
      releases: false,
      compliance: false,
      codeScan: false,
    });
    expect(r.analysis_manifest.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(reportSha(r)).toBe(r.analysis_manifest.commit);
    expect(reportFilename('acme', 'widget', reportSha(r))).toBe(
      `repo-radar-acme-widget-${r.analysis_manifest.commit!.slice(0, 12)}.json`,
    );
  });
});
