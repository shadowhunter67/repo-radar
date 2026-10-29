/**
 * First-run experience of the CLI: the help a new user sees, concise and actionable usage errors, and no network on a usage error.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const run = async (args: string[]) => {
  let out = '';
  let err = '';
  const code = await main(
    args,
    (s) => (out += s),
    (s) => (err += s),
  );
  return { code, out, err };
};
afterEach(() => vi.unstubAllGlobals());

describe('help', () => {
  it('the first screen explains analyze, --mode, --ref, --format, --history and gives two copy-paste examples', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    for (const needle of [
      'repo-radar analyze <owner/repo',
      '--mode <quick|deep>',
      '--ref <sha|tag|branch>',
      '--format <text|json>',
      '--history',
      'repo-radar analyze sindresorhus/is-plain-obj',
      '--mode deep --format json --output report.json',
      'GITHUB_TOKEN',
      'Exit codes',
    ])
      expect(out).toContain(needle);
    // low-level knobs are not on the first screen
    for (const advanced of [
      '--dep-registry-max',
      '--trust-gpg-key',
      '--no-scorecard',
      '--snapshot-dir',
    ])
      expect(out).not.toContain(advanced);
    expect(out.split('\n').length).toBeLessThan(40);
  });
  it('`analyze --help` lists every analyze option', async () => {
    const { code, out } = await run(['analyze', '--help']);
    expect(code).toBe(0);
    for (const flag of [
      '--dep-registry-max',
      '--trust-gpg-key',
      '--no-scorecard',
      '--snapshot-dir',
      '--mode <quick|deep>',
    ])
      expect(out).toContain(flag);
  });
  it('does not claim Deep scans everything', async () => {
    const { out } = await run(['--help']);
    expect(out).toContain('still bounded');
    expect(out).not.toMatch(/every file|complete audit|guarantee/i);
  });
  it('--version prints the package version', async () => {
    expect((await run(['--version'])).out.trim()).toBe(`repo-radar ${pkg.version}`);
  });
});

describe('usage errors are short, actionable and never touch the network', () => {
  it.each([
    [['analyze'], /needs exactly one repository/],
    [['analyze', 'a/b', 'c/d'], /needs exactly one repository/],
    [['analyze', 'owner/repo', '--mode', 'turbo'], /--mode must be "quick" or "deep"/],
    [['analyze', 'owner/repo', '--format', 'xml'], /--format/],
    [['analyze', 'https://evil.example/a/b'], /./],
    [['analyze', 'not a repo'], /./],
    [['analyze', 'owner/repo', '--ref', 'bad ref with spaces'], /./],
    [['analyze', 'owner/repo', '--ref', '../../x'], /./],
    [['analyze', 'owner/repo', '--no-such-option'], /Unknown option/i],
    [['frobnicate'], /unknown command/],
  ])('%j', async (args, message) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { code, out, err } = await run(args);
    expect(code).toBe(64);
    expect(err).toMatch(message);
    expect(err).toContain('error:');
    expect(err.trim().split('\n').length).toBeLessThanOrEqual(3); // the message and a pointer, not the whole help
    expect(out).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('points to the help instead of dumping it', async () => {
    const { err } = await run(['frobnicate']);
    expect(err).toContain("Run 'repo-radar --help' for usage.");
    expect(err).not.toContain('Options for analyze');
  });
});
