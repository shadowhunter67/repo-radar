import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { findings } from '../../web/public/render/findings.js';
describe('browser safety', () => {
  it('renders hostile fixture data as text', () => {
    const r = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
    r.findings[0].title = '<img src=x onerror=alert(1)>';
    r.findings[0].summary = '<script>alert(1)</script>';
    const d = new JSDOM('<!doctype html><body></body>').window.document;
    const n = findings(d, r);
    expect(n.querySelectorAll('img,script,svg')).toHaveLength(0);
    expect(n.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(n.querySelectorAll('[onerror],[onload],[onclick]')).toHaveLength(0);
  });
  it('public source has no unsafe DOM construction APIs', () => {
    const files = [
      'web/public/app.js',
      'web/public/api.js',
      'web/public/validate.js',
      'web/public/render/overview.js',
      'web/public/render/score.js',
      'web/public/render/findings.js',
      'web/public/render/details.js',
    ];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/,
      );
    }
  });
  it('shell uses external script and style resources', () => {
    const html = readFileSync('web/public/index.html', 'utf8');
    expect(html).not.toMatch(/<style(?:\s|>)/i);
    expect(html).toMatch(/<script[^>]+src="\/app\.js"/i);
    expect(html).not.toMatch(/\s+on[a-z]+\s*=/i);
  });
});
