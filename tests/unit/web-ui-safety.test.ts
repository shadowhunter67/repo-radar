import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { findings } from '../../web/public/render/findings.js';
describe('browser safety', () => {
  function publicFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? publicFiles(path) : [path];
    });
  }
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
    for (const f of publicFiles('web/public').filter((file) => file.endsWith('.js'))) {
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
