import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A test that asserts nothing real inflates the test count and hides regressions. An earlier automated change added eleven
// `expect(true).toBe(true)` placeholders to a security test file; this guard makes that impossible to merge.
const VACUOUS: [string, RegExp][] = [
  [
    'expect(true).toBe(true)',
    /expect\(\s*true\s*\)\s*\.(toBe|toEqual|toBeTruthy)\(\s*(true)?\s*\)/,
  ],
  [
    'expect(false).toBe(false)',
    /expect\(\s*false\s*\)\s*\.(toBe|toEqual|toBeFalsy)\(\s*(false)?\s*\)/,
  ],
  ['expect(1).toBe(1)', /expect\(\s*(\d+)\s*\)\s*\.toBe\(\s*\1\s*\)/],
  [
    'expect(x).toBe(x) with a literal string',
    /expect\(\s*(['"`])([^'"`]*)\1\s*\)\s*\.toBe\(\s*\1\2\1\s*\)/,
  ],
  [
    'empty test body',
    /\b(it|test)\(\s*(['"`])[^'"`]*\2\s*,\s*(async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
  ],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'fixtures' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe('test-suite hygiene', () => {
  const files = walk(join(process.cwd(), 'tests'));
  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(50);
  });
  it.each(VACUOUS)('no test file contains the vacuous pattern: %s', (_label, re) => {
    const offenders = files
      .filter((f) => !f.endsWith('no-vacuous-tests.test.ts'))
      .filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
