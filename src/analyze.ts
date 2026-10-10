import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFindings } from './analysis/findings.js';
import { analyzeCode, emptyCodeAnalysis, type CodeAnalysis } from './analysis/index.js';
import { DETECTOR_PACK_VERSION } from './analysis/detectors.js';
import { collectGithub, GITHUB_HOSTS } from './collectors/github/collector.js';
import { collectOsv, OSV_HOSTS } from './collectors/osv.js';
import { collectScorecard, SCORECARD_HOSTS } from './collectors/scorecard.js';
import { systemClock, type Clock } from './evidence/builder.js';
import { EvidenceStore } from './evidence/store.js';
import type { Diagnostic, Evidence } from './evidence/types.js';
import { FACTS_VERSION, deriveFacts, factToEvidence } from './facts/index.js';
import { HeuristicClassifier, identityEvidence, loadDefaultTaxonomy } from './identity/index.js';
import type { IdentityClassifier } from './identity/types.js';
import { LIMITS } from './limits.js';
import { loadProfile, validateProfileAgainstRules } from './profiles/load.js';
import { REPORT_SCHEMA_VERSION, type Report } from './report/schema.js';
import { evaluate } from './scoring/engine.js';
import { evaluatePolicy } from './scoring/policy.js';
import { loadRuleSet } from './scoring/rules.js';
import { HttpClient, HttpError, RateLimitError, type FetchLike } from './util/http.js';
import { packageRoot } from './util/paths.js';
import { parseRepoRef } from './util/repo-ref.js';
import { redactSecrets } from './util/text.js';

export interface AnalyzeOptions {
  profile?: string;
  /** GitHub token. Only ever sent to api.github.com. */
  token?: string;
  fetch?: FetchLike;
  clock?: Clock;
  classifier?: IdentityClassifier;
  /** Override the profile's advisory minimums (from --min flags). */
  minimums?: Record<string, number>;
  enforcePolicy?: boolean;
  scorecard?: boolean;
  osv?: boolean;
  /** Static capability / execution / secret scan of fetched files (default on). */
  codeScan?: boolean;
  root?: string;
}

export function toolVersion(root = packageRoot()): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
    .version;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const SCAN_FACT_PREFIXES = ['capability.', 'execution.', 'persistence.', 'secret.', 'scan.'];

export async function analyzeRepository(input: string, opts: AnalyzeOptions = {}): Promise<Report> {
  const root = opts.root ?? packageRoot();
  const clock = opts.clock ?? systemClock;
  const ref = parseRepoRef(input);

  const ruleSet = loadRuleSet(root);
  const profile = loadProfile(opts.profile ?? 'default', root);
  validateProfileAgainstRules(profile, ruleSet.rules);
  const taxonomy = loadDefaultTaxonomy(root);
  const classifier = opts.classifier ?? new HeuristicClassifier(taxonomy);

  const userAgent = `repo-radar/${toolVersion(root)}`;
  const common = { ...(opts.fetch ? { fetch: opts.fetch } : {}), userAgent };
  // The token lives only in the GitHub client and is restricted to api.github.com.
  const gh = new HttpClient({
    ...common,
    allowedHosts: GITHUB_HOSTS,
    authHosts: ['api.github.com'],
    ...(opts.token ? { token: opts.token } : {}),
  });
  const sc = new HttpClient({ ...common, allowedHosts: SCORECARD_HOSTS });
  const osv = new HttpClient({ ...common, allowedHosts: OSV_HOSTS });
  const scanEnabled = opts.codeScan !== false;

  const [github, scorecard] = await Promise.all([
    collectGithub(ref, gh, clock, { scan: scanEnabled }),
    opts.scorecard === false
      ? Promise.resolve({ evidence: [] as Evidence[], diagnostics: [] as Diagnostic[] })
      : collectScorecard(ref, sc, clock),
  ]);
  const osvRes =
    opts.osv === false
      ? { evidence: [] as Evidence[], diagnostics: [] as Diagnostic[] }
      : await collectOsv(github.locked, github.directDependencyCount, osv, clock);

  const identity = await classifier.classify(github.snapshot);
  const idEvidence = identityEvidence(identity, github.snapshot, clock);

  // Static analysis of fetched text. Nothing from the repository is executed.
  const code: CodeAnalysis = github.scanned
    ? analyzeCode({
        manifests: github.snapshot.manifests,
        files: github.files,
        treePaths: github.allTreePaths,
        sourceFilesTotal: github.sourceFileCount,
        fetch: github.fetchStats,
      })
    : emptyCodeAnalysis();
  identity.capabilities = code.capabilities.summary
    .filter((c) => c.observed && c.mode !== 'POSSIBLE')
    .map((c) => c.capability);

  const store = new EvidenceStore();
  const diagnostics: Diagnostic[] = [
    ...github.diagnostics,
    ...scorecard.diagnostics,
    ...osvRes.diagnostics,
  ];
  for (const e of [...github.evidence, ...scorecard.evidence, ...osvRes.evidence, ...idEvidence]) {
    if (store.has(e.id))
      diagnostics.push({
        source: e.source,
        level: 'warn',
        code: 'duplicate_evidence',
        message: `duplicate evidence id ignored: ${e.id}`,
      });
    else store.add(e);
  }
  if (!gh.hasToken) {
    diagnostics.push({
      source: 'github',
      level: 'info',
      code: 'no_token',
      message: 'running unauthenticated (60 API requests/hour); set GITHUB_TOKEN for higher limits',
    });
  }
  if (!scanEnabled) {
    diagnostics.push({
      source: 'analysis',
      level: 'info',
      code: 'code_scan_skipped',
      message:
        'static code scan disabled (--no-scan): capability, execution and secret signals were not evaluated',
    });
  }
  for (const l of code.scan.limits_hit) {
    diagnostics.push({ source: 'analysis', level: 'info', code: 'scan_limit', message: l });
  }
  if (code.scan.performed && code.scan.source_coverage < 0.5 && code.scan.source_files_total > 0) {
    diagnostics.push({
      source: 'analysis',
      level: 'info',
      code: 'scan_partial_coverage',
      message: `only ${Math.round(code.scan.source_coverage * 100)}% of source files were scanned; "not observed" capabilities hold only within the scanned sample`,
    });
  }

  // Normalized facts: rules consume these, not raw collector structures.
  // (Facts that say "nothing found" are withheld when the scan covered too little code; see ABSENCE_MIN_COVERAGE.)
  const facts = deriveFacts({
    store,
    code,
    artifact: { type: identity.artifact_type, confidence: identity.artifact_confidence },
  });
  if (
    code.scan.performed &&
    facts.some((f) => f.id === 'scan.absence_reliable' && f.value === false)
  ) {
    diagnostics.push({
      source: 'analysis',
      level: 'info',
      code: 'scan_absence_withheld',
      message: `scan coverage (${Math.round(code.scan.source_coverage * 100)}% of source files, ${code.scan.source_files_scanned} code file(s)) is below the minimum for "nothing found" results: capability, persistence, chain and secret absence facts were withheld and their rules are unobserved`,
    });
  }
  const scoringStore = new EvidenceStore(store.all());
  for (const f of facts) scoringStore.add(factToEvidence(f, clock));

  const scoring = evaluate(scoringStore, ruleSet.rules, profile, {
    unavailable: diagnostics.flatMap((d) => d.affects ?? []),
    notCollected: [
      ...(opts.scorecard === false ? ['scorecard.'] : []),
      ...(opts.osv === false ? ['osv.'] : []),
      ...(scanEnabled ? [] : SCAN_FACT_PREFIXES),
    ],
    insufficientCoverage:
      scanEnabled && facts.some((f) => f.id === 'scan.absence_reliable' && f.value === false)
        ? ['capability.', 'persistence.', 'secret.', 'execution.chain.']
        : [],
  });
  const cliMin = opts.minimums && Object.keys(opts.minimums).length > 0 ? opts.minimums : undefined;
  const minimums = cliMin ?? profile.minimums;
  const violations = evaluatePolicy(scoring, minimums);

  const report: Omit<Report, 'integrity'> = {
    tool: { name: 'repo-radar', version: toolVersion(root) },
    schema_version: REPORT_SCHEMA_VERSION,
    methodology: {
      version: ruleSet.methodology,
      rules_digest: ruleSet.digest,
      rule_count: ruleSet.rules.length,
      classifier: classifier.id,
      taxonomy_version: taxonomy.version,
      detector_pack_version: DETECTOR_PACK_VERSION,
      facts_version: FACTS_VERSION,
      config_digest: sha256(
        JSON.stringify({
          profile: profile.id,
          profile_version: profile.version,
          scorecard: opts.scorecard !== false,
          osv: opts.osv !== false,
          scan: scanEnabled,
          limits: LIMITS,
        }),
      ),
    },
    profile: { id: profile.id, version: profile.version, title: profile.title },
    generated_at: clock.now().toISOString(),
    subject: {
      owner: ref.owner,
      repo: ref.repo,
      url: github.snapshot.htmlUrl,
      default_branch: github.snapshot.defaultBranch,
      ref: github.snapshot.ref ?? null,
    },
    identity,
    overall: scoring.overall,
    dimensions: scoring.dimensions,
    warnings: scoring.warnings,
    policy: {
      source: cliMin ? 'cli' : Object.keys(profile.minimums).length > 0 ? 'profile' : 'none',
      enforced: !!opts.enforcePolicy || !!cliMin,
      minimums,
      violations,
    },
    diagnostics: diagnostics.map((d) => ({ ...d, message: redactSecrets(d.message) })),
    stats: {
      evidence_count: store.size,
      http_requests: gh.requests + sc.requests + osv.requests,
      authenticated: gh.hasToken,
    },
    evidence: store.all(),
    facts,
    code_analysis: code,
    findings: buildFindings(code),
  };
  return { ...report, integrity: { report_sha256: sha256(JSON.stringify(report)) } };
}

export { HttpError, RateLimitError };
