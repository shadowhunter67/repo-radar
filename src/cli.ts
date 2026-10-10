#!/usr/bin/env node
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeRepository, toolVersion } from './analyze.js';
import { RepoNotFoundError } from './collectors/github/collector.js';
import { listProfiles, UnknownProfileError } from './profiles/load.js';
import { renderText } from './report/text.js';
import { parseMinimums } from './scoring/policy.js';
import { loadRuleSet } from './scoring/rules.js';
import { HttpError, RateLimitError } from './util/http.js';
import { RepoRefError } from './util/repo-ref.js';
import { redactSecrets, sanitizeForTerminal } from './util/text.js';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  POLICY: 2,
  NOT_FOUND: 3,
  UNAVAILABLE: 4,
  USAGE: 64,
} as const;

const HELP = `repo-radar - transparent, evidence-traceable repository intelligence

Usage:
  repo-radar analyze <owner/repo | https://github.com/owner/repo> [options]
  repo-radar profiles                 List scoring profiles
  repo-radar rules [dimension]        List scoring rules (weights, evidence ids)
  repo-radar --version | --help

Options for analyze:
  --format <text|json>       Output format (default: text)
  --profile <id>             default | startup | enterprise (default: default)
  --output <file>            Write the report to a file instead of stdout
  --text-output <file>       Additionally write the ASCII text report to a file (e.g. a job summary)
  --min <key>=<0-100>        Fail (exit 2) if a dimension or "overall" is below the floor; repeatable
  --enforce-profile          Fail (exit 2) when the profile's advisory minimums are not met
  --no-scorecard             Skip the OpenSSF Scorecard lookup
  --no-osv                   Skip the OSV vulnerability lookup
  --verbose                  Show per-rule detail and all diagnostics
  --ascii                    ASCII-only output

Environment:
  GITHUB_TOKEN               Optional. Raises the GitHub API rate limit. Never logged or stored.

Exit codes:
  0 ok | 1 internal error | 2 policy failed | 3 repository not found | 4 service unavailable / rate limited | 64 usage error
`;

function useAscii(flag: boolean): boolean {
  if (flag || process.env['NO_UNICODE'] || process.env['TERM'] === 'dumb') return true;
  if (process.platform === 'win32')
    return !(process.env['WT_SESSION'] || process.env['TERM_PROGRAM'] || process.env['ConEmuANSI']);
  return !/utf-?8/i.test(
    `${process.env['LC_ALL'] ?? ''}${process.env['LC_CTYPE'] ?? ''}${process.env['LANG'] ?? ''}`,
  );
}

export async function main(
  argv: string[],
  stdout: (s: string) => void = (s) => process.stdout.write(s),
  stderr: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', default: 'text' },
        profile: { type: 'string', default: 'default' },
        output: { type: 'string' },
        'text-output': { type: 'string' },
        min: { type: 'string', multiple: true },
        'enforce-profile': { type: 'boolean', default: false },
        'no-scorecard': { type: 'boolean', default: false },
        'no-osv': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        ascii: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    stderr(`error: ${(e as Error).message}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    stdout(`repo-radar ${toolVersion()}\n`);
    return EXIT.OK;
  }
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    stdout(HELP);
    return cmd || values.help ? EXIT.OK : EXIT.USAGE;
  }

  try {
    if (cmd === 'profiles') {
      for (const p of listProfiles())
        stdout(`${p.id.padEnd(12)} ${p.title}\n  ${p.description.replace(/\s+/g, ' ')}\n`);
      return EXIT.OK;
    }
    if (cmd === 'rules') {
      const rs = loadRuleSet();
      const dim = rest[0];
      for (const r of rs.rules.filter((x) => !dim || x.dimension === dim)) {
        stdout(
          `${r.id.padEnd(46)} w=${String(r.weight).padEnd(3)} ${r.informational ? '[info] ' : ''}${r.evidence.join(', ')}\n`,
        );
      }
      stdout(
        `\n${rs.rules.length} rules, methodology ${rs.methodology}, digest ${rs.digest.slice(0, 12)}\n`,
      );
      return EXIT.OK;
    }
    if (cmd !== 'analyze') {
      stderr(`error: unknown command "${sanitizeForTerminal(cmd, 40)}"\n\n${HELP}`);
      return EXIT.USAGE;
    }
    const target = rest[0];
    if (!target || rest.length > 1) {
      stderr('error: analyze needs exactly one repository (owner/repo or github.com URL)\n');
      return EXIT.USAGE;
    }
    const format = values.format;
    if (format !== 'text' && format !== 'json') {
      stderr('error: --format must be "text" or "json"\n');
      return EXIT.USAGE;
    }
    const minimums = parseMinimums(values.min ?? []);
    const token = process.env['GITHUB_TOKEN'] || undefined;
    const report = await analyzeRepository(target, {
      profile: values.profile,
      ...(token ? { token } : {}),
      minimums,
      enforcePolicy: values['enforce-profile'],
      scorecard: !values['no-scorecard'],
      osv: !values['no-osv'],
    });
    const body =
      format === 'json'
        ? JSON.stringify(report, null, 2) + '\n'
        : renderText(report, { ascii: useAscii(values.ascii), verbose: values.verbose });
    if (values['text-output']) {
      writeFileSync(
        values['text-output'],
        renderText(report, { ascii: true, verbose: values.verbose }),
      );
    }
    if (values.output) {
      writeFileSync(
        values.output,
        format === 'json' ? body : renderText(report, { ascii: true, verbose: values.verbose }),
      );
      stderr(`report written to ${values.output}\n`);
    } else {
      stdout(body);
    }
    return report.policy.enforced && report.policy.violations.length > 0 ? EXIT.POLICY : EXIT.OK;
  } catch (e) {
    return handleError(e, stderr);
  }
}

function handleError(e: unknown, stderr: (s: string) => void): number {
  if (e instanceof RepoRefError || e instanceof UnknownProfileError) {
    stderr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  if (e instanceof RepoNotFoundError) {
    stderr(`error: ${e.message}\n`);
    return EXIT.NOT_FOUND;
  }
  if (e instanceof RateLimitError) {
    const when = e.resetAt ? ` Resets at ${e.resetAt.toISOString()}.` : '';
    stderr(`error: GitHub API rate limit reached.${when} Set GITHUB_TOKEN to raise the limit.\n`);
    return EXIT.UNAVAILABLE;
  }
  if (e instanceof HttpError) {
    stderr(`error: ${e.message}\n`);
    return EXIT.UNAVAILABLE;
  }
  if (e instanceof Error && /^invalid --min/.test(e.message)) {
    stderr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  stderr(`internal error: ${redactSecrets(e instanceof Error ? e.message : String(e))}\n`);
  return EXIT.ERROR;
}

const isMain = ((): boolean => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`internal error: ${redactSecrets(String(e))}\n`);
      process.exitCode = EXIT.ERROR;
    },
  );
}
