import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../web/public/app.js';

function page(url = 'http://localhost/') {
  return new JSDOM(
    '<!doctype html><form id="analyze-form"><input id="repository"><input id="ref"><p id="normalised"></p><button id="analyze" type="submit">Analyze</button></form><div id="status"></div><div id="error"></div><div id="result"></div>',
    { url },
  );
}

describe('browser flow', () => {
  afterEach(() => vi.useRealTimers());

  it('does not request on load and pre-fills query parameters', () => {
    const dom = page('http://localhost/?repo=spf13/cobra&ref=main');
    const fetch = vi.fn();
    init(dom.window.document, { fetch, location: dom.window.location });
    expect(fetch).not.toHaveBeenCalled();
    expect((dom.window.document.getElementById('repository') as HTMLInputElement).value).toBe(
      'spf13/cobra',
    );
    expect((dom.window.document.getElementById('ref') as HTMLInputElement).value).toBe('main');
  });

  it('posts once, polls, shows queue/stage state, and renders a terminal report', async () => {
    vi.useFakeTimers();
    const dom = page();
    const calls: string[] = [];
    const report = {
      schema_version: '0.16',
      subject: { owner: 'spf13', repo: 'cobra' },
      overall: { score: 83.5, grade: 'B+' },
      findings: [],
    };
    const fetch = vi.fn(async (url: string, _options?: RequestInit) => {
      calls.push(url);
      if (url === '/api/v1/analyze')
        return new Response(JSON.stringify({ job_id: 'abcdefghijklmnopqrstuv', state: 'queued' }), {
          status: 202,
        });
      const count = calls.filter((item) => item.startsWith('/api/v1/jobs/')).length;
      const body =
        count === 1
          ? { job_id: 'abcdefghijklmnopqrstuv', state: 'queued', queue_position: 2 }
          : count === 2
            ? { job_id: 'abcdefghijklmnopqrstuv', state: 'running', stage: 'repository_resolved' }
            : { job_id: 'abcdefghijklmnopqrstuv', state: 'completed', report };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const delays: number[] = [];
    const wait = (fn: () => void, ms: number) => {
      delays.push(ms);
      return setTimeout(fn, ms);
    };
    init(dom.window.document, {
      fetch,
      setTimeout: wait,
      AbortController: dom.window.AbortController,
      location: dom.window.location,
    });
    (dom.window.document.getElementById('repository') as HTMLInputElement).value =
      'https://github.com/spf13/cobra';
    const form = dom.window.document.getElementById('analyze-form')!;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(fetch.mock.calls.filter(([url]) => url === '/api/v1/analyze')).toHaveLength(1);
    expect((dom.window.document.getElementById('analyze') as HTMLButtonElement).disabled).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(dom.window.document.getElementById('status')?.textContent).toContain('position 2');
    await vi.advanceTimersByTimeAsync(2000);
    expect(dom.window.document.getElementById('status')?.textContent).toContain(
      'repository resolved',
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(dom.window.document.getElementById('result')?.textContent).toContain('83.5');
    expect((dom.window.document.getElementById('analyze') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(delays).toEqual([1500, 2000, 2500]);
    expect((fetch.mock.calls[0]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ repository: 'spf13/cobra' }),
    );
  });

  it('shows a retry-after rate-limit banner and no result', async () => {
    const dom = page();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
          status: 429,
          headers: { 'retry-after': '17' },
        }),
    );
    init(dom.window.document, {
      fetch,
      setTimeout: vi.fn(),
      AbortController: dom.window.AbortController,
      location: dom.window.location,
    });
    (dom.window.document.getElementById('repository') as HTMLInputElement).value = 'spf13/cobra';
    dom.window.document
      .getElementById('analyze-form')!
      .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await vi.waitFor(() =>
      expect(
        dom.window.document.querySelector('[data-banner="rate-limited"]')?.textContent,
      ).toContain('17'),
    );
    expect(dom.window.document.querySelector('[data-section="overview"]')).toBeNull();
  });
});
