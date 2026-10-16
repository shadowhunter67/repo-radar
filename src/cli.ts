#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeRepository, toolVersion, type AnalyzeOptions } from './analyze.js';
import { RepoNotFoundError } from './collectors/github/collector.js';
import { buildRepositoryModel, summarizeModel } from './model/index.js';
import { buildTrustGraph, summarizeGraph } from './graph/trust.js';
import { copySnapshots, FsSnapshotStore, type PutResult } from './store/snapshots.js';
import {
  assetsBoundToCommit,
  dependenciesPublishedBy,
  domainsIntroducedAfter,
  GraphIndex,
  publishTimes,
  dependenciesWithUnverifiedProvenance,
  dependenciesWithPublisherChange,
  dependenciesWithNewInstallDomain,
  possibleNameConfusions,
  dependencyArtifactsBoundToSource,
} from './graph/query.js';
import { evaluateHistoryBlocks } from './scoring/policy.js';
import { listProfiles, loadProfile, UnknownProfileError } from './profiles/load.js';
import { compareRevisions, compareSnapshots, renderHistoricalText } from './history/index.js';
import { renderDiffText } from './report/diff.js';
import { REPORT_SCHEMA_VERSION, ReportSchema } from './report/schema.js';
import type { DepRegistryBudget } from './registry/dependency-model.js';
import {
  EMPTY_TRUST,
  gpgKey,
  loadTrustFile,
  mergeTrust,
  minisignKey,
  readKeyFile,
  type TrustConfig,
} from './trust/config.js';
import { loadTrustedRoots } from './trust/github-root.js';
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
  repo-radar diff <owner/repo> --from <ref> [--to <ref>]       Analyze two exact revisions and explain what changed (capabilities, execution, dependencies, risk)
  repo-radar diff <old.json> <new.json> [--format text|json]   Compare two JSON reports (new/removed dependencies, capabilities, hooks, vulnerabilities, ...)
  repo-radar model <report.json> [--format text|json]          Project a 0.4 report onto the unified repository model
  repo-radar graph <report.json> [--format text|json] [--query <q>]  Project a report onto the Software Trust Graph (every edge carries evidence)
  repo-radar graph --snapshot-dir <dir> --repo owner/repo [--commit <sha>] [--query <q>]  Project a STORED snapshot (the graph is regenerated, never stored)
    queries: published-by:<account> | bound-to-commit:<sha> | domains-after:<iso>[,<days>] | without-verified-provenance | publish-times:<account>
  repo-radar snapshots --snapshot-dir <dir> [--repo owner/repo] List stored immutable snapshots
  repo-radar snapshots --snapshot-dir <dir> --export-to <dir2> | --import-from <dir2>   Copy snapshots between stores (hashes verified, nothing overwritten)
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
  --no-deps-dev              Skip deps.dev package metadata (licenses, current-version candidates)
  --no-compliance            Skip regulatory readiness packs and privacy/AI technical indicators
  --snapshot-dir <dir>       Store the report as an immutable snapshot (keyed by repository, commit, schema, methodology, config digest)
  --snapshot-revision        On a conflict with a stored snapshot, keep both: store a content-addressed revision
  --verify-crypto            Cryptographically verify release attestations (Sigstore public-good root; contacts the Sigstore TUF repository)
  --verify-assets            Download up to 3 small release assets (<= 8 MiB each) and compare their bytes with published digests
  --no-registry              Skip npm / PyPI / crates.io lookups (own packages and dependencies)
  --no-dep-registry          Skip registry lookups for DEPENDENCIES only
  --no-domains               Skip extraction of the external hostnames the repository's files refer to
  --inspect-dependency-artifacts  Download and inspect selected dependency artifacts within strict budgets
  --name-intelligence         Compare dependency names against bounded candidates
  --dep-registry-max <n>     Look up at most n dependency packages, highest priority first (default 25)
  --dep-registry-requests <n>  Registry request budget for dependencies (default 60)
  --dep-registry-time <sec>  Time budget for dependency registry lookups (default 45)
  --trust-config <file>      JSON trust file YOU maintain (public keys, expected signer identity); never read from the repository
  --trust-gpg-key <file>     OpenPGP public key to trust for tag and release signatures; repeatable
  --trust-minisign-key <key|file>  minisign public key to trust for .minisig release signatures; repeatable
  --expect-signer <owner/repo>  Sigstore signatures must come from a GitHub workflow of this repository, else they are invalid
  --no-releases              Skip release asset / checksum / signature / provenance metadata
  --no-targeted-tree         Do not walk priority directories when the recursive git tree is truncated or too large
  --no-sbom                  Do not discover or ingest SBOM files in the repository
  --ref <sha|tag|branch>     Read repository files at this revision (reproducible runs; API metadata stays current)
  --no-scan                  Skip the static capability / execution / secret scan of repository files
  --verbose                  Show per-rule detail and all diagnostics
  --ascii                    ASCII-only output

Environment:
  GITHUB_TOKEN               Optional. Raises the GitHub API rate limit. Never logged or stored.

Exit codes:
  0 ok | 1 internal error | 2 policy failed | 3 repository not found | 4 service unavailable / rate limited | 64 usage error
`;

function storeSnapshot(
  dir: string,
  report: import('./report/schema.js').Report,
  revision: boolean,
): PutResult {
  return new FsSnapshotStore(dir).putSnapshot(report, { allowRevision: revision });
}

function useAscii(flag: boolean): boolean {
  if (flag || process.env['NO_UNICODE'] || process.env['TERM'] === 'dumb') return true;
  if (process.platform === 'win32')
    return !(process.env['WT_SESSION'] || process.env['TERM_PROGRAM'] || process.env['ConEmuANSI']);
  return !/utf-?8/i.test(
    `${process.env['LC_ALL'] ?? ''}${process.env['LC_CTYPE'] ?? ''}${process.env['LANG'] ?? ''}`,
  );
}

function positiveInt(v: string | undefined, name: string, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new RepoRefError(`--${name} must be an integer from 1 to ${max}`);
  return n;
}

/** Budget and trust options shared by `analyze` and `diff --from`. Trust comes only from the user's own flags and files. */
function registryAndTrustOptions(values: {
  'no-dep-registry': boolean;
  'dep-registry-max'?: string | undefined;
  'dep-registry-requests'?: string | undefined;
  'dep-registry-time'?: string | undefined;
  'no-dep-attestations': boolean;
  'trusted-root'?: string | undefined;
  'trust-config'?: string | undefined;
  'trust-gpg-key'?: string[] | undefined;
  'trust-minisign-key'?: string[] | undefined;
  'expect-signer'?: string | undefined;
}): Pick<AnalyzeOptions, 'dependencyRegistry' | 'dependencyRegistryBudget' | 'trust'> {
  const budget: Partial<DepRegistryBudget> = {};
  const max = positiveInt(values['dep-registry-max'], 'dep-registry-max', 200);
  const req = positiveInt(values['dep-registry-requests'], 'dep-registry-requests', 1000);
  const sec = positiveInt(values['dep-registry-time'], 'dep-registry-time', 600);
  if (max) budget.maxDependencies = max;
  if (req) budget.maxRequests = req;
  if (sec) budget.maxElapsedMs = sec * 1000;
  if (values['no-dep-attestations']) budget.maxAttestations = 0;
  let trust: TrustConfig = values['trust-config']
    ? loadTrustFile(values['trust-config'])
    : EMPTY_TRUST;
  const extra: TrustConfig = {
    keys: [
      ...(values['trust-gpg-key'] ?? []).map((f) => gpgKey(readKeyFile(f))),
      ...(values['trust-minisign-key'] ?? []).map((k) =>
        minisignKey(existsSync(k) ? readKeyFile(k) : k),
      ),
    ],
    ...(values['trusted-root'] ? { trustedRoots: loadTrustedRoots(values['trusted-root']) } : {}),
    ...(values['expect-signer']
      ? { expectedIdentity: { sourceRepository: values['expect-signer'] } }
      : {}),
  };
  trust = mergeTrust(trust, extra);
  return {
    dependencyRegistry: !values['no-dep-registry'],
    ...(Object.keys(budget).length > 0 ? { dependencyRegistryBudget: budget } : {}),
    ...(trust.keys.length > 0 || trust.expectedIdentity || trust.trustedRoots?.length
      ? { trust }
      : {}),
  };
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
        'no-deps-dev': { type: 'boolean', default: false },
        'no-sbom': { type: 'boolean', default: false },
        'no-compliance': { type: 'boolean', default: false },
        'no-targeted-tree': { type: 'boolean', default: false },
        'no-releases': { type: 'boolean', default: false },
        'no-registry': { type: 'boolean', default: false },
        'no-dep-registry': { type: 'boolean', default: false },
        'no-dep-attestations': { type: 'boolean', default: false },
        'no-domains': { type: 'boolean', default: false },
        'inspect-dependency-artifacts': { type: 'boolean', default: false },
        'name-intelligence': { type: 'boolean', default: false },
        'dep-registry-max': { type: 'string' },
        'dep-registry-requests': { type: 'string' },
        'dep-registry-time': { type: 'string' },
        'trust-config': { type: 'string' },
        'trusted-root': { type: 'string' },
        'trust-gpg-key': { type: 'string', multiple: true },
        'trust-minisign-key': { type: 'string', multiple: true },
        'expect-signer': { type: 'string' },
        'verify-crypto': { type: 'boolean', default: false },
        'snapshot-dir': { type: 'string' },
        'snapshot-revision': { type: 'boolean', default: false },
        repo: { type: 'string' },
        commit: { type: 'string' },
        query: { type: 'string' },
        'export-to': { type: 'string' },
        'import-from': { type: 'string' },
        'verify-assets': { type: 'boolean', default: false },
        'no-scan': { type: 'boolean', default: false },
        ref: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
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
    if (cmd === 'graph') {
      let report: import('./report/schema.js').Report | undefined;
      if (values['snapshot-dir']) {
        if (!values.repo) {
          stderr('error: graph --snapshot-dir needs --repo owner/repo (and optionally --commit)\n');
          return EXIT.USAGE;
        }
        const store = new FsSnapshotStore(values['snapshot-dir']);
        const rows = store.listSnapshots({
          repository: values.repo,
          ...(values.commit ? { commit: values.commit } : {}),
          limit: 100,
        });
        // newest snapshot (by storage time) of the requested repository / commit
        const entry = [...rows].sort((a, b) => (a.stored_at < b.stored_at ? 1 : -1))[0];
        if (!entry) {
          stderr('error: no stored snapshot matches\n');
          return EXIT.NOT_FOUND;
        }
        const got = store.getSnapshot(entry);
        if ('error' in got) {
          stderr(`error: ${sanitizeForTerminal(got.error, 160)}\n`);
          return EXIT.ERROR;
        }
        report = got.report;
      } else {
        if (rest.length !== 1) {
          stderr(
            'error: graph needs exactly one report file (a JSON report of the current schema) or --snapshot-dir\n',
          );
          return EXIT.USAGE;
        }
        if (statSync(rest[0] as string).size > 50 * 1024 * 1024)
          throw new Error('report is larger than 50 MiB');
        const parsedReport = ReportSchema.safeParse(
          JSON.parse(readFileSync(rest[0] as string, 'utf8')),
        );
        if (!parsedReport.success) {
          stderr(
            'error: graph needs a report of the current schema version; re-run the analysis\n',
          );
          return EXIT.USAGE;
        }
        report = parsedReport.data;
      }
      const g = buildTrustGraph(report);
      if (values.query) {
        const idx = new GraphIndex(g);
        const [name, ...restQ] = values.query.split(':');
        const arg = restQ.join(':');
        let rows: unknown;
        if (name === 'published-by' && arg) rows = dependenciesPublishedBy(idx, arg);
        else if (name === 'bound-to-commit' && arg) rows = assetsBoundToCommit(idx, arg);
        else if (name === 'domains-after' && arg) {
          const [iso, days] = arg.split(/,(?=\d+$)/);
          rows = domainsIntroducedAfter(idx, iso as string, days ? Number(days) : undefined);
        } else if (
          name === 'without-verified-provenance' ||
          name === 'dependencies-with-unverified-provenance'
        )
          rows = dependenciesWithUnverifiedProvenance(idx);
        else if (name === 'dependencies-with-publisher-change')
          rows = dependenciesWithPublisherChange(idx);
        else if (name === 'dependencies-with-new-install-domain')
          rows = dependenciesWithNewInstallDomain(idx);
        else if (name === 'possible-name-confusions') rows = possibleNameConfusions(idx);
        else if (name === 'dependency-artifacts-bound-to-source')
          rows = dependencyArtifactsBoundToSource(idx);
        else if (name === 'publish-times' && arg) rows = publishTimes(idx, arg);
        else {
          stderr(
            'error: unknown --query; use published-by:<account> | bound-to-commit:<sha> | domains-after:<iso>[,<days>] | without-verified-provenance | publish-times:<account>\n',
          );
          return EXIT.USAGE;
        }
        stdout(JSON.stringify(rows, null, 2) + '\n');
        return EXIT.OK;
      }
      stdout(values.format === 'json' ? JSON.stringify(g, null, 2) + '\n' : summarizeGraph(g));
      return EXIT.OK;
    }
    if (cmd === 'snapshots') {
      const dir = values['snapshot-dir'];
      if (!dir) {
        stderr('error: snapshots needs --snapshot-dir <dir> (list [--repo owner/repo])\n');
        return EXIT.USAGE;
      }
      const store = new FsSnapshotStore(dir);
      if (values['export-to'] || values['import-from']) {
        const other = new FsSnapshotStore((values['export-to'] ?? values['import-from']) as string);
        const r = values['export-to']
          ? copySnapshots(store, other, { allowRevision: values['snapshot-revision'] })
          : copySnapshots(other, store, { allowRevision: values['snapshot-revision'] });
        stdout(
          `${values['export-to'] ? 'exported' : 'imported'}: ${r.copied} copied, ${r.existing} already present, ${r.conflicts} conflict(s) kept as they were, ${r.unreadable} unreadable\n`,
        );
        return r.conflicts > 0 || r.unreadable > 0 ? EXIT.ERROR : EXIT.OK;
      }
      const rows = store.listSnapshots({
        ...(values.repo ? { repository: values.repo } : {}),
        limit: 100,
      });
      if (values.format === 'json') stdout(JSON.stringify(rows, null, 2) + '\n');
      else {
        stdout(`${rows.length} snapshot(s)\n`);
        for (const e of rows)
          stdout(
            `  ${sanitizeForTerminal(e.repository, 60)} ${e.commit.slice(0, 10)} schema ${e.schema_version} methodology ${e.methodology} config ${e.config_digest.slice(0, 8)} sha256 ${e.report_sha256.slice(0, 12)} stored ${e.stored_at.slice(0, 19)}${e.revision_of ? ' (revision)' : ''}\n`,
          );
      }
      return EXIT.OK;
    }
    if (cmd === 'diff' && (values.from || values.to)) {
      // Revision mode: analyze two exact revisions of one repository (sequentially, sharing unchanged files) and compare.
      if (!values.from || rest.length !== 1) {
        stderr(
          'error: diff <owner/repo> --from <ref> [--to <ref>] needs one repository and a --from revision\n',
        );
        return EXIT.USAGE;
      }
      const tokenR = process.env['GITHUB_TOKEN'] || undefined;
      const cmp = await compareRevisions(
        rest[0] as string,
        values.from,
        values.to ?? null,
        {
          profile: values.profile,
          ...(tokenR ? { token: tokenR } : {}),
          scorecard: !values['no-scorecard'],
          osv: !values['no-osv'],
          depsDev: !values['no-deps-dev'],
          sbom: !values['no-sbom'],
          compliance: !values['no-compliance'],
          targetedTree: !values['no-targeted-tree'],
          releases: !values['no-releases'],
          registry: !values['no-registry'],
          verifyCrypto: values['verify-crypto'],
          verifyAssets: values['verify-assets'],
          codeScan: !values['no-scan'],
          domains: !values['no-domains'],
          inspectDependencyArtifacts: values['inspect-dependency-artifacts'],
          nameIntelligence: values['name-intelligence'],
          ...registryAndTrustOptions(values),
        },
        (a, b) => {
          if (values['snapshot-dir']) {
            for (const r of [a, b]) {
              const res = storeSnapshot(values['snapshot-dir'], r, values['snapshot-revision']);
              stderr(`snapshot ${r.subject.ref?.slice(0, 10) ?? '?'}: ${res.status}\n`);
            }
          }
        },
      );
      const histProfile = loadProfile(values.profile);
      const histViolations = evaluateHistoryBlocks(histProfile.history_block, cmp.diff);
      const histText =
        histViolations.length > 0
          ? `\nHISTORY POLICY (${histProfile.id}${values['enforce-profile'] ? ', enforced' : ', advisory'})\n` +
            histViolations
              .map(
                (v) =>
                  `  BLOCK ${v.id}: ${sanitizeForTerminal(v.description, 120)} [${v.subjects.map((x) => sanitizeForTerminal(x, 40)).join(', ')}]\n`,
              )
              .join('')
          : '';
      stdout(
        values.format === 'json'
          ? JSON.stringify(
              {
                ...cmp,
                history_policy: {
                  profile: histProfile.id,
                  enforced: values['enforce-profile'],
                  violations: histViolations,
                },
              },
              null,
              2,
            ) + '\n'
          : renderHistoricalText(cmp.diff, cmp) + histText,
      );
      return values['enforce-profile'] && histViolations.length > 0 ? EXIT.POLICY : EXIT.OK;
    }
    if (cmd === 'diff' || cmd === 'model') {
      const want = cmd === 'diff' ? 2 : 1;
      if (rest.length !== want) {
        stderr(`error: ${cmd} needs exactly ${want} report file${want > 1 ? 's' : ''}\n`);
        return EXIT.USAGE;
      }
      const readJson = (file: string): unknown => {
        if (statSync(file).size > 50 * 1024 * 1024)
          throw new Error(`${sanitizeForTerminal(file, 80)} is larger than 50 MiB`);
        return JSON.parse(readFileSync(file, 'utf8')) as unknown;
      };
      const fmt = values.format === 'json' ? 'json' : 'text';
      if (cmd === 'diff') {
        const d = compareSnapshots(readJson(rest[0] as string), readJson(rest[1] as string));
        stdout(fmt === 'json' ? JSON.stringify(d, null, 2) + '\n' : renderDiffText(d));
      } else {
        const parsed = ReportSchema.safeParse(readJson(rest[0] as string));
        if (!parsed.success) {
          stderr(
            `error: model needs a report of the current schema version (${REPORT_SCHEMA_VERSION}); re-run the analysis\n`,
          );
          return EXIT.USAGE;
        }
        const m = buildRepositoryModel(parsed.data);
        stdout(fmt === 'json' ? JSON.stringify(m, null, 2) + '\n' : summarizeModel(m));
      }
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
      depsDev: !values['no-deps-dev'],
      sbom: !values['no-sbom'],
      compliance: !values['no-compliance'],
      targetedTree: !values['no-targeted-tree'],
      releases: !values['no-releases'],
      registry: !values['no-registry'],
      verifyCrypto: values['verify-crypto'],
      verifyAssets: values['verify-assets'],
      codeScan: !values['no-scan'],
      domains: !values['no-domains'],
      inspectDependencyArtifacts: values['inspect-dependency-artifacts'],
      nameIntelligence: values['name-intelligence'],
      ...registryAndTrustOptions(values),
      ...(values.ref ? { ref: values.ref } : {}),
    });
    const snap = values['snapshot-dir']
      ? storeSnapshot(values['snapshot-dir'], report, values['snapshot-revision'])
      : undefined;
    if (snap) stderr(`snapshot: ${snap.status} - ${snap.message}\n`);
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
    return report.policy.enforced &&
      (report.policy.violations.length > 0 || report.policy.block_violations.length > 0)
      ? EXIT.POLICY
      : EXIT.OK;
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
