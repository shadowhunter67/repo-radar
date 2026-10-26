import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';
describe('web stages', () => {
  it('callback is additive', async () => {
    const stages: string[] = [];
    const a = await analyzeRepository('acme/widget', {
      scorecard: false,
      osv: false,
      depsDev: false,
      registry: false,
      releases: false,
      compliance: false,
      codeScan: false,
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
    });
    const b = await analyzeRepository('acme/widget', {
      scorecard: false,
      osv: false,
      depsDev: false,
      registry: false,
      releases: false,
      compliance: false,
      codeScan: false,
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
      onStage: (s) => stages.push(s),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(stages).toEqual([
      'repository_resolved',
      'evidence_collected',
      'dependencies_parsed',
      'findings_evaluated',
      'report_built',
    ]);
  });
});
