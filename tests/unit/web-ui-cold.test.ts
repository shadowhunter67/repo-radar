/**
 * A free host that was idle answers the first requests with a gateway page or refuses the connection while it wakes.
 * The page must wait with a neutral message (no internal-error banner, no fake progress) and then carry on.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../web/public/app.js';

const html = readFileSync('web/public/index.html', 'utf8');
const fixture = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8')) as object;
const text = (n: Element | null) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function start(fetch: (url: string, o?: RequestInit) => Promise<Response>) {
  vi.useFakeTimers();
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  init(dom.window.document, {
    fetch,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    AbortController: dom.window.AbortController,
    location: dom.window.location,
  });
  const doc = dom.window.document;
  (doc.getElementById('repository') as HTMLInputElement).value = 'spf13/cobra';
  doc
    .getElementById('analyze-form')!
    .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return doc;
}
const job = { job_id: 'abcdefghijklmnopqrstuv', state: 'queued' };

describe('cold start of the host', () => {
  afterEach(() => vi.useRealTimers());

  it('waits through a gateway page and a refused connection, shows a neutral message, then completes', async () => {
    let n = 0;
    const doc = start(async (url) => {
      if (url === '/api/v1/analyze') {
        n++;
        if (n === 1) return new Response('<html>Service waking up</html>', { status: 503 });
        if (n === 2) throw new TypeError('fetch failed');
        return json(202, job);
      }
      return json(200, {
        ...job,
        state: 'completed',
        repository: { owner: 'spf13', repo: 'cobra' },
        analyzed_sha: 'adbc8813901bba65827259daa8e22ff94ec1f30e',
        report: fixture,
      });
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(text(doc.getElementById('status'))).toContain('The service is starting up');
    expect(text(doc.getElementById('error'))).toBe('');
    await vi.advanceTimersByTimeAsync(4000);
    expect(text(doc.getElementById('error'))).toBe('');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(n).toBe(3);
    expect(doc.querySelector('[data-field="score"]')?.textContent).toBe('83.5');
    expect(text(doc.getElementById('error'))).toBe('');
    expect((doc.getElementById('analyze') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the waiting message follows the language', async () => {
    const doc = start(async () => new Response('bad gateway', { status: 502 }));
    await vi.advanceTimersByTimeAsync(10);
    (doc.querySelector('[data-lang="vi"]') as HTMLButtonElement).click();
    expect(text(doc.getElementById('status'))).toContain('Dịch vụ đang khởi động');
    (doc.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
    expect(text(doc.getElementById('status'))).toContain('The service is starting up');
  });

  it('our own JSON 503 (queue full, quota) is an answer, not a wake-up: it is shown at once and not retried', async () => {
    let calls = 0;
    const doc = start(async () => {
      calls++;
      return json(503, { error: { code: 'QUEUE_FULL', message: 'x' } });
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    expect(text(doc.getElementById('error'))).toBe(
      'The analysis queue is full. Try again shortly.',
    );
  });

  it('gives up after about a minute with a network message, never an internal error', async () => {
    let calls = 0;
    const doc = start(async () => {
      calls++;
      throw new TypeError('fetch failed');
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(calls).toBe(16); // one try plus fifteen retries
    expect(text(doc.getElementById('error'))).toBe('The network request failed.');
    expect(text(doc.getElementById('error'))).not.toMatch(/internal/i);
  });
});
