/**
 * Vietnamese is the default; English is one click away, in place, with no reload, request, storage or telemetry.
 * Only interface text is translated: evidence (ids, titles, summaries, names, paths, SHAs, versions, URLs, the CLI command)
 * and every report value stay exactly as the engine produced them.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../web/public/app.js';
// @ts-expect-error plain browser ES module without type declarations
import { getLanguage, messageTemplates, setLanguage, t } from '../../web/public/i18n.js';
// @ts-expect-error plain browser ES module without type declarations
import { renderResult } from '../../web/public/render/result.js';

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests mutate arbitrary report fields
const fixture: Loose = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
const html = readFileSync('web/public/index.html', 'utf8');
const SHA = 'adbc8813901bba65827259daa8e22ff94ec1f30e';
const text = (n: Element | null | undefined) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => setLanguage('vi'));
afterEach(() => {
  vi.useRealTimers();
  setLanguage('en'); // the rest of the suite is written in English (tests/setup-i18n.ts)
});

describe('default language and dictionaries', () => {
  it('a freshly loaded module starts in Vietnamese', async () => {
    vi.resetModules();
    // @ts-expect-error plain browser ES module without type declarations
    const fresh = (await import('../../web/public/i18n.js')) as { getLanguage: () => string };
    expect(fresh.getLanguage()).toBe('vi');
  });
  it('the page as served is Vietnamese: html lang, title, static labels', () => {
    const doc = new JSDOM(html).window.document;
    expect(doc.documentElement.getAttribute('lang')).toBe('vi');
    expect(doc.title).toBe('repo-radar — Bản xem trước thử nghiệm');
    expect(text(doc.querySelector('label[for="repository"]'))).toBe('Kho mã');
    expect(text(doc.getElementById('analyze'))).toBe('Phân tích');
  });
  it('both languages define exactly the same keys and the same placeholders', () => {
    const vi_ = messageTemplates('vi') as Record<string, string>;
    const en = messageTemplates('en') as Record<string, string>;
    expect(Object.keys(vi_).sort()).toEqual(Object.keys(en).sort());
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(en)) expect(holes(vi_[k]!), k).toEqual(holes(en[k]!));
  });
  it('t() falls back to the key, only the two languages exist, and placeholders are filled', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
    setLanguage('fr');
    expect(getLanguage()).toBe('vi');
    expect(t('form.analyze')).toBe('Phân tích');
    setLanguage('en');
    expect(t('form.normalised', { value: 'a/b' })).toBe('Normalised: a/b');
  });
  it('keeps the key disclaimers in Vietnamese with their exact meaning', () => {
    expect(t('score.note')).toBe(
      'Điểm số là chỉ số kinh nghiệm suy ra từ bằng chứng, không phải xác suất an toàn.',
    );
    expect(t('capabilities.note')).toBe(
      'Khả năng mô tả mã có thể làm gì, không khẳng định ý định.',
    );
    expect(t('compliance.banner')).toBe(
      'Chỉ mang tính chỉ báo. Không phải tư vấn pháp lý. Không phải chứng nhận tuân thủ.',
    );
  });
});

function boot() {
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    calls.push(`${options?.method ?? 'GET'} ${url}`);
    if (url === '/api/v1/analyze')
      return json(202, { job_id: 'abcdefghijklmnopqrstuv', state: 'queued' });
    return json(200, {
      job_id: 'abcdefghijklmnopqrstuv',
      state: 'completed',
      repository: { owner: 'spf13', repo: 'cobra' },
      analyzed_sha: SHA,
      report: fixture,
    });
  });
  init(dom.window.document, {
    fetch,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    AbortController: dom.window.AbortController,
    location: dom.window.location,
  });
  return { dom, doc: dom.window.document, calls, fetch };
}
const click = (doc: Document, lang: string) =>
  (doc.querySelector(`[data-lang="${lang}"]`) as HTMLButtonElement).click();
async function analyze(dom: JSDOM) {
  vi.useFakeTimers();
  const doc = dom.window.document;
  (doc.getElementById('repository') as HTMLInputElement).value = 'spf13/cobra';
  doc
    .getElementById('analyze-form')!
    .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(5000);
}

describe('language toggle', () => {
  it('starts in Vietnamese with VI pressed, switches to English and back without a reload', () => {
    const { doc } = boot();
    expect(doc.documentElement.getAttribute('lang')).toBe('vi');
    expect(doc.querySelector('[data-lang="vi"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(doc.querySelector('[data-lang="en"]')?.getAttribute('aria-pressed')).toBe('false');
    click(doc, 'en');
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
    expect(doc.title).toBe('repo-radar — Experimental Preview');
    expect(text(doc.querySelector('label[for="repository"]'))).toBe('Repository');
    expect(text(doc.getElementById('analyze'))).toBe('Analyze');
    expect(text(doc.querySelector('.lede'))).toBe(
      'Analyze observable repository and software supply-chain evidence.',
    );
    expect(doc.querySelector('[data-lang="en"]')?.getAttribute('aria-pressed')).toBe('true');
    click(doc, 'vi');
    expect(doc.documentElement.getAttribute('lang')).toBe('vi');
    expect(doc.title).toBe('repo-radar — Bản xem trước thử nghiệm');
    expect(text(doc.getElementById('analyze'))).toBe('Phân tích');
    expect(text(doc.querySelector('.lede'))).toBe(
      'Phân tích bằng chứng có thể quan sát được của kho mã và chuỗi cung ứng phần mềm.',
    );
  });
  it('translates placeholders, the hosted notes, the links and the group label', () => {
    const { doc } = boot();
    click(doc, 'en');
    expect([...doc.querySelectorAll('[data-banner="hosted"] li')].map((li) => text(li))).toEqual([
      'Public repositories only',
      'History analysis is off',
      'Results are temporary',
      'Experimental preview',
    ]);
    expect(doc.getElementById('ref')?.getAttribute('placeholder')).toBe('main or commit SHA');
    expect(doc.querySelector('.lang-switch')?.getAttribute('aria-label')).toBe('Language');
    expect([...doc.querySelectorAll('.links a')].map((a) => text(a))).toEqual([
      'README',
      'Source',
      'About this service and the CLI',
      'Methodology',
      'Limitations',
    ]);
    click(doc, 'vi');
    expect([...doc.querySelectorAll('.links a')].map((a) => text(a))).toEqual([
      'README',
      'Mã nguồn',
      'Về dịch vụ này và CLI',
      'Phương pháp luận',
      'Hạn chế',
    ]);
    expect(doc.querySelector('.lang-switch')?.getAttribute('aria-label')).toBe('Ngôn ngữ');
  });
  it('the buttons are real keyboard-usable buttons with accessible names, and nothing is stored', () => {
    const { dom, doc } = boot();
    const buttons = [...doc.querySelectorAll('.lang-switch button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Tiếng Việt', 'English']);
    expect(buttons.every((b) => b.type === 'button' && b.tabIndex >= 0)).toBe(true);
    click(doc, 'en');
    expect(dom.window.localStorage.length).toBe(0);
    expect(dom.window.sessionStorage.length).toBe(0);
    expect(doc.cookie).toBe('');
  });
});

describe('dynamic UI follows the language without another analysis', () => {
  it('headings and labels change; values, ids, names and the CLI command do not; no request is made', async () => {
    const { dom, doc, calls } = boot();
    await analyze(dom);
    const heads = () =>
      [
        ...doc.querySelectorAll('#result [data-section] > h2, #result [data-section] > summary'),
      ].map((h) => text(h));
    expect(heads()).toEqual([
      'Tổng quan',
      'Điểm',
      'Độ tin cậy',
      'Độ phủ',
      'Phát hiện',
      'Phụ thuộc',
      'Phát hành & nguồn gốc',
      'Khả năng & thực thi',
      'Quản trị',
      'Tuân thủ',
      'Chi tiết kỹ thuật',
    ]);
    const col = (c: string) =>
      [...doc.querySelectorAll(`tr[data-finding-id] [data-col="${c}"]`)].map((n) => text(n));
    const field = (f: string) => text(doc.querySelector(`[data-field="${f}"]`));
    const values = () => ({
      score: field('score'),
      grade: field('grade'),
      confidence: field('confidence'),
      coverage: field('coverage'),
      sha: field('sha'),
      repo: field('repository'),
      direct: field('direct-count'),
      transitive: field('transitive-count'),
      integrity: field('report-sha256'),
      schema: field('schema-version'),
      methodology: field('methodology-version'),
      cli: field('cli-command'),
      ids: [...doc.querySelectorAll('tr[data-finding-id]')].map((r) =>
        r.getAttribute('data-finding-id'),
      ),
      titles: col('title'),
      summaries: col('summary'),
      severities: col('severity'),
      ecosystems: field('ecosystems'),
      hooks: [...doc.querySelectorAll('[data-hook-id],[data-chain-id]')].map((n) => text(n)),
      diagnostics: [...doc.querySelectorAll('[data-diagnostic]')].map((n) => text(n)),
    });
    const before = values();
    expect(before.score).toBe('83.5');
    expect(before.cli).toBe(`node dist/cli.js analyze spf13/cobra --ref ${SHA} --format json`);
    const requests = calls.length;
    click(doc, 'en');
    expect(heads()).toEqual([
      'Overview',
      'Score',
      'Confidence',
      'Coverage',
      'Findings',
      'Dependencies',
      'Release & Provenance',
      'Capabilities & execution',
      'Governance',
      'Compliance',
      'Technical details',
    ]);
    expect(values()).toEqual(before);
    click(doc, 'vi');
    expect(values()).toEqual(before);
    expect(calls.length).toBe(requests); // switching language never re-runs or re-fetches anything
    expect(calls.filter((c) => c === 'POST /api/v1/analyze')).toHaveLength(1);
  });
  it('field labels, filter labels, pagination and the dialog button follow the language', async () => {
    const { dom, doc } = boot();
    await analyze(dom);
    const label = (f: string) =>
      text(doc.querySelector(`[data-field="${f}"]`)?.previousElementSibling);
    expect(label('sha')).toBe('Commit đã phân tích (SHA chính xác)');
    expect(label('generated-at')).toBe('Thời gian phân tích');
    expect(label('coverage')).toBe('Độ phủ bằng chứng tổng thể');
    expect(label('direct-count')).toBe('Phụ thuộc trực tiếp');
    expect(label('transitive-count')).toBe('Phụ thuộc bắc cầu');
    expect(label('finding-count')).toBe('Số phát hiện hiển thị');
    expect(text(doc.querySelector('label[for="findings-severity"]'))).toBe('Mức độ');
    expect(text(doc.querySelector('label[for="findings-category"]'))).toBe('Danh mục');
    expect(text(doc.querySelector('label[for="findings-search"]'))).toBe('Tìm phát hiện');
    expect(text(doc.querySelector('[data-pagination="prev"]'))).toBe('Trước');
    expect(text(doc.querySelector('[data-pagination="next"]'))).toBe('Sau');
    expect(text(doc.querySelector('a[data-action="download"]'))).toBe('Tải báo cáo JSON');
    expect(text(doc.querySelector('[data-banner="indicative"]'))).toBe(
      'Chỉ mang tính chỉ báo. Không phải tư vấn pháp lý. Không phải chứng nhận tuân thủ.',
    );
    (doc.querySelector('tr[data-finding-id="RR-EXEC-001"]') as HTMLElement).click();
    expect(text(doc.querySelector('[data-evidence-dialog] button'))).toBe('Đóng');
    click(doc, 'en');
    expect(label('sha')).toBe('Analyzed commit (exact SHA)');
    expect(text(doc.querySelector('[data-pagination="prev"]'))).toBe('Previous');
    expect(text(doc.querySelector('[data-pagination="next"]'))).toBe('Next');
    expect(text(doc.querySelector('a[data-action="download"]'))).toBe('Download JSON report');
  });
  it('dimension names are Vietnamese in Vietnamese and as the report names them in English', async () => {
    const { dom, doc } = boot();
    await analyze(dom);
    const row = (d: string) => text(doc.querySelector(`[data-dimension="${d}"]`));
    expect(row('maintenance')).toBe('Bảo trì 90%');
    expect(row('supply-chain')).toBe('Chuỗi cung ứng 88.5%');
    click(doc, 'en');
    expect(row('maintenance')).toBe('Maintenance 90%');
    expect(row('supply-chain')).toBe('Supply Chain 88.5%');
  });
  it('an error message is repainted in the new language', async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    init(dom.window.document, {
      fetch: async () =>
        json(503, { error: { code: 'QUEUE_FULL', message: 'x' } }, { 'retry-after': '5' }),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      AbortController: dom.window.AbortController,
      location: dom.window.location,
    });
    const doc = dom.window.document;
    (doc.getElementById('repository') as HTMLInputElement).value = 'spf13/cobra';
    doc
      .getElementById('analyze-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(text(doc.getElementById('error'))).toBe('Hàng đợi phân tích đã đầy. Hãy thử lại sau.');
    click(doc, 'en');
    expect(text(doc.getElementById('error'))).toBe(
      'The analysis queue is full. Try again shortly.',
    );
    click(doc, 'vi');
    expect(text(doc.getElementById('error'))).toBe('Hàng đợi phân tích đã đầy. Hãy thử lại sau.');
  });
  it.each([
    ['INVALID_REPOSITORY', 'Hãy nhập kho mã GitHub công khai theo dạng owner/repo.'],
    ['REPOSITORY_NOT_FOUND', 'Không tìm thấy kho mã hoặc kho mã không thể truy cập.'],
    ['RATE_LIMITED', 'Đã chạm giới hạn GitHub API.'],
    ['SERVICE_RATE_LIMITED', 'Dịch vụ phân tích đang tạm thời bị giới hạn lưu lượng.'],
    ['QUEUE_FULL', 'Hàng đợi phân tích đã đầy. Hãy thử lại sau.'],
    ['ANALYSIS_TIMEOUT', 'Quá trình phân tích mất quá nhiều thời gian và đã bị dừng.'],
    ['UPSTREAM_UNAVAILABLE', 'Một nguồn bằng chứng bên ngoài hiện không khả dụng.'],
  ])('%s in Vietnamese', (code, expected) => {
    expect(t(`error.${code}`)).toBe(expected);
  });
  it('a partial result keeps its explanation and the engine-provided reasons verbatim', () => {
    const dom = new JSDOM('<!doctype html><body><main id="result"></main></body>');
    const reason = 'Source scan limits were reached: 149 candidate file(s) not fetched.';
    dom.window.document.getElementById('result')?.append(
      renderResult(dom.window.document, {
        job_id: 'AAAAAAAAAAAAAAAAAAAAAA',
        state: 'partial',
        repository: { owner: 'spf13', repo: 'cobra' },
        analyzed_sha: SHA,
        partial_reasons: [{ code: 'scan_limits', message: reason }],
        report: fixture,
      }),
    );
    const part = dom.window.document.querySelector('[data-section="partial"]');
    expect(text(part?.querySelector('h2'))).toBe('Vì sao kết quả này chưa đầy đủ');
    expect(text(part?.querySelector('li'))).toBe(reason);
    expect(text(dom.window.document.querySelector('[data-banner="partial"]'))).toContain(
      'bằng chứng chưa đầy đủ',
    );
  });
});
