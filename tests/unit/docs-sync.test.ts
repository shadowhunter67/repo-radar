import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { CAPABILITIES, PERSISTENCE_KINDS } from '../../src/analysis/types.js';
import { LIMITS } from '../../src/limits.js';
import { REPORT_SCHEMA_VERSION } from '../../src/report/schema.js';
import { packageRoot } from '../../src/util/paths.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { installerRepo } from '../helpers/code-scenarios.js';

const root = packageRoot();
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8');

describe('0.2 documentation matches the code', () => {
  it('every capability and persistence kind is documented in docs/code-analysis.md', () => {
    const doc = read('docs', 'code-analysis.md');
    for (const c of CAPABILITIES) expect(doc, c).toContain(c);
    for (const k of PERSISTENCE_KINDS) expect(doc, k).toContain(k);
  });

  it('every emitted fact family is described in docs/facts.md', async () => {
    const r = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(installerRepo()),
      clock: fixedClock,
    });
    const doc = read('docs', 'facts.md');
    const families = new Set(r.facts.map((f) => f.id.split('.')[0]));
    expect(families.size).toBeGreaterThanOrEqual(6);
    for (const fam of families) expect(doc, fam).toContain(`\`${fam}.`);
  });

  it('documented scan limits equal the limits in src/limits.ts', () => {
    const doc = read('docs', 'code-analysis.md');
    expect(doc).toContain(`${LIMITS.maxScanFiles} files`);
    expect(doc).toContain(`${LIMITS.maxScanFileBytes / 1024} KiB`);
    expect(doc).toContain(`${LIMITS.maxScanTotalBytes / 1024 / 1024} MiB`);
    expect(read('docs', 'security-model.md')).toContain(`${LIMITS.maxGraphNodes} nodes`);
  });

  it('the rule count quoted in the changelog and migration notes is the real one', async () => {
    const r = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(installerRepo()),
      clock: fixedClock,
    });
    expect(read('CHANGELOG.md')).toContain(`-> ${r.methodology.rule_count} rules`);
    expect(read('docs', 'migration.md')).toContain(`${r.methodology.rule_count} rules in total`);
  });

  it('no document claims dynamic analysis, malware detection or legal conclusions', () => {
    for (const f of [
      'README.md',
      'docs/code-analysis.md',
      'docs/facts.md',
      'docs/limitations.md',
    ]) {
      const text = read(...f.split('/'));
      expect(text, f).not.toMatch(
        /\bdetects? malware\b|\bmalware[- ]free\b|\bfully compliant\b|\b100% secure\b/i,
      );
    }
  });
});

describe('hosted CI asserts the current schema version', () => {
  it('.github/workflows/ci.yml checks the schema version the code emits (a bump must not leave the Action matrix red)', () => {
    const ci = readFileSync(join(packageRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain(`r.schema_version === '${REPORT_SCHEMA_VERSION}'`);
  });
});

describe('public preview documentation', () => {
  it('has the required preview wording and links', () => {
    const readme = read('README.md');
    expect(readme).toContain('Experimental');
    expect(readme).toContain('Limitations');
    for (const link of [
      'docs/public-contract.md',
      'docs/security-model.md',
      'docs/limitations.md',
      'docs/maturity.md',
    ])
      expect(readme).toContain(`](${link})`);
  });

  it('does not use forbidden positive claims in public preview documents', () => {
    for (const f of ['README.md', 'docs/release/RELEASE_NOTES_0.17.0-preview.md']) {
      const text = read(...f.split('/'));
      expect(text, f).not.toMatch(/malware-free|\bis safe\b|\b100%\b/i);
    }
    expect(read('SECURITY.md')).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });
});
