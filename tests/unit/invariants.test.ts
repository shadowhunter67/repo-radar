import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { packageRoot } from '../../src/util/paths.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo, readmeHeavyRepo } from '../helpers/scenarios.js';

const root = packageRoot();

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const srcFiles = walk(join(root, 'src')).filter((f) => f.endsWith('.ts'));

describe('security invariants of the source tree', () => {
  it('contains no process spawning, dynamic code evaluation or shell access', () => {
    // detectors.ts is declarative data: it contains these words as DETECTION PATTERNS for other
    // people's code. It is checked separately below to prove it has no executable imports.
    for (const f of srcFiles.filter((x) => !x.endsWith('detectors.ts'))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(
        /child_process|\bexecSync\b|\bspawn(Sync)?\(|\beval\(|new Function\(|node:vm|\bworker_threads\b/,
      );
    }
  });
  it('the detector pack is pure data: it imports nothing but types', () => {
    const f = srcFiles.find((x) => x.endsWith('detectors.ts')) as string;
    const imports = [...readFileSync(f, 'utf8').matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports.every((i) => i.startsWith('import type'))).toBe(true);
  });
  it('only the CLI reads environment variables, and only for its own settings', () => {
    for (const f of srcFiles) {
      const text = readFileSync(f, 'utf8');
      if (/process\.env/.test(text)) expect(f.endsWith('cli.ts'), f).toBe(true);
    }
  });
  it('only src/util/http.ts calls fetch', () => {
    for (const f of srcFiles) {
      const calls = readFileSync(f, 'utf8').match(/(?<![.\w])fetch\(/g) ?? [];
      if (!f.endsWith('http.ts')) expect(calls.length, f).toBe(0);
    }
  });
  it('hard-coded hosts in the source are limited to the five allowlisted services (plus github.com links)', () => {
    const allowed = new Set([
      'api.github.com',
      'raw.githubusercontent.com',
      'api.securityscorecards.dev',
      'api.osv.dev',
      'api.deps.dev',
      'deps.dev',
      'github.com',
      'osv.dev',
      'www.apache.org',
      'example.com',
    ]);
    for (const f of srcFiles) {
      for (const m of readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        expect(allowed.has((m[1] as string).toLowerCase()), `${f}: ${m[1]}`).toBe(true);
      }
    }
  });
});

describe('documentation stays in sync with the code', () => {
  it('every emitted evidence id is documented in docs/evidence-schema.md', async () => {
    const doc = readFileSync(join(root, 'docs', 'evidence-schema.md'), 'utf8');
    const ids = new Set<string>();
    for (const spec of [goodRepo(), readmeHeavyRepo(), goodRepo({ releases: [{ daysAgo: 1 }] })]) {
      const r = await analyzeRepository(`${spec.owner}/${spec.repo}`, {
        fetch: fakeFetch(spec),
        clock: fixedClock,
      });
      for (const e of r.evidence) ids.add(e.id);
    }
    const undocumented: string[] = [];
    for (const id of ids) {
      if (id.startsWith('scorecard.check.')) continue;
      const leaf = id.split('.').pop() as string;
      if (!doc.includes(`\`${leaf}\``)) undocumented.push(id);
    }
    expect(undocumented).toEqual([]);
  });

  it('README and docs do not make verdict claims', () => {
    const files = [
      join(root, 'README.md'),
      ...walk(join(root, 'docs')).filter((f) => f.endsWith('.md')),
    ];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(
        /\bthis (repository|code|project) is (safe|secure|trustworthy)\b/i,
      );
      expect(text, f).not.toMatch(/(?<!not )\bdetects? AI[- ]generated (code|repositories)\b/i);
    }
  });

  it('the documented profiles and methodology version match the code', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const p of ['default', 'startup', 'enterprise']) expect(readme).toContain(p);
    const methodology = readFileSync(join(root, 'docs', 'methodology.md'), 'utf8');
    expect(methodology).toMatch(/version 0\.2/);
  });
});
