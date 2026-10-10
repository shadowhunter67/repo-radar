import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectGithub, GITHUB_HOSTS } from './collectors/github/collector.js';
import { collectOsv, OSV_HOSTS } from './collectors/osv.js';
import { collectScorecard, SCORECARD_HOSTS } from './collectors/scorecard.js';
import { systemClock, type Clock } from './evidence/builder.js';
import { EvidenceStore } from './evidence/store.js';
import type { Diagnostic, Evidence } from './evidence/types.js';
import { HeuristicClassifier, identityEvidence, loadDefaultTaxonomy } from './identity/index.js';
import type { IdentityClassifier } from './identity/types.js';
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
  root?: string;
}

export function toolVersion(root = packageRoot()): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
    .version;
}

export async function analyzeRepository(input: string, opts: AnalyzeOptions = {}): Promise<Report> {
  const root = opts.root ?? packageRoot();
  const clock = opts.clock ?? systemClock;
  const ref = parseRepoRef(input);

  const ruleSet = loadRuleSet(root);
  const profile = loadProfile(opts.profile ?? 'default', root);
  validateProfileAgainstRules(profile, ruleSet.rules);
  const classifier = opts.classifier ?? new HeuristicClassifier(loadDefaultTaxonomy(root));

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

  const [github, scorecard] = await Promise.all([
    collectGithub(ref, gh, clock),
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

  const scoring = evaluate(store, ruleSet.rules, profile, {
    unavailable: diagnostics.flatMap((d) => d.affects ?? []),
    notCollected: [
      ...(opts.scorecard === false ? ['scorecard.'] : []),
      ...(opts.osv === false ? ['osv.'] : []),
    ],
  });
  const cliMin = opts.minimums && Object.keys(opts.minimums).length > 0 ? opts.minimums : undefined;
  const minimums = cliMin ?? profile.minimums;
  const violations = evaluatePolicy(scoring, minimums);

  return {
    tool: { name: 'repo-radar', version: toolVersion(root) },
    schema_version: REPORT_SCHEMA_VERSION,
    methodology: {
      version: ruleSet.methodology,
      rules_digest: ruleSet.digest,
      rule_count: ruleSet.rules.length,
      classifier: classifier.id,
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
  };
}

export { HttpError, RateLimitError };
