import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import type { Report } from '../../src/report/schema.js';
import { classifyReport } from '../../src/web/classify.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

async function engine(spec: FakeSpec): Promise<Report> {
  return analyzeRepository('acme/widget', {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    scorecard: false,
    osv: false,
    depsDev: false,
    registry: false,
    dependencyRegistry: false,
  });
}
// the fake GitHub answers 404 for the community profile unless it is given one; a real healthy repository has it
const healthy = (): FakeSpec => ({ ...goodRepo(), community: {} });
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests mutate arbitrary report fields
const clone = (r: Report): Loose => JSON.parse(JSON.stringify(r));

describe('web classification of a real engine report', () => {
  it('a clean small repository is completed, and the healthy report really carries the `failed: 0` keys a text search would trip on', async () => {
    const r = await engine(healthy());
    expect(JSON.stringify(r)).toContain('"failed":0');
    expect(classifyReport(r)).toBe('completed');
  });

  // public repositories read file contents from the raw host, so `/contents/` is not an API path of the default scan
  it.each([
    '/commits',
    '/releases',
    '/community',
    '/issues',
    '/git/trees',
    '/contributors',
    '/pulls',
  ])('GitHub rate limiting on %s never yields completed', async (path) => {
    const r = await engine({ ...healthy(), rateLimited: [path] });
    expect(r.diagnostics.some((d) => d.code === 'rate_limited')).toBe(true);
    expect(classifyReport(r)).toBe('partial');
  });

  it('a truncated git tree is partial', async () => {
    const r = await engine({ ...healthy(), treeTruncated: true });
    expect(classifyReport(r)).toBe('partial');
  });

  describe('each single completeness signal flips a completed report to partial', () => {
    const triggers: [string, (r: Loose) => void][] = [
      ['retrieval.complete = false', (r) => (r.retrieval.complete = false)],
      ['retrieval.github_truncated', (r) => (r.retrieval.github_truncated = true)],
      ['retrieval.stopped_by is not complete', (r) => (r.retrieval.stopped_by = 'request_budget')],
      ['retrieval.failed_requests > 0', (r) => (r.retrieval.failed_requests = 2)],
      [
        'a warn diagnostic',
        (r) => r.diagnostics.push({ source: 'osv', level: 'warn', code: 'x', message: 'x' }),
      ],
      [
        'an error diagnostic',
        (r) => r.diagnostics.push({ source: 'osv', level: 'error', code: 'x', message: 'x' }),
      ],
      [
        'a rate_limited diagnostic code at info level',
        (r) =>
          r.diagnostics.push({
            source: 'github',
            level: 'info',
            code: 'rate_limited',
            message: 'x',
          }),
      ],
      [
        'a scan_limit diagnostic code at info level',
        (r) =>
          r.diagnostics.push({
            source: 'analysis',
            level: 'info',
            code: 'scan_limit',
            message: 'x',
          }),
      ],
      [
        'scan limits_hit',
        (r) => (r.code_analysis.scan.limits_hit = ['149 candidate file(s) not fetched']),
      ],
      ['dependency registry failures', (r) => (r.dependency_registry_intel.coverage.failed = 1)],
      [
        'dependency registry skipped by budget',
        (r) => (r.dependency_registry_intel.coverage.skipped = 3),
      ],
      [
        'dependency registry rate limited',
        (r) => (r.dependency_registry_intel.status = 'rate_limited'),
      ],
      ['own-package registry unavailable', (r) => (r.registry_intel.status = 'unavailable')],
      [
        'own-package registry limits hit',
        (r) => (r.registry_intel.limits_hit = ['request_budget']),
      ],
      [
        'vulnerability lookup unavailable',
        (r) => (r.dependency_intel.vulnerability_lookup.state = 'unavailable'),
      ],
    ];
    it.each(triggers)('%s', async (_name, mutate) => {
      const base = clone(await engine(healthy()));
      expect(classifyReport(base as Report)).toBe('completed');
      mutate(base);
      expect(classifyReport(base as Report)).toBe('partial');
    });
  });

  it('informational diagnostics that only say nothing is published do not make a report partial', async () => {
    const base = clone(await engine(healthy()));
    base.diagnostics.push(
      {
        source: 'scorecard',
        level: 'info',
        code: 'scorecard_unavailable',
        message: 'none published',
      },
      { source: 'osv', level: 'info', code: 'osv_no_exact_versions', message: 'no exact versions' },
      { source: 'github', level: 'info', code: 'no_release_assets', message: 'no assets' },
    );
    base.dependency_intel.vulnerability_lookup.state = 'not_checked';
    expect(classifyReport(base as Report)).toBe('completed');
  });
});
