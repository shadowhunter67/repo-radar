import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
describe('browser flow', () => {
  it('does not request on module load when no submit occurs', async () => {
    const dom = new JSDOM(
      '<!doctype html><form id="analyze-form"><input id="repository"><input id="ref"><p id="normalised"></p><button id="analyze"></button><div id="status"></div><div id="error"></div><div id="result"></div></form><button data-example="x/r"></button>',
      { url: 'http://localhost', runScripts: 'outside-only' },
    );
    const fetch = vi.fn();
    (dom.window as unknown as { fetch: typeof fetch }).fetch = fetch;
    expect(fetch).not.toHaveBeenCalled();
  });
});
