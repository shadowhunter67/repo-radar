import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { fakeFetch, fixedClock, type Recorded } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const token = 'ghp_' + 'x'.repeat(36);

describe('private repository contents routing', () => {
  it('uses authenticated contents API only and preserves public scan coverage', async () => {
    const privateRecorded: Recorded[] = [];
    const publicRecorded: Recorded[] = [];
    const base = { scorecard: false, osv: false, depsDev: false } as const;
    const privateReport = await analyzeRepository('acme/widget', {
      ...base,
      token,
      fetch: fakeFetch(goodRepo({ private: true }), privateRecorded),
      clock: fixedClock,
    });
    const publicReport = await analyzeRepository('acme/widget', {
      ...base,
      fetch: fakeFetch(goodRepo({ private: false }), publicRecorded),
      clock: fixedClock,
    });
    const privateContents = privateRecorded.filter((x) => x.url.includes('/contents/'));
    expect(privateContents.length).toBeGreaterThan(0);
    expect(privateContents.every((x) => x.headers.authorization === `Bearer ${token}`)).toBe(true);
    expect(
      privateContents.every((x) => x.headers.accept === 'application/vnd.github.raw+json'),
    ).toBe(true);
    expect(
      privateRecorded.some((x) => x.url.startsWith('https://raw.githubusercontent.com/')),
    ).toBe(false);
    expect(privateReport.code_analysis.scan.source_coverage).toBe(
      publicReport.code_analysis.scan.source_coverage,
    );
    expect(
      privateReport.diagnostics.some((d) => d.code === 'private_repository_contents_api'),
    ).toBe(true);
  });

  it('does not contact raw without a token and reports the explicit limitation', async () => {
    const recorded: Recorded[] = [];
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(goodRepo({ private: true }), recorded),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    });
    expect(recorded.some((x) => x.url.startsWith('https://raw.githubusercontent.com/'))).toBe(
      false,
    );
    expect(report.diagnostics.some((d) => d.code === 'scan_unavailable_private_repository')).toBe(
      true,
    );
    expect(report.code_analysis.scan.source_files_scanned).toBe(0);
  });

  it('turns a contents rate limit into partial scan coverage', async () => {
    const recorded: Recorded[] = [];
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(goodRepo({ private: true, rateLimited: ['/contents/'] }), recorded),
      token,
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    });
    expect(report.diagnostics.some((d) => d.code === 'rate_limited')).toBe(true);
    expect(report.diagnostics.some((d) => d.code === 'scan_unavailable_private_repository')).toBe(
      true,
    );
    expect(report.code_analysis.scan.source_files_scanned).toBe(0);
    expect(report.facts.find((f) => f.id === 'scan.absence_reliable')?.value).toBe(false);
  });
});
