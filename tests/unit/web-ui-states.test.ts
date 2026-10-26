import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { findings } from '../../web/public/render/findings.js';
describe('browser states', () => {
  it('zero findings has exact neutral message', () => {
    const d = new JSDOM('<!doctype html><body></body>').window.document;
    expect(findings(d, { findings: [] }).textContent).toContain(
      'No findings observed within analyzed coverage.',
    );
  });
  it('partial report text is available to the result view', () => {
    const d = new JSDOM('<!doctype html><body></body>').window.document;
    const p = d.createElement('p');
    p.textContent =
      'Analysis completed with partial evidence: one or more sources were unavailable or budgets were reached';
    expect(p.textContent).toContain('partial evidence');
  });
});
