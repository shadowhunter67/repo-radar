import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { packageRoot } from '../../src/util/paths.js';

const root = packageRoot();
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8');
const action = parse(read('action.yml')) as {
  inputs: Record<string, { default?: string }>;
  outputs: Record<string, unknown>;
  runs: { steps: { id?: string; uses?: string; run?: string; env?: Record<string, string> }[] };
};
const tmp = mkdtempSync(join(tmpdir(), 'rr-release-'));
afterAll(() => {
  for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { force: true });
  rmdirSync(tmp);
});

describe('GitHub Action release packaging', () => {
  it('action.yml runs exactly the bundle that package-action.mjs and the release workflow produce', () => {
    const run = action.runs.steps.find((s) => s.id === 'analyze')!.run!;
    expect(run).toContain('node "$GITHUB_ACTION_PATH/dist/action/repo-radar.mjs"');
    expect(read('scripts', 'package-action.mjs')).toContain('dist/action/repo-radar.mjs');
    expect(read('package.json')).toContain('esbuild src/cli.ts');
    expect(read('package.json')).toContain('--outfile=dist/action/repo-radar.mjs');
  });

  it('dist/ stays git-ignored on main and only the release workflow force-adds the bundle', () => {
    expect(read('.gitignore').split('\n')).toContain('dist');
    const wf = read('.github', 'workflows', 'release-action.yml');
    expect(wf).toContain('git add -f dist/action/repo-radar.mjs dist/action/MANIFEST.json');
    expect(wf).toMatch(/dry_run:[\s\S]*default: true/);
    // The release path is manual only and never runs on push.
    expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(wf).not.toMatch(/^ {2}push:/m);
  });

  it('every third-party action is pinned to a full commit SHA, with minimal permissions', () => {
    for (const f of ['ci.yml', 'release-action.yml']) {
      const wf = read('.github', 'workflows', f);
      for (const m of wf.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
        const ref = m[1] as string;
        if (ref.startsWith('./')) continue;
        expect(ref, `${f}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
      expect(wf, f).toMatch(/^permissions:\n {2}contents: read/m);
    }
    for (const s of action.runs.steps) {
      if (s.uses) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('untrusted inputs reach the shell only through environment variables', () => {
    const analyze = action.runs.steps.find((s) => s.id === 'analyze')!;
    expect(analyze.run).not.toContain('${{');
    for (const s of action.runs.steps.filter((x) => x.run))
      expect(s.run, s.id ?? s.run).not.toContain('${{');
  });

  it('every documented input has a default and every Action output exists', () => {
    for (const [name, def] of Object.entries(action.inputs))
      expect(def.default, name).not.toBeUndefined();
    expect(Object.keys(action.outputs).sort()).toEqual(['exit-code', 'report-path']);
    expect(Object.keys(action.inputs)).toEqual(
      expect.arrayContaining(['artifact-name', 'code-scan', 'minimum-security-score']),
    );
  });

  it('the CI matrix exercises real repositories and a failing policy gate', () => {
    const ci = read('.github', 'workflows', 'ci.yml');
    for (const r of ['pallets/flask', 'sindresorhus/execa', 'nvm-sh/nvm', 'octocat/Hello-World'])
      expect(ci).toContain(r);
    expect(ci).toContain('action-policy-gate');
    expect(ci).toContain('test "$CODE" = "2"');
  });

  it('the bundle builds from source, is one self-contained file, and behaves like the CLI (offline)', () => {
    // Built inside dist/ (git-ignored): like the real Action, the bundle finds standards/ and profiles/ above itself.
    const outDir = join(root, 'dist', 'release-test');
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, 'repo-radar.mjs');
    const res = buildSync({
      entryPoints: [join(root, 'src', 'cli.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: out,
      banner: {
        js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },
      logLevel: 'silent',
    });
    expect(res.errors).toEqual([]);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(100_000);
    const run = (args: string[]) =>
      spawnSync(process.execPath, [out, ...args], { encoding: 'utf8', cwd: tmp });
    const v = run(['--version']);
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/^repo-radar \d+\.\d+\.\d+/);
    expect(v.stdout.trim()).toBe(
      `repo-radar ${(JSON.parse(read('package.json')) as { version: string }).version}`,
    );
    // The smoke test the release workflow performs: usage errors exit 64 without any network access.
    expect(run(['analyze', 'not a repo']).status).toBe(64);
    // standards/ and profiles/ are found relative to the bundle's own location, as in a release checkout.
    expect(run(['profiles']).stdout).toContain('enterprise');
    rmSync(out, { force: true });
    rmdirSync(outDir);
  });
});
