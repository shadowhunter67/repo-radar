/* eslint-disable no-control-regex -- tests deliberately assert on control characters */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT, main } from '../../src/cli.js';
import { ReportSchema } from '../../src/report/schema.js';
import { renderText } from '../../src/report/text.js';
import { analyzeRepository } from '../../src/analyze.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { emptyRepo, goodRepo } from '../helpers/scenarios.js';

async function cli(args: string[], spec: FakeSpec = goodRepo()) {
  vi.stubGlobal('fetch', fakeFetch(spec));
  let out = '';
  let err = '';
  const code = await main(
    args,
    (s) => (out += s),
    (s) => (err += s),
  );
  return { code, out, err };
}

describe('CLI', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved !== undefined) process.env['GITHUB_TOKEN'] = saved;
  });

  it('prints help and version', async () => {
    const h = await cli(['--help']);
    expect(h.code).toBe(EXIT.OK);
    expect(h.out).toMatch(/repo-radar analyze/);
    expect(h.out).toMatch(/Exit codes/);
    const v = await cli(['--version']);
    expect(v.out).toMatch(/^repo-radar \d+\.\d+\.\d+/);
    expect((await cli([])).code).toBe(EXIT.USAGE);
  });

  it('analyze: default text format works without a token', async () => {
    const r = await cli(['analyze', 'acme/widget', '--ascii']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toMatch(/TRUST PROFILE/);
    expect(r.out).toMatch(/Security\s+\d+\s+\S+\s+[#-]{10}\s+conf/);
    expect(r.out).toMatch(/Overall confidence: \d+%/);
    expect(r.out).toMatch(/not a statement that code is safe/);
    expect(r.out).not.toMatch(/[█░]/);
  });

  it('analyze: accepts a GitHub URL and --format json yields a schema-valid report', async () => {
    const r = await cli(['analyze', 'https://github.com/acme/widget', '--format', 'json']);
    expect(r.code).toBe(EXIT.OK);
    const parsed = ReportSchema.safeParse(JSON.parse(r.out));
    expect(parsed.success).toBe(true);
    expect(parsed.data!.subject).toMatchObject({ owner: 'acme', repo: 'widget' });
  });

  it('analyze: --profile enterprise is applied', async () => {
    const r = await cli(['analyze', 'acme/widget', '--format', 'json', '--profile', 'enterprise']);
    expect(JSON.parse(r.out).profile.id).toBe('enterprise');
  });

  it('analyze: --output writes the report to a file and keeps stdout clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-radar-'));
    try {
      const file = join(dir, 'report.json');
      const r = await cli(['analyze', 'acme/widget', '--format', 'json', '--output', file]);
      expect(r.code).toBe(EXIT.OK);
      expect(r.out).toBe('');
      expect(ReportSchema.safeParse(JSON.parse(readFileSync(file, 'utf8'))).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exit code 2 when an explicit --min floor fails; 0 when it passes', async () => {
    expect((await cli(['analyze', 'acme/widget', '--min', 'security=100'])).code).toBe(EXIT.POLICY);
    expect((await cli(['analyze', 'acme/widget', '--min', 'documentation=50'])).code).toBe(EXIT.OK);
  });

  it('advisory profile minimums only fail with --enforce-profile', async () => {
    const weak = emptyRepo();
    expect((await cli(['analyze', 'acme/tmp', '--profile', 'enterprise'], weak)).code).toBe(
      EXIT.OK,
    );
    expect(
      (await cli(['analyze', 'acme/tmp', '--profile', 'enterprise', '--enforce-profile'], weak))
        .code,
    ).toBe(EXIT.POLICY);
  });

  it('usage errors exit 64 without making network calls', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const args of [
      ['analyze'],
      ['analyze', 'a/b', 'c/d'],
      ['analyze', 'not a repo'],
      ['analyze', '../../etc/passwd'],
      ['analyze', 'https://evil.example/a/b'],
      ['analyze', 'acme/widget', '--format', 'xml'],
      ['analyze', 'acme/widget', '--profile', 'nope'],
      ['analyze', 'acme/widget', '--min', 'security=500'],
      ['frobnicate'],
      ['analyze', 'acme/widget', '--unknown-flag'],
    ]) {
      const out: string[] = [];
      const code = await main(
        args,
        (s) => out.push(s),
        (s) => out.push(s),
      );
      expect(code, args.join(' ')).toBe(EXIT.USAGE);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('exit 3 for an unknown repository, 4 for a rate-limited primary call', async () => {
    expect((await cli(['analyze', 'acme/doesnotexist'])).code).toBe(EXIT.NOT_FOUND);
    const r = await cli(
      ['analyze', 'acme/widget'],
      goodRepo({ rateLimited: ['/repos/acme/widget'] }),
    );
    expect(r.code).toBe(EXIT.UNAVAILABLE);
    expect(r.err).toMatch(/rate limit/i);
    expect(r.err).toMatch(/GITHUB_TOKEN/);
  });

  it('profiles and rules subcommands list the standards', async () => {
    const p = await cli(['profiles']);
    expect(p.out).toMatch(/enterprise/);
    const r = await cli(['rules', 'security']);
    expect(r.out).toMatch(/security\.security-policy/);
    expect(r.out).not.toMatch(/maintenance\./);
    expect(r.out).toMatch(/digest [0-9a-f]{12}/);
  });

  it('never prints the token, even on failure paths', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_' + 'q'.repeat(36);
    const r = await cli(
      ['analyze', 'acme/widget', '--verbose', '--format', 'json'],
      goodRepo({ failing: ['/releases'] }),
    );
    expect(r.out + r.err).not.toContain('qqqq');
  });
});

describe('text report', () => {
  it('neutralises terminal escape sequences coming from repository metadata', async () => {
    const spec = goodRepo({
      description: 'evil \u001b]0;pwned\u0007\u001b[2J description for a task queue',
      topics: ['task-queue'],
    });
    spec.files['package.json'] = JSON.stringify({
      name: 'x',
      description: 'also \u001b[31mevil\u001b[0m\u0007',
    });
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(spec),
      clock: fixedClock,
    });
    const text = renderText(report, { verbose: true });
    expect(text).not.toMatch(/[\u001b\u0007]/);
  });

  it('uses cautious wording: no verdict phrases, heuristics are labelled', async () => {
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(emptyRepo({ repo: 'widget' })),
      clock: fixedClock,
    });
    const text = renderText(report, { verbose: true });
    expect(text).not.toMatch(/this repository is (safe|secure|trustworthy)/i);
    expect(text).not.toMatch(/AI[- ]generated/i);
    expect(text).toMatch(/not a statement that code is safe/);
  });

  it('shows insufficient evidence instead of a grade and shows score ranges when wide', async () => {
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(emptyRepo({ repo: 'widget' })),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      codeScan: false,
    });
    const text = renderText(report, { ascii: true });
    expect(text).toMatch(/insufficient evidence/);
    expect(text).toMatch(/Security\s+\S+\s+N\/A/);
  });
});
