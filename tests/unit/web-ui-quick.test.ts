/**
 * Quick Scan positioning, the three coverage dimensions, structured and localized partial reasons, and the Deep Scan next step.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain browser ES module without type declarations
import { applyStatic, setLanguage } from '../../web/public/i18n.js';
// @ts-expect-error plain browser ES module without type declarations
import { renderResult } from '../../web/public/render/result.js';

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests mutate arbitrary report fields
const fixture: Loose = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
const html = readFileSync('web/public/index.html', 'utf8');
const SHA = 'adbc8813901bba65827259daa8e22ff94ec1f30e';
const text = (n: Element | null | undefined) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

afterEach(() => setLanguage('en'));

function mount(job: Loose, lang = 'en') {
  setLanguage(lang);
  const dom = new JSDOM('<!doctype html><body><main id="result"></main></body>');
  dom.window.document.getElementById('result')?.append(renderResult(dom.window.document, job));
  return dom.window.document;
}
const report = (over: (r: Loose) => void = () => undefined): Loose => {
  const r: Loose = JSON.parse(JSON.stringify(fixture));
  over(r);
  return r;
};
const job = (r: Loose, state = 'completed', extra: Loose = {}): Loose => ({
  job_id: 'AAAAAAAAAAAAAAAAAAAAAA',
  state,
  repository: { owner: 'spf13', repo: 'cobra' },
  analyzed_sha: SHA,
  report: r,
  ...extra,
});
/** Overall evidence coverage is high while only 40 of 401 source files were scanned: the case that confused readers. */
const thin = report((r) => {
  r.overall.weight_covered = 1;
  Object.assign(r.code_analysis.scan, {
    source_files_scanned: 40,
    source_files_total: 401,
    source_coverage: 40 / 401,
  });
  r.dependency_registry_intel.coverage = {
    ...r.dependency_registry_intel.coverage,
    eligible: 383,
    queried: 33,
  };
});

describe('Quick Scan positioning on the landing page', () => {
  it('Vietnamese by default: headline, intro and the four-step funnel', () => {
    const doc = new JSDOM(html).window.document;
    expect(text(doc.querySelector('h1'))).toBe('Web Analyzer — Bản xem trước Quét nhanh');
    expect(text(doc.querySelector('.quick-intro'))).toContain('tài nguyên có giới hạn');
    expect(text(doc.querySelector('.quick-intro'))).toContain('chưa đầy đủ');
    expect(text(doc.querySelector('.steps'))).toContain('Deep Scan bằng CLI');
  });
  it('English equivalent, with no "complete audit" style claim in either language', () => {
    const doc = new JSDOM(html).window.document;
    setLanguage('en');
    applyStatic(doc);
    expect(text(doc.querySelector('h1'))).toBe('Web Analyzer — Quick Scan Preview');
    expect(text(doc.querySelector('.quick-intro'))).toContain('bounded resources');
    expect(text(doc.querySelector('.quick-intro'))).toContain(
      'Large repositories may return partial results',
    );
    expect(text(doc.body)).not.toMatch(/complete audit|full (security )?audit|kiểm toán đầy đủ/i);
  });
  it('offers the small repositories that finish quickly as examples', () => {
    const doc = new JSDOM(html).window.document;
    expect(
      [...doc.querySelectorAll('[data-example]')].map((b) => b.getAttribute('data-example')),
    ).toEqual([
      'sindresorhus/is-plain-obj',
      'sindresorhus/yocto-queue',
      'pallets/itsdangerous',
      'spf13/cobra',
    ]);
  });
});

describe('three coverage dimensions are shown separately', () => {
  it('overall evidence 100% next to source 40 / 401 files (10%) and dependency lookups 33 / 383', () => {
    const doc = mount(job(thin, 'partial'));
    const field = (f: string) => text(doc.querySelector(`[data-field="${f}"]`));
    const label = (f: string) =>
      text(doc.querySelector(`[data-field="${f}"]`)?.previousElementSibling);
    expect(label('coverage')).toBe('Overall evidence coverage');
    expect(field('coverage')).toBe('100%');
    expect(label('source-files')).toBe('Source files scanned');
    expect(field('source-files')).toBe('40 / 401 files');
    expect(label('source-coverage')).toBe('Source code coverage');
    expect(field('source-coverage')).toBe('10%');
    expect(label('dependency-lookup')).toBe('Dependency lookup coverage');
    expect(field('dependency-lookup')).toBe('33 / 383 dependencies');
    expect(text(doc.querySelector('[data-note="coverage-meaning"]'))).toBe(
      'Overall evidence coverage does not mean every source file was scanned.',
    );
  });
  it('in Vietnamese', () => {
    const doc = mount(job(thin, 'partial'), 'vi');
    const field = (f: string) => text(doc.querySelector(`[data-field="${f}"]`));
    const label = (f: string) =>
      text(doc.querySelector(`[data-field="${f}"]`)?.previousElementSibling);
    expect(label('coverage')).toBe('Độ phủ bằng chứng tổng thể');
    expect(label('source-coverage')).toBe('Độ phủ mã nguồn');
    expect(field('source-files')).toBe('40 / 401 tệp');
    expect(label('dependency-lookup')).toBe('Độ phủ tra cứu dependency');
    expect(field('dependency-lookup')).toBe('33 / 383 dependency');
    expect(text(doc.querySelector('[data-note="coverage-meaning"]'))).toBe(
      'Độ phủ bằng chứng tổng thể không có nghĩa toàn bộ mã nguồn đã được đọc.',
    );
  });
  it('the dependency lookup row is omitted when the report has no trustworthy denominator', () => {
    expect(mount(job(report())).querySelector('[data-field="dependency-lookup"]')).toBeNull();
  });
  it('the numbers themselves are the report numbers, unchanged by presentation', () => {
    const doc = mount(job(thin, 'partial'));
    expect(text(doc.querySelector('[data-field="coverage"]'))).toBe('100%');
    expect(thin.overall.weight_covered).toBe(1);
  });
});

describe('structured partial reasons, localized', () => {
  const reasons = [
    { code: 'SOURCE_SCAN_BUDGET_EXHAUSTED', count: 361, message: 'English fallback' },
    { code: 'FILE_TOO_LARGE', count: 2, message: 'x' },
    { code: 'DEPENDENCY_LOOKUP_BUDGET_EXHAUSTED', count: 350, message: 'x' },
    { code: 'REGISTRY_LOOKUP_FAILED', count: 3, message: 'x' },
    { code: 'UPSTREAM_RESPONSE_TOO_LARGE', message: 'x' },
    { code: 'RATE_LIMITED', message: 'x' },
    { code: 'TIMEOUT', message: 'x' },
  ];
  const lines = (doc: Document) =>
    [...doc.querySelectorAll('[data-section="partial"] li')].map((li) => text(li));
  it('Vietnamese sentences with the counts from the code', () => {
    expect(lines(mount(job(thin, 'partial', { partial_reasons: reasons }), 'vi'))).toEqual([
      '361 tệp chưa được lấy do đã đạt ngân sách quét mã nguồn.',
      '2 tệp vượt giới hạn kích thước.',
      '350 dependency chưa được tra cứu do đã đạt ngân sách request.',
      '3 lượt tra cứu registry thất bại.',
      'Một phản hồi từ nguồn bên ngoài quá lớn nên bị bỏ qua.',
      'Một nguồn bên ngoài đã chạm giới hạn lưu lượng.',
      'Một yêu cầu tới nguồn bên ngoài đã hết thời gian chờ.',
    ]);
  });
  it('English equivalents exist for every code', () => {
    expect(lines(mount(job(thin, 'partial', { partial_reasons: reasons }), 'en'))).toEqual([
      '361 files were not fetched because the source scan budget was reached.',
      '2 files exceeded the size limit.',
      '350 dependencies were not looked up because the request budget was reached.',
      '3 registry lookups failed.',
      'A response from an external source was too large and was skipped.',
      'An external source reached its rate limit.',
      'A request to an external source timed out.',
    ]);
  });
  it('the sentence follows the language without another request', () => {
    const doc = mount(job(thin, 'partial', { partial_reasons: reasons.slice(0, 1) }), 'en');
    expect(lines(doc)[0]).toContain('361 files');
    const doc2 = mount(job(thin, 'partial', { partial_reasons: reasons.slice(0, 1) }), 'vi');
    expect(lines(doc2)[0]).toContain('361 tệp');
  });
  it('old string-only reasons and unknown codes fall back to their own text and never crash', () => {
    const doc = mount(
      job(thin, 'partial', {
        partial_reasons: [
          'Source scan limits were reached: 149 candidate file(s) not fetched.',
          { message: 'Legacy object without a code' },
          { code: 'SOMETHING_NEW', message: 'A reason from a newer server' },
          { code: 'ONLY_A_CODE' },
        ],
      }),
      'vi',
    );
    expect(lines(doc)).toEqual([
      'Source scan limits were reached: 149 candidate file(s) not fetched.',
      'Legacy object without a code',
      'A reason from a newer server',
      'ONLY_A_CODE',
    ]);
  });
  it('reasons are text, never markup', () => {
    const doc = mount(
      job(thin, 'partial', {
        partial_reasons: [{ code: 'X', message: '<img src=x onerror=alert(1)>' }],
      }),
    );
    expect(doc.querySelector('img')).toBeNull();
    expect(lines(doc)).toEqual(['<img src=x onerror=alert(1)>']);
  });
  it('partial is explained as incomplete evidence, not as a failure', () => {
    const doc = mount(job(thin, 'partial', { partial_reasons: reasons }), 'vi');
    expect(text(doc.querySelector('[data-banner="partial"]'))).toContain('chưa đầy đủ');
    expect(text(doc.body)).not.toMatch(/thất bại\.?$/);
    expect(text(doc.querySelector('[data-section="partial"] h2'))).toBe(
      'Vì sao kết quả này chưa đầy đủ',
    );
  });
});

describe('Deep Scan next step', () => {
  const deep = `node dist/cli.js analyze spf13/cobra --ref ${SHA} --mode deep`;
  it('a partial result gets a prominent call to action with the exact-SHA command', () => {
    const doc = mount(job(thin, 'partial', { partial_reasons: [] }), 'vi');
    const cta = doc.querySelector('[data-banner="deep-cta"]');
    expect(text(cta?.querySelector('h3'))).toBe('Cần phân tích sâu hơn?');
    expect(text(cta)).toContain('Chạy Deep Scan bằng CLI để tăng độ phủ và ngân sách phân tích.');
    expect(text(cta?.querySelector('[data-field="deep-command"]'))).toBe(deep);
    expect(
      cta?.querySelector('button[data-action="copy-deep"]')?.getAttribute('data-command'),
    ).toBe(deep);
    expect(doc.querySelector('[data-note="deep-hint"]')).toBeNull(); // only one of the two forms is shown
  });
  it('English wording', () => {
    const cta = mount(job(thin, 'partial', { partial_reasons: [] }), 'en').querySelector(
      '[data-banner="deep-cta"]',
    );
    expect(text(cta?.querySelector('h3'))).toBe('Need deeper analysis?');
    expect(text(cta)).toContain(
      'Run a Deep Scan with the CLI to raise coverage and the analysis budgets.',
    );
  });
  it('thin source coverage triggers it even when the job completed', () => {
    expect(mount(job(thin, 'completed')).querySelector('[data-banner="deep-cta"]')).not.toBeNull();
  });
  it('a fully scanned completed result only shows a small hint, with the same command', () => {
    const doc = mount(job(report((r) => (r.code_analysis.scan.source_coverage = 1))));
    expect(doc.querySelector('[data-banner="deep-cta"]')).toBeNull();
    expect(text(doc.querySelector('[data-note="deep-hint"]'))).toBe(
      'Need deeper analysis? Run a Deep Scan with the CLI:',
    );
    expect(text(doc.querySelector('[data-field="deep-command"]'))).toBe(deep);
  });
  it('the command is the same in both languages and uses the exact analyzed SHA', () => {
    const a = text(mount(job(thin, 'partial'), 'vi').querySelector('[data-field="deep-command"]'));
    const b = text(mount(job(thin, 'partial'), 'en').querySelector('[data-field="deep-command"]'));
    expect(a).toBe(b);
    expect(a).toContain(`--ref ${SHA} --mode deep`);
  });
  it('without a known SHA the command is still valid (no --ref is invented)', () => {
    const doc = mount(job(thin, 'partial', { analyzed_sha: null }));
    expect(text(doc.querySelector('[data-field="deep-command"]'))).toBe(
      'node dist/cli.js analyze spf13/cobra --mode deep',
    );
  });
  it('the call to action never says the repository is unsafe', () => {
    expect(text(mount(job(thin, 'partial')).querySelector('[data-banner="deep-cta"]'))).not.toMatch(
      /unsafe|malicious|dangerous|nguy hiểm|độc hại/i,
    );
  });
});
