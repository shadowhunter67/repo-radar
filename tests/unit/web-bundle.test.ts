import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = 'dist/web/public';
const built = existsSync(dir);
const files = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe.skipIf(!built)('built frontend bundle', () => {
  const all = built ? files(dir).filter((f) => /\.(js|html|css|json|svg|txt)$/.test(f)) : [];
  const text = all.map((f) => ({ f, s: readFileSync(f, 'utf8') }));

  it('contains files to check', () => expect(all.length).toBeGreaterThan(5));

  it('contains no credentials, environment access or local paths', () => {
    for (const { f, s } of text) {
      expect(s, f).not.toContain('GITHUB_TOKEN');
      expect(s, f).not.toMatch(/ghp_|github_pat_|gho_[A-Za-z0-9]/);
      expect(s, f).not.toContain('process.env');
      expect(s, f).not.toMatch(/[A-Za-z]:\\Users\\|\/home\/[a-z]|\/Users\/[A-Za-z]/);
    }
  });

  it('references only the documented external hosts (github.com for links)', () => {
    const hosts = new Set<string>();
    for (const { s } of text)
      for (const m of s.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]!.toLowerCase());
    // w3.org appears only as an SVG/XML namespace string, never fetched
    const allowed = new Set(['github.com', 'www.w3.org']);
    expect([...hosts].filter((h) => !allowed.has(h))).toEqual([]);
  });

  it('loads no third-party scripts, styles or fonts', () => {
    for (const { f, s } of text.filter((t) => t.f.endsWith('.html'))) {
      expect(s, f).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/i);
      expect(s, f).not.toMatch(/@import\s+url\(\s*['"]?https?:/i);
    }
    for (const { f, s } of text.filter((t) => t.f.endsWith('.css')))
      expect(s, f).not.toMatch(/url\(\s*['"]?https?:/i);
  });
});
