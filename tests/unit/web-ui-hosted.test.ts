/**
 * Hosted-service UX, written before the implementation: the hosted banner, deploy identification, shared-quota and queue
 * errors with a CLI fallback, an explained partial result, reproducibility details (exact SHA, configuration, integrity
 * hash with an honest explanation, data freshness) and large-report behaviour.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../web/public/app.js';
// @ts-expect-error plain browser ES module without type declarations
import { renderResult } from '../../web/public/render/result.js';

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests mutate arbitrary report fields
const fixture: Loose = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
const SHA = 'adbc8813901bba65827259daa8e22ff94ec1f30e';
const html = readFileSync('web/public/index.html', 'utf8');
const text = (n: Element | null | undefined) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('landing page', () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  it('states the hosted limits next to the input, before the form', () => {
    const banner = doc.querySelector('[data-banner="hosted"]');
    expect(banner).not.toBeNull();
    const t = text(banner);
    for (const phrase of [
      'Public repositories only',
      'History analysis is off',
      'Results are temporary',
      'Experimental preview',
    ])
      expect(t).toContain(phrase);
    expect(
      banner!.compareDocumentPosition(doc.getElementById('analyze-form')!) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it('has a place for the deployed build, links to the source and the CLI, and no marketing claims', () => {
    expect(doc.querySelector('[data-field="build"]')).not.toBeNull();
    const hrefs = [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://github.com/shadowhunter67/repo-radar');
    expect(
      hrefs.some((h) => h?.includes('repo-radar#command-line') || h?.includes('docs/web-analyzer')),
    ).toBe(true);
    expect(text(doc.body)).not.toMatch(
      /\b(is safe|trust score|detect(s)? malicious|malware-free)\b/i,
    );
    expect(doc.querySelector('meta[name="robots"][content*="noindex"]')).toBeNull(); // the landing page may be indexed
  });
});

function page(url = 'http://localhost/') {
  return new JSDOM(
    '<!doctype html><head></head><form id="analyze-form"><input id="repository"><input id="ref"><p id="normalised"></p><button id="analyze" type="submit">Analyze</button></form><div id="status"></div><div id="error"></div><div id="result"></div>',
    { url },
  );
}
async function submit(
  fetch: (url: string, o?: RequestInit) => Promise<Response>,
  repository = 'spf13/cobra',
) {
  vi.useFakeTimers();
  const dom = page();
  init(dom.window.document, {
    fetch,
    setTimeout,
    AbortController: dom.window.AbortController,
    location: dom.window.location,
  });
  (dom.window.document.getElementById('repository') as HTMLInputElement).value = repository;
  dom.window.document
    .getElementById('analyze-form')!
    .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(10_000);
  return dom.window.document;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('errors and the shared quota', () => {
  afterEach(() => vi.useRealTimers());

  it('a quota refusal at submit explains, gives the reset time, and offers the exact CLI command', async () => {
    const doc = await submit(async () =>
      json(
        503,
        {
          error: {
            code: 'SERVICE_RATE_LIMITED',
            message: 'x',
            reset_at: '2030-01-01T00:00:00.000Z',
          },
        },
        { 'retry-after': '120' },
      ),
    );
    const banner = doc.querySelector('[data-banner="service-rate-limited"]');
    expect(text(banner)).toContain('The hosted analyzer is temporarily rate-limited.');
    expect(text(banner)).toContain('Try again after 2030-01-01 00:00 UTC');
    expect(text(banner)).toContain('or run the CLI locally');
    expect(text(doc.querySelector('[data-field="cli-fallback"]'))).toBe(
      'node dist/cli.js analyze spf13/cobra --format json',
    );
    expect(doc.getElementById('result')?.querySelector('[data-section="score"]')).toBeNull();
    expect((doc.getElementById('analyze') as HTMLButtonElement).disabled).toBe(false);
  });

  it('without a reliable reset time it does not invent one', async () => {
    const doc = await submit(async () =>
      json(503, { error: { code: 'SERVICE_RATE_LIMITED', message: 'x' } }),
    );
    const t = text(doc.querySelector('[data-banner="service-rate-limited"]'));
    expect(t).toContain('temporarily rate-limited');
    expect(t).not.toContain('Try again after');
    expect(t).toContain('run the CLI locally');
  });

  it('a job that fails with SERVICE_RATE_LIMITED after queueing shows the same banner', async () => {
    let polls = 0;
    const doc = await submit(async (url) =>
      url === '/api/v1/analyze'
        ? json(202, { job_id: 'abcdefghijklmnopqrstuv', state: 'queued' })
        : (polls++,
          json(200, {
            job_id: 'abcdefghijklmnopqrstuv',
            state: 'failed',
            error: {
              code: 'SERVICE_RATE_LIMITED',
              message: 'x',
              reset_at: '2030-01-01T00:00:00.000Z',
            },
          })),
    );
    expect(polls).toBeGreaterThan(0);
    expect(text(doc.querySelector('[data-banner="service-rate-limited"]'))).toContain(
      'Try again after 2030-01-01 00:00 UTC',
    );
  });

  it.each([
    ['QUEUE_FULL', 'The analysis queue is full. Try again shortly.'],
    ['ANALYSIS_TIMEOUT', 'The analysis took too long and was stopped.'],
    ['UPSTREAM_UNAVAILABLE', 'An upstream evidence source was unavailable.'],
    ['SHUTTING_DOWN', 'The service is restarting. Try again in a minute.'],
    ['INTERNAL_ERROR', 'The analysis failed because of an internal error.'],
    ['REPOSITORY_NOT_FOUND', 'The repository was not found or is not accessible.'],
  ])('%s has its own message and never shows a stack trace', async (code, message) => {
    const doc = await submit(async () =>
      json(503, { error: { code, message: 'at Object.<anonymous> (/srv/x.js:1)' } }),
    );
    expect(text(doc.getElementById('error'))).toBe(message);
    expect(doc.body.textContent).not.toContain('/srv/x.js');
  });
});

describe('partial results', () => {
  const job = (extra: Loose = {}) => ({
    job_id: 'AAAAAAAAAAAAAAAAAAAAAA',
    state: 'partial',
    repository: { owner: 'spf13', repo: 'cobra' },
    analyzed_sha: SHA,
    partial_reasons: [
      {
        code: 'scan_limits',
        message: 'Source scan limits were reached: 149 candidate file(s) not fetched.',
      },
      { code: 'dependency_registry_failed', message: '2 dependency registry lookup(s) failed.' },
    ],
    report: fixture,
    ...extra,
  });
  const render = (j: Loose) => {
    const dom = new JSDOM('<!doctype html><body><main id="result"></main></body>');
    dom.window.document.getElementById('result')?.append(renderResult(dom.window.document, j));
    return dom.window.document;
  };
  it('explains why the result is partial and what that means, from the structured reasons', () => {
    const doc = render(job());
    const s = doc.querySelector('[data-section="partial"]');
    expect(s?.querySelector('h2')?.textContent).toBe('Why this result is partial');
    expect([...s!.querySelectorAll('li')].map((li) => text(li))).toEqual([
      'Source scan limits were reached: 149 candidate file(s) not fetched.',
      '2 dependency registry lookup(s) failed.',
    ]);
    expect(text(s)).toContain('Sections that depend on these sources may be incomplete');
    expect(text(s)).toContain('does not mean the repository is worse');
    // it comes before the score so a reader sees the caveat first
    const order = [...doc.querySelectorAll('[data-section]')].map((x) =>
      x.getAttribute('data-section'),
    );
    expect(order.indexOf('partial')).toBeLessThan(order.indexOf('score'));
  });
  it('a completed result has no partial section', () => {
    expect(
      render(job({ state: 'completed', partial_reasons: undefined })).querySelector(
        '[data-section="partial"]',
      ),
    ).toBeNull();
  });
  it('renders reasons as text, never as markup', () => {
    const doc = render(
      job({ partial_reasons: [{ code: 'x', message: '<img src=x onerror=alert(1)>' }] }),
    );
    expect(doc.querySelector('img')).toBeNull();
    expect(text(doc.querySelector('[data-section="partial"]'))).toContain(
      '<img src=x onerror=alert(1)>',
    );
  });
});

describe('reproducibility and integrity details', () => {
  const dom = new JSDOM('<!doctype html><body><main id="result"></main></body>', {
    url: 'http://localhost/',
  });
  const doc = dom.window.document;
  doc.getElementById('result')?.append(
    renderResult(doc, {
      job_id: 'AAAAAAAAAAAAAAAAAAAAAA',
      state: 'completed',
      repository: { owner: 'spf13', repo: 'cobra' },
      analyzed_sha: SHA,
      cached: true,
      report: fixture,
    }),
  );
  const root = doc.getElementById('result') as HTMLElement;
  const value = (f: string) => text(root.querySelector(`[data-field="${f}"]`));
  const label = (f: string) =>
    text(root.querySelector(`[data-field="${f}"]`)?.previousElementSibling);

  it('shows the exact CLI command that reproduces this analysis at this commit', () => {
    expect(value('cli-command')).toBe(
      `node dist/cli.js analyze spf13/cobra --ref ${SHA} --format json`,
    );
    expect(label('cli-command')).toBe('CLI command');
  });
  it('shows the configuration digest and the actual analysis configuration of the report', () => {
    expect(value('config-digest')).toBe(fixture.methodology.config_digest);
    expect(label('config-digest')).toBe('Configuration digest');
    const flags = root.querySelector('[data-section="technical"] [data-list="analysis-config"]');
    const rows = [...flags!.querySelectorAll('li')].map((li) => text(li));
    expect(rows).toContain('History analysis: off');
    expect(rows).toContain('Dependency artifact inspection: off');
    expect(rows).toContain('Cryptographic attestation verification: off');
    expect(rows).toContain('Source scan: on');
    expect(rows.some((r) => r.startsWith('Source scan byte budget:'))).toBe(true);
  });
  it('explains what the integrity hash is and is not, and offers a copy action', () => {
    expect(value('report-sha256')).toBe(fixture.integrity.report_sha256);
    const note = text(root.querySelector('[data-note="integrity"]'));
    expect(note).toContain('identifies the canonical content of this report');
    expect(note).toContain('not whether the repository or the report is trustworthy');
    expect(root.querySelector('button[data-action="copy-integrity"]')).not.toBeNull();
  });
  it('lists when each external source was read and whether it is tied to the commit or describes current state', () => {
    const rows = [...root.querySelectorAll('[data-list="data-freshness"] li')].map((li) =>
      text(li),
    );
    expect(rows).toEqual([
      'github: tied to this commit, retrieved 2026-10-25T10:51:29.940Z',
      'registry: current state when retrieved, retrieved 2026-10-25T10:51:29.940Z',
    ]);
    expect(text(root.querySelector('[data-note="freshness"]'))).toContain(
      'can change without any change to the repository',
    );
  });
  it('says when the result was served from the short-lived cache', () => {
    expect(text(root.querySelector('[data-banner="cached"]'))).toContain(
      'served from a short-lived cache',
    );
  });
  it('the copy action puts the hash on the clipboard', async () => {
    const written: string[] = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: { writeText: async (s: string) => void written.push(s) },
      configurable: true,
    });
    (root.querySelector('button[data-action="copy-integrity"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([fixture.integrity.report_sha256]);
  });
});

describe('large reports', () => {
  const big = (findings: number): Loose => {
    const r: Loose = JSON.parse(JSON.stringify(fixture));
    const proto = r.findings[0];
    r.findings = Array.from({ length: findings }, (_, i) => ({
      ...proto,
      id: `RR-X-${i}`,
      title: `Finding ${i} ${'x'.repeat(120)}`,
      summary: 'y'.repeat(300),
      evidence_ids: [],
    }));
    r.evidence = Array.from({ length: findings }, (_, i) => ({
      ...(fixture.evidence[0] ?? {}),
      id: `EV-${i}`,
    }));
    return r;
  };
  it.each([
    [1, 2_000],
    [5, 10_000],
  ])(
    'a synthetic ~%i MB report renders without freezing and keeps the DOM bounded',
    (mb, findings) => {
      const report = big(findings);
      expect(JSON.stringify(report).length / 1e6).toBeGreaterThan(mb * 0.5);
      const dom = new JSDOM('<!doctype html><body><main id="result"></main></body>');
      const started = Date.now();
      dom.window.document.getElementById('result')?.append(
        renderResult(dom.window.document, {
          job_id: 'AAAAAAAAAAAAAAAAAAAAAA',
          state: 'completed',
          repository: { owner: 'spf13', repo: 'cobra' },
          analyzed_sha: SHA,
          report,
        }),
      );
      expect(Date.now() - started).toBeLessThan(4000);
      const visibleRows = dom.window.document.querySelectorAll(
        'tbody tr[data-finding-id]:not([hidden])',
      );
      expect(visibleRows.length).toBeLessThanOrEqual(50);
      expect(dom.window.document.querySelectorAll('*').length).toBeLessThan(2500); // rows are created per page, not per finding
      expect(text(dom.window.document.querySelector('[data-field="finding-count"]'))).toBe(
        String(findings),
      );
    },
    30_000,
  );
});

describe('search indexing', () => {
  afterEach(() => vi.useRealTimers());
  it('adds noindex once an analysis starts or a repository is pre-filled, never on the bare landing page', async () => {
    const bare = page();
    init(bare.window.document, { fetch: vi.fn(), location: bare.window.location });
    expect(bare.window.document.querySelector('meta[name="robots"]')).toBeNull();
    const prefilled = page('http://localhost/?repo=spf13/cobra');
    init(prefilled.window.document, { fetch: vi.fn(), location: prefilled.window.location });
    expect(
      prefilled.window.document.querySelector('meta[name="robots"]')?.getAttribute('content'),
    ).toBe('noindex');
    const doc = await submit(async () => json(400, { error: { code: 'INVALID_REPOSITORY' } }));
    expect(doc.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
  });
});
