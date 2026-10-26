import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { overview } from '../../web/public/render/overview.js';
import { score } from '../../web/public/render/score.js';
import { findings } from '../../web/public/render/findings.js';
import { details } from '../../web/public/render/details.js';
const report = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
describe('browser rendering', () => {
  it('renders exact fixture overview and score', () => {
    const d = new JSDOM('<!doctype html><body></body>').window.document;
    const root = d.createElement('div');
    root.append(overview(d, report), score(d, report));
    expect(root.textContent).toContain('adbc8813901bba65827259daa8e22ff94ec1f30e');
    expect(root.textContent).toContain('83.5 (B+)');
    expect(root.textContent).toContain('0.877');
  });
  it('renders four real findings', () => {
    const d = new JSDOM('<!doctype html><body></body>').window.document;
    const n = findings(d, report);
    expect(n.querySelectorAll('tr')).toHaveLength(5);
    expect(n.textContent).toContain('RR-EXEC-001');
    expect(n.textContent).toContain('RR-PERS-001');
  });
  it('renders technical details', () => {
    const d = new JSDOM('<!doctype html><body></body>').window.document;
    expect(details(d, report).textContent).toContain('103');
  });
});
