/**
 * Behavioural specification of the Web Analyzer result view. These tests were written BEFORE the implementation and use exact
 * values from a real engine report (tests/fixtures/web/report-cobra.json). The implementation lives in
 * web/public/render/result.js: `renderResult(document, job)` returns a DocumentFragment (all behaviour is wired inside it;
 * nothing relies on globals) where `job` is the body of GET /api/v1/jobs/:id.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain browser ES module without type declarations
import { renderResult } from '../../web/public/render/result.js';

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the report is mutated freely in tests
const fixture: Loose = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
const SHA = 'adbc8813901bba65827259daa8e22ff94ec1f30e';
const jobOf = (report: Loose, state = 'completed'): Loose => ({
  job_id: 'AAAAAAAAAAAAAAAAAAAAAA',
  state,
  repository: { owner: 'spf13', repo: 'cobra' },
  analyzed_sha: SHA,
  report,
});
let dom: JSDOM;
let doc: Document;
function mount(job: Loose): HTMLElement {
  dom = new JSDOM('<!doctype html><body><main id="result"></main></body>', {
    pretendToBeVisual: true,
  });
  doc = dom.window.document;
  const host = doc.getElementById('result') as HTMLElement;
  host.append(renderResult(doc, job));
  return host;
}
const q = (host: ParentNode, sel: string) => host.querySelector(sel);
const text = (host: ParentNode, sel: string) => (q(host, sel)?.textContent ?? '').trim();
const clone = (): Loose => JSON.parse(JSON.stringify(fixture));
const key = (el: Element, k: string) =>
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('overview, versions and the three separate measures', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = mount(jobOf(clone()));
  });
  it('shows the repository, a link built only from validated owner/repo, and the full exact SHA', () => {
    expect(text(host, '[data-field="repository"]')).toBe('spf13/cobra');
    expect(q(host, '[data-field="repo-link"]')?.getAttribute('href')).toBe(
      'https://github.com/spf13/cobra',
    );
    expect(q(host, '[data-field="repo-link"]')?.getAttribute('rel')).toContain('noopener');
    expect(text(host, '[data-field="sha"]')).toBe(SHA);
  });
  it('shows tool, schema and methodology versions and the analysis time from the report', () => {
    expect(text(host, '[data-field="tool-version"]')).toBe('0.16.0');
    expect(text(host, '[data-field="schema-version"]')).toBe('0.16');
    expect(text(host, '[data-field="methodology-version"]')).toBe('0.4');
    expect(text(host, '[data-field="generated-at"]')).toContain(
      String(fixture.generated_at).slice(0, 10),
    );
  });
  it('score, confidence and coverage are three distinct sections with their exact values', () => {
    expect(text(host, '[data-section="score"] [data-field="score"]')).toBe('83.5');
    expect(text(host, '[data-section="score"] [data-field="grade"]')).toBe('B+');
    expect(text(host, '[data-section="confidence"] [data-field="confidence"]')).toBe('0.877');
    expect(text(host, '[data-section="coverage"] [data-field="coverage"]')).toBe('100%');
    expect(text(host, '[data-section="coverage"] [data-field="source-coverage"]')).toContain(
      '100%',
    );
    expect(text(host, '[data-section="coverage"] [data-field="source-files"]')).toContain('14');
    expect(
      host.querySelectorAll(
        '[data-section="score"], [data-section="confidence"], [data-section="coverage"]',
      ),
    ).toHaveLength(3);
  });
  it('per-dimension coverage comes from the report (maintenance 0.9 and supply-chain 0.885)', () => {
    expect(text(host, '[data-dimension="maintenance"] [data-field="dimension-coverage"]')).toBe(
      '90%',
    );
    expect(text(host, '[data-dimension="supply-chain"] [data-field="dimension-coverage"]')).toBe(
      '88.5%',
    );
  });
  it('the score card carries the caveat and is never styled as a safe/unsafe colour', () => {
    expect(text(host, '[data-section="score"]')).toContain(
      'A score is an evidence-derived heuristic, not a probability of safety.',
    );
    const cls = q(host, '[data-section="score"] [data-field="score"]')?.className ?? '';
    expect(cls).not.toMatch(/green|red|safe|danger|good|bad/i);
    expect(text(host, '[data-section="coverage"]')).toContain(
      "Findings and 'not observed' statements apply only to analyzed evidence.",
    );
  });
  it('low coverage is stated in words, not only by colour', () => {
    const r = clone();
    r.code_analysis.scan.source_coverage = 0.21164021164021163;
    r.code_analysis.scan.source_files_scanned = 40;
    r.code_analysis.scan.source_files_total = 189;
    r.overall.weight_covered = 0.77;
    const h = mount(jobOf(r));
    expect(text(h, '[data-field="coverage"]')).toBe('77%');
    expect(text(h, '[data-field="source-coverage"]')).toContain('21%');
    expect(text(h, '[data-field="source-files"]')).toContain('40');
    expect(text(h, '[data-field="source-files"]')).toContain('189');
    expect(q(h, '[data-notice="low-source-coverage"]')).not.toBeNull();
  });
});

describe('findings table', () => {
  it('lists exactly the fixture findings with id, severity and category', () => {
    const host = mount(jobOf(clone()));
    const rows = [...host.querySelectorAll('tbody tr[data-finding-id]')];
    expect(rows.map((r) => r.getAttribute('data-finding-id'))).toEqual([
      'RR-EXEC-001',
      'RR-EXEC-002',
      'RR-EXEC-003',
      'RR-PERS-001',
    ]);
    const first = rows[0] as Element;
    expect(first.querySelector('[data-col="severity"]')?.textContent).toBe('medium');
    expect(first.querySelector('[data-col="category"]')?.textContent).toBe('execution');
    expect(first.querySelector('[data-col="title"]')?.textContent).toBe(
      'Download-and-execute chain observed in Makefile',
    );
    expect(first.querySelector('[data-col="evidence-count"]')?.textContent).toBe('1');
    expect(rows[2]?.querySelector('[data-col="evidence-count"]')?.textContent).toBe('2');
    expect(host.querySelector('table caption')?.textContent).toBeTruthy();
    expect(host.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThanOrEqual(5);
  });
  it('the severity and category filters and the text search change the visible rows', () => {
    const r = clone();
    r.findings[3].severity = 'low';
    const host = mount(jobOf(r));
    const visible = () =>
      [...host.querySelectorAll('tbody tr[data-finding-id]')]
        .filter((x) => !x.hasAttribute('hidden'))
        .map((x) => x.getAttribute('data-finding-id'));
    expect(visible()).toHaveLength(4);
    const sev = q(host, 'select[data-filter="severity"]') as HTMLSelectElement;
    sev.value = 'low';
    sev.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(visible()).toEqual(['RR-PERS-001']);
    sev.value = 'all';
    sev.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const cat = q(host, 'select[data-filter="category"]') as HTMLSelectElement;
    cat.value = 'persistence';
    cat.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(visible()).toEqual(['RR-PERS-001']);
    cat.value = 'all';
    cat.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const search = q(host, 'input[data-filter="search"]') as HTMLInputElement;
    search.value = 'rr-exec-002';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(visible()).toEqual(['RR-EXEC-002']);
    expect(text(host, '[data-field="finding-count"]')).toContain('1');
  });
  it('paginates at 50 rows per page', () => {
    const r = clone();
    r.findings = Array.from({ length: 120 }, (_v, i) => ({
      ...fixture.findings[0],
      id: `RR-X-${String(i).padStart(3, '0')}`,
    }));
    const host = mount(jobOf(r));
    const visible = () =>
      [...host.querySelectorAll('tbody tr[data-finding-id]')].filter(
        (x) => !x.hasAttribute('hidden'),
      );
    expect(visible()).toHaveLength(50);
    expect(visible()[0]?.getAttribute('data-finding-id')).toBe('RR-X-000');
    (q(host, '[data-pagination="next"]') as HTMLElement).click();
    expect(visible()).toHaveLength(50);
    expect(visible()[0]?.getAttribute('data-finding-id')).toBe('RR-X-050');
    (q(host, '[data-pagination="next"]') as HTMLElement).click();
    expect(visible()).toHaveLength(20);
    expect(text(host, '[data-pagination="status"]')).toContain('3');
  });
  it('zero findings shows exactly the observed-within-coverage message and no safety claim', () => {
    const r = clone();
    r.findings = [];
    const host = mount(jobOf(r));
    expect(text(host, '[data-empty-findings]')).toBe(
      'No findings observed within analyzed coverage.',
    );
    const all = (host.textContent ?? '').toLowerCase();
    for (const bad of ['no risks', 'is safe', 'looks safe', ' clean', 'secure', 'no issues'])
      expect(all).not.toContain(bad);
  });
});

describe('evidence dialog', () => {
  it('opens on Enter, resolves ids across the report pools, closes on Escape and returns focus to the row', () => {
    const host = mount(jobOf(clone()));
    const row = q(host, 'tr[data-finding-id="RR-EXEC-001"]') as HTMLElement;
    row.focus();
    key(row, 'Enter');
    const dlg = q(host, '[data-evidence-dialog]') as HTMLElement;
    expect(dlg.hasAttribute('hidden')).toBe(false);
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(text(dlg, '[data-field="finding-id"]')).toBe('RR-EXEC-001');
    const item = q(dlg, '[data-evidence-id="CHAIN-001"]') as HTMLElement;
    expect(item).not.toBeNull();
    // CHAIN-001 lives in code_analysis.execution.chains, not in report.evidence
    expect(item.textContent).toContain('Makefile');
    expect(item.textContent).toContain('5');
    expect(item.textContent).toContain('piped directly into a shell/interpreter');
    key(dlg, 'Escape');
    expect(dlg.hasAttribute('hidden')).toBe(true);
    expect(doc.activeElement).toBe(row);
  });
  it('a finding with two evidence ids lists both, resolving a hook and a chain', () => {
    const host = mount(jobOf(clone()));
    (q(host, 'tr[data-finding-id="RR-EXEC-003"]') as HTMLElement).click();
    const dlg = q(host, '[data-evidence-dialog]') as HTMLElement;
    expect(dlg.querySelectorAll('[data-evidence-id]')).toHaveLength(2);
    expect(q(dlg, '[data-evidence-id="HOOK-1"]')?.textContent).toContain('Makefile');
    expect(q(dlg, '[data-evidence-id="CHAIN-001"]')).not.toBeNull();
  });
  it('a capability detection resolves with its file and line', () => {
    const host = mount(jobOf(clone()));
    (q(host, 'tr[data-finding-id="RR-PERS-001"]') as HTMLElement).click();
    const item = q(host, '[data-evidence-dialog] [data-evidence-id="CAP-0007"]') as HTMLElement;
    expect(item.textContent).toContain('completions.go');
    expect(item.textContent).toContain('847');
    expect(text(host, '[data-evidence-dialog]')).toContain(
      'A capability describes what code can do, not intent.',
    );
  });
  it('an evidence id that resolves nowhere is shown as unresolved, never dropped or invented', () => {
    const r = clone();
    r.findings[0].evidence_ids = ['NOPE-999'];
    const host = mount(jobOf(r));
    (q(host, 'tr[data-finding-id="RR-EXEC-001"]') as HTMLElement).click();
    const item = q(host, '[data-evidence-dialog] [data-evidence-id="NOPE-999"]') as HTMLElement;
    expect(item.textContent).toContain('unresolved');
  });
  it('provenance URLs become links only for https and an allowlisted host', () => {
    const r = clone();
    r.findings[0].evidence_ids = [
      'docs.readme.code_block_count',
      'EV-BAD',
      'EV-DATA',
      'EV-HTTP',
      'EV-HOST',
    ];
    r.evidence.push(
      {
        id: 'EV-BAD',
        value: 1,
        source: 'x',
        kind: 'fact',
        confidence: 1,
        provenance: { url: 'javascript:alert(1)' },
      },
      {
        id: 'EV-DATA',
        value: 1,
        source: 'x',
        kind: 'fact',
        confidence: 1,
        provenance: { url: 'data:text/html,<script>1</script>' },
      },
      {
        id: 'EV-HTTP',
        value: 1,
        source: 'x',
        kind: 'fact',
        confidence: 1,
        provenance: { url: 'http://github.com/a/b' },
      },
      {
        id: 'EV-HOST',
        value: 1,
        source: 'x',
        kind: 'fact',
        confidence: 1,
        provenance: { url: 'https://evil.example/x' },
      },
    );
    const host = mount(jobOf(r));
    (q(host, 'tr[data-finding-id="RR-EXEC-001"]') as HTMLElement).click();
    const dlg = q(host, '[data-evidence-dialog]') as HTMLElement;
    const hrefs = [...dlg.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://api.github.com/repos/spf13/cobra/readme']);
    expect(dlg.textContent).toContain('javascript:alert(1)');
    expect(dlg.textContent).toContain('https://evil.example/x');
    for (const a of dlg.querySelectorAll('a'))
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });
});

describe('dependencies, release, capabilities, governance, compliance, technical', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = mount(jobOf(clone()));
  });
  it('dependencies: counts and resolution come from dependency_intel.summary', () => {
    expect(text(host, '[data-section="dependencies"] [data-field="direct-count"]')).toBe('4');
    expect(text(host, '[data-section="dependencies"] [data-field="transitive-count"]')).toBe('0');
    expect(text(host, '[data-section="dependencies"] [data-field="resolved-exact"]')).toBe('4');
    expect(text(host, '[data-section="dependencies"] [data-field="ecosystems"]')).toContain('Go');
    expect(text(host, '[data-section="dependencies"] [data-field="vulnerable-count"]')).toBe('0');
  });
  it('release: lists real releases and never implies verification from presence', () => {
    const sec = q(host, '[data-section="release"]') as HTMLElement;
    expect(sec.querySelectorAll('[data-release-tag]').length).toBeGreaterThanOrEqual(1);
    expect(q(sec, '[data-release-tag="v1.10.2"]')).not.toBeNull();
    const all = (sec.textContent ?? '').toLowerCase();
    expect(all).toContain('not verified');
    expect(all).not.toMatch(/\bverified signature\b|\bsigned and verified\b/);
  });
  it('capabilities: execution hooks and chains are shown without claiming intent', () => {
    const sec = q(host, '[data-section="capabilities"]') as HTMLElement;
    expect(q(sec, '[data-hook-id="HOOK-1"]')?.textContent).toContain('Makefile');
    expect(q(sec, '[data-chain-id="CHAIN-001"]')?.textContent).toContain('pipe-to-shell');
    expect(sec.textContent).toContain('A capability describes what code can do, not intent.');
  });
  it('governance is descriptive and compliance is preceded by the indicative-only banner', () => {
    expect(q(host, '[data-section="governance"]')).not.toBeNull();
    const comp = q(host, '[data-section="compliance"]') as HTMLElement;
    expect(comp.children[1]?.getAttribute('data-banner')).toBe('indicative');
    expect(comp.children[1]?.textContent).toBe(
      'Indicative only. Not legal advice. Not a compliance certification.',
    );
  });
  it('technical details expose the integrity hash, request stats, diagnostics and external-source timestamps', () => {
    const sec = q(host, '[data-section="technical"]') as HTMLElement;
    expect(text(sec, '[data-field="report-sha256"]')).toBe(fixture.integrity.report_sha256);
    expect(text(sec, '[data-field="http-requests"]')).toBe('40');
    expect(text(sec, '[data-field="evidence-count"]')).toBe('103');
    expect(q(sec, '[data-external-source="github"]')?.textContent).toContain('tied to this commit');
    expect(q(sec, '[data-external-source="registry"]')?.textContent).toContain('current state');
    expect(sec.querySelectorAll('[data-diagnostic]')).toHaveLength(fixture.diagnostics.length);
  });
  it('the technical section is collapsed and sections appear in the documented order', () => {
    expect(q(host, '[data-section="technical"]')?.tagName.toLowerCase()).toBe('details');
    const order = [...host.querySelectorAll('[data-section]')].map((s) =>
      s.getAttribute('data-section'),
    );
    const wanted = [
      'overview',
      'score',
      'confidence',
      'coverage',
      'findings',
      'dependencies',
      'release',
      'capabilities',
      'governance',
      'compliance',
      'technical',
    ];
    expect(order.filter((s) => wanted.includes(String(s)))).toEqual(wanted);
  });
});

describe('actions and state banners', () => {
  it('download link, exact CLI command and a copy button that carries only validated values', () => {
    const host = mount(jobOf(clone()));
    expect(q(host, 'a[data-action="download"]')?.getAttribute('href')).toBe(
      '/api/v1/jobs/AAAAAAAAAAAAAAAAAAAAAA/report',
    );
    const copy = q(host, 'button[data-action="copy-cli"]') as HTMLElement;
    expect(copy.getAttribute('data-command')).toBe(
      `node dist/cli.js analyze spf13/cobra --ref ${SHA} --format json`,
    );
    expect(text(host, '[data-field="cli-command"]')).toBe(
      `node dist/cli.js analyze spf13/cobra --ref ${SHA} --format json`,
    );
    expect(text(host, '[data-notice="ephemeral"]')).toBe(
      'Results are kept for a limited time and then discarded.',
    );
  });
  it('a partial job shows the persistent partial banner first', () => {
    const host = mount(jobOf(clone(), 'partial'));
    expect(host.firstElementChild?.getAttribute('data-banner')).toBe('partial');
    expect(text(host, '[data-banner="partial"]')).toBe(
      'Analysis completed with partial evidence: one or more sources were unavailable or budgets were reached.',
    );
    expect(q(mount(jobOf(clone(), 'completed')), '[data-banner="partial"]')).toBeNull();
  });
  it('the analyzed SHA is unavailable (not invented) when the API did not provide one', () => {
    const r = clone();
    r.analysis_manifest.commit = 'not-a-sha';
    const job = jobOf(r);
    job.analyzed_sha = null;
    const host = mount(job);
    expect(text(host, '[data-field="sha"]')).toBe('unavailable');
    expect(q(host, '[data-action="copy-cli"]')?.getAttribute('data-command')).toBe(
      'node dist/cli.js analyze spf13/cobra --format json',
    );
  });
});

describe('untrusted data stays text', () => {
  it('hostile strings in every displayed field create no elements, handlers or links', () => {
    const evil =
      '<img src=x onerror=alert(1)><script>alert(1)</script>"><svg onload=1> javascript:alert(1)';
    const r = clone();
    r.findings[0].title = evil;
    r.findings[0].summary = evil;
    r.findings[0].category = evil;
    r.findings[0].id = 'RR-EVIL-001';
    r.dimensions[0].label = evil;
    r.diagnostics.push({ source: evil, level: 'warn', code: evil, message: evil });
    r.release_intel.releases[0].tag = evil;
    r.release_intel.releases[0].name = evil;
    r.dependency_intel.summary.by_ecosystem = { [evil]: 1 };
    r.code_analysis.execution.chains[0].file = evil;
    const job = jobOf(r);
    job.repository = { owner: 'spf13', repo: 'cobra' };
    const host = mount(job);
    expect(
      host.querySelectorAll('img, script, svg:not(.gauge), iframe, object, embed'),
    ).toHaveLength(0);
    expect(host.querySelectorAll('svg.gauge')).toHaveLength(1); // only the decorative gauge the page draws itself
    expect(host.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]')).toHaveLength(0);
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    for (const a of host.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      expect(
        href.startsWith('https://github.com/spf13/cobra') || href.startsWith('/api/v1/jobs/'),
      ).toBe(true);
    }
  });
  it('the repository shown comes from the validated API fields, not from the report text', () => {
    const r = clone();
    r.subject.owner = '<b>evil</b>';
    r.subject.repo = 'x';
    const host = mount(jobOf(r));
    expect(text(host, '[data-field="repository"]')).toBe('spf13/cobra');
    expect(q(host, '[data-field="repo-link"]')?.getAttribute('href')).toBe(
      'https://github.com/spf13/cobra',
    );
  });
});
