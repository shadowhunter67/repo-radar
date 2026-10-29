/**
 * Every command shown in the public documentation must be one a user can actually run: known options, valid mode values, and no
 * install command for a registry package that does not exist.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_PARSE_OPTIONS } from '../../src/cli.js';
import { isAnalysisMode } from '../../src/modes.js';

const files = [
  'README.md',
  'docs/getting-started.md',
  'docs/cli.md',
  'docs/deep-scan.md',
  'docs/modes.md',
  'docs/web-analyzer.md',
];
const known = new Set(Object.keys(CLI_PARSE_OPTIONS).map((k) => `--${k}`));
known.add('--help');
known.add('--version');

/** Command lines that invoke the CLI (installed command or source checkout). */
function commands(text: string): string[] {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*[$>]\s*/, '')
        .split(/\s+#\s/)[0]!
        .trim(),
    )
    .filter((l) => /^(repo-radar|node dist\/cli\.js)\s+(analyze|diff|--help|--version)\b/.test(l));
}

describe('documented CLI commands', () => {
  for (const file of files) {
    const cmds = commands(readFileSync(file, 'utf8'));
    it(`${file}: every option exists and every --mode value is valid`, () => {
      for (const cmd of cmds) {
        for (const flag of cmd.match(/--[a-z][a-z-]*/g) ?? [])
          expect(known.has(flag), `${cmd} -> ${flag}`).toBe(true);
        const mode = /--mode\s+(\S+)/.exec(cmd)?.[1];
        if (mode && !mode.startsWith('<')) expect(isAnalysisMode(mode), cmd).toBe(true);
      }
    });
  }
  it('the documentation does contain runnable examples of both modes', () => {
    const all = files.flatMap((f) => commands(readFileSync(f, 'utf8')));
    expect(all.some((c) => /--mode quick/.test(c))).toBe(true);
    expect(all.some((c) => /--mode deep/.test(c))).toBe(true);
  });
});

describe('install instructions', () => {
  const docs = files.map((f) => [f, readFileSync(f, 'utf8')] as const);
  it('never present the unpublished npm package as installable', () => {
    for (const [f, text] of docs) {
      for (const line of text.split('\n')) {
        // a line may say it does not exist ("there is no npm install -g repo-radar"), but must not instruct it
        if (/not (published|on the npm)|no `?npm install|no `?npx|not yet/i.test(line)) continue;
        expect(line, f).not.toMatch(
          /^\s*(\$\s*)?(npx repo-radar|npm (install|i) (-g |--global )?repo-radar(\s|$))/,
        );
      }
    }
  });
  it('the documented release-tarball install uses a real release URL shape', () => {
    const text = readFileSync('docs/getting-started.md', 'utf8');
    expect(text).toMatch(
      /npm install -g https:\/\/github\.com\/shadowhunter67\/repo-radar\/releases\/download\/v\d+\.\d+\.\d+\/repo-radar-\d+\.\d+\.\d+\.tgz/,
    );
  });
});
