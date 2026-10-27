/**
 * A real screenshot of the first UI showed bare numbers ("0.16.0", "0.16", "0.4", "4 0 4 Go 0", a column of percentages)
 * with no label. A value without a label is unreadable, so every displayed field must have its label as the previous sibling
 * (<dt> before <dd>, or any element) and filters must have real <label>s. Written before the fix.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser ES module without type declarations
import { renderResult } from '../../web/public/render/result.js';

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests mutate arbitrary report fields
const fixture: Loose = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
const job = {
  job_id: 'AAAAAAAAAAAAAAAAAAAAAA',
  state: 'completed',
  repository: { owner: 'spf13', repo: 'cobra' },
  analyzed_sha: 'adbc8813901bba65827259daa8e22ff94ec1f30e',
  report: fixture,
};
const dom = new JSDOM('<!doctype html><body><main id="result"></main></body>');
const doc = dom.window.document;
doc.getElementById('result')?.append(renderResult(doc, job));
const root = doc.getElementById('result') as HTMLElement;
const labelOf = (field: string): string =>
  (root.querySelector(`[data-field="${field}"]`)?.previousElementSibling?.textContent ?? '').trim();

describe('every displayed value has its label immediately before it', () => {
  it.each([
    ['repository', 'Repository'],
    ['sha', 'Analyzed commit (exact SHA)'],
    ['generated-at', 'Analysis time'],
    ['tool-version', 'repo-radar version'],
    ['schema-version', 'Report schema'],
    ['methodology-version', 'Methodology'],
    ['coverage', 'Overall evidence coverage'],
    ['source-coverage', 'Source files scanned (coverage)'],
    ['direct-count', 'Direct dependencies'],
    ['transitive-count', 'Transitive dependencies'],
    ['resolved-exact', 'Resolved to exact versions'],
    ['ecosystems', 'Ecosystems'],
    ['vulnerable-count', 'Dependencies with known advisories'],
    ['http-requests', 'HTTP requests'],
    ['evidence-count', 'Evidence entries'],
    ['report-sha256', 'Report integrity (SHA-256)'],
  ])('%s is labelled "%s"', (field, label) => {
    expect(labelOf(field)).toBe(label);
  });

  it('each dimension coverage row names its dimension and shows its coverage', () => {
    const rows = [...root.querySelectorAll('[data-dimension]')].map((r) => [
      r.getAttribute('data-dimension'),
      (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ]);
    expect(rows.map((r) => r[0])).toEqual([
      'security',
      'maintenance',
      'code-quality',
      'supply-chain',
      'community',
      'documentation',
      'semantic-clarity',
    ]);
    expect(rows.find((r) => r[0] === 'maintenance')?.[1]).toBe('Maintenance 90%');
    expect(rows.find((r) => r[0] === 'supply-chain')?.[1]).toBe('Supply Chain 88.5%');
    expect(rows.find((r) => r[0] === 'semantic-clarity')?.[1]).toBe('Semantic Clarity 88.2%');
  });
});

describe('filters and sections have real labels and content', () => {
  it('filters are labelled with <label for>', () => {
    for (const [selector, text] of [
      ['select[data-filter="severity"]', 'Severity'],
      ['select[data-filter="category"]', 'Category'],
      ['input[data-filter="search"]', 'Search findings'],
    ] as const) {
      const control = root.querySelector(selector) as HTMLElement;
      expect(control.id, selector).toBeTruthy();
      expect(root.querySelector(`label[for="${control.id}"]`)?.textContent?.trim(), selector).toBe(
        text,
      );
    }
  });
  it('the findings count is labelled and shows the number', () => {
    expect(labelOf('finding-count')).toBe('Findings shown');
    expect(root.querySelector('[data-field="finding-count"]')?.textContent?.trim()).toBe('4');
  });
  it('governance shows the takeover statement and the sampled window from the report', () => {
    const g = root.querySelector('[data-section="governance"]') as HTMLElement;
    expect(g.querySelector('h2')?.textContent).toBe('Governance');
    expect(g.textContent).toContain(
      'No dormancy-then-new-actor-then-release sequence observed in the sampled window.',
    );
    expect(g.querySelector('[data-field="governance-commits"]')?.textContent?.trim()).toBe('100');
    expect(
      g
        .querySelector('[data-field="governance-commits"]')
        ?.previousElementSibling?.textContent?.trim(),
    ).toBe('Commits in the sampled window');
  });
  it('the compliance heading comes first and the indicative-only banner immediately follows it, before any content', () => {
    const c = root.querySelector('[data-section="compliance"]') as HTMLElement;
    expect(c.firstElementChild?.tagName.toLowerCase()).toBe('h2');
    expect(c.firstElementChild?.textContent).toBe('Compliance');
    expect(c.children[1]?.getAttribute('data-banner')).toBe('indicative');
  });
  it('every section starts with a heading', () => {
    for (const s of root.querySelectorAll('[data-section]')) {
      const name = s.getAttribute('data-section');
      if (name === 'technical') continue; // a <details> whose <summary> is its heading
      expect(s.querySelector('h2, h3'), String(name)).not.toBeNull();
    }
    expect(root.querySelector('[data-section="technical"] summary')?.textContent).toBe(
      'Technical details',
    );
  });
});
