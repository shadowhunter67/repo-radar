import { describe, expect, it, vi } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { EXIT, main } from '../../src/cli.js';
import { parseGitRef, RepoRefError } from '../../src/util/repo-ref.js';
import { fakeFetch, fixedClock, type Recorded } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const SHA = 'a'.repeat(40);

describe('--ref: reading files at a pinned revision', () => {
  it('accepts SHAs, tags and branch names; rejects traversal, whitespace, option-like and odd refs', () => {
    for (const ok of [SHA, 'v1.2.3', 'release/2026-10', 'main', 'feature_x.y'])
      expect(parseGitRef(ok)).toBe(ok);
    for (const bad of [
      '',
      '..',
      'a..b',
      '-rf',
      '--upload-pack=x',
      'a b',
      'a;b',
      'a/',
      'x.lock',
      'a\nb',
      '../../etc',
      'x'.repeat(101),
      '%2e%2e',
    ])
      expect(() => parseGitRef(bad), JSON.stringify(bad)).toThrow(RepoRefError);
  });

  it('tree and commits are requested at the pinned ref and the diagnostic says what is pinned', async () => {
    const rec: Recorded[] = [];
    const spec = goodRepo();
    const r = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(spec, rec),
      clock: fixedClock,
      ref: SHA,
    });
    const tree = rec.find((x) => x.url.includes('/git/trees/'))!;
    expect(tree.url).toContain(`/git/trees/${SHA}?recursive=1`);
    expect(
      rec.filter((x) => x.url.includes('/commits?')).every((x) => x.url.includes(`sha=${SHA}`)),
    ).toBe(true);
    expect(
      r.diagnostics.some((d) => d.code === 'pinned_ref' && d.message.includes('current state')),
    ).toBe(true);
    expect(r.subject.ref).not.toBeNull();
  });

  it('without --ref the default branch is used and there is no pinned_ref diagnostic', async () => {
    const rec: Recorded[] = [];
    const r = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(goodRepo(), rec),
      clock: fixedClock,
    });
    expect(rec.find((x) => x.url.includes('/git/trees/'))!.url).toContain('/git/trees/main?');
    expect(r.diagnostics.some((d) => d.code === 'pinned_ref')).toBe(false);
  });

  it('the pinned ref is recorded in the subject, not in the configuration digest (so two revisions stay comparable)', async () => {
    const a = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
    });
    const b = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
      ref: SHA,
    });
    expect(a.methodology.config_digest).toBe(b.methodology.config_digest);
  });

  it('the CLI rejects an invalid --ref as a usage error before any network call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const err: string[] = [];
    const code = await main(
      ['analyze', 'acme/widget', '--ref=--upload-pack=x'],
      () => undefined,
      (s) => err.push(s),
    );
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT.USAGE);
    expect(f).not.toHaveBeenCalled();
    expect(err.join('')).toMatch(/invalid --ref/);
  });
});
