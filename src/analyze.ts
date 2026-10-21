import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFindings } from './analysis/findings.js';
import { analyzeCode, emptyCodeAnalysis, type CodeAnalysis } from './analysis/index.js';
import { DETECTOR_PACK_VERSION } from './analysis/detectors.js';
import { collectGithub, GITHUB_HOSTS } from './collectors/github/collector.js';
import { ATTESTATION_BLOB_HOSTS } from './collectors/github/releases.js';
import {
  DEPSDEV_HOSTS,
  DEPSDEV_LIMITS,
  enrichWithDepsDev,
  type DepsDevResult,
} from './deps/depsdev.js';
import type { AssetVerifyLimits } from './release/verify-assets.js';
import type { BundleVerifier } from './trust/sigstore.js';
import type { TrustConfig } from './trust/config.js';
import { buildTimeline } from './events/build.js';
import { BUILTIN_PATTERNS } from './events/correlate.js';
import { hintKey, PRIORITY_POINTS, type PriorityHints } from './registry/dependency-priority.js';
import { collectDependencyRegistry } from './collectors/dependency-registry.js';
import { collectRegistry, REGISTRY_HOSTS } from './collectors/registry.js';
import { buildRegistryFindings, deriveRegistryFacts } from './registry/findings.js';
import {
  DEP_REGISTRY_BUDGET_DEFAULTS,
  EMPTY_DEP_REGISTRY_INTEL,
  type DepRegistryBudget,
  type DependencyRegistryIntel,
} from './registry/dependency-model.js';
import {
  buildDependencyRegistryFindings,
  deriveDependencyRegistryFacts,
} from './registry/dependency-findings.js';
import { EMPTY_REGISTRY_INTEL, type RegistryIntel } from './registry/model.js';
import { EMPTY_EXTERNAL_DOMAINS, type ExternalDomains } from './domains/model.js';
import { extractDomains } from './domains/extract.js';
import { buildDomainFindings, deriveDomainFacts } from './domains/findings.js';
import { analyzeGovernance } from './governance/temporal.js';
import {
  buildGovernanceFindings,
  buildReleaseFindings,
  deriveReleaseFacts,
} from './release/findings.js';
import { buildDependencyFindings, deriveDependencyFacts } from './deps/findings.js';
import { analyzeDependencies, finalizeIntel } from './deps/intel.js';
import { SBOM_LIMITS } from './deps/sbom.js';
import { collectVulnerabilities, MIN_VULN_COVERAGE, OSV_HOSTS, OSV_LIMITS } from './deps/vulns.js';
import { collectScorecard, SCORECARD_HOSTS } from './collectors/scorecard.js';
import { systemClock, type Clock } from './evidence/builder.js';
import { EvidenceStore } from './evidence/store.js';
import type { Diagnostic, Evidence } from './evidence/types.js';
import {
  buildComplianceContext,
  collectIndicators,
  deriveIndicatorFacts,
  evaluateCompliance,
  loadPacks,
  LEGAL_DISCLAIMER,
  type Regulatory,
} from './compliance/index.js';
import {
  ABSENCE_MIN_COVERAGE,
  ABSENCE_MIN_FILES,
  FACTS_VERSION,
  deriveFacts,
  factToEvidence,
} from './facts/index.js';
import { HeuristicClassifier, identityEvidence, loadDefaultTaxonomy } from './identity/index.js';
import type { IdentityClassifier } from './identity/types.js';
import { classifyIdentityV2 } from './identity/v2.js';
import type { BlobCache } from './collectors/github/blobcache.js';
import { buildCoverageMap } from './report/coverage.js';
import type { RetrievalBudget } from './collectors/github/retrieval.js';
import { LIMITS } from './limits.js';
import { loadProfile, validateProfileAgainstRules } from './profiles/load.js';
import { REPORT_SCHEMA_VERSION, type Report } from './report/schema.js';
import { EMPTY_DEPENDENCY_ARTIFACTS } from './registry/artifacts/model.js';
import { inspectDownloadedArtifacts } from './registry/artifacts/download.js';
import { analyzeNames, EMPTY_NAME_INTELLIGENCE } from './registry/name-model.js';
import { buildNameFindings, deriveNameFacts } from './registry/name-findings.js';
import { EMPTY_BUILD_SOURCES } from './collectors/build-systems/model.js';
import { parseBuildSources } from './collectors/build-systems/parse.js';
import { buildSourceFindings, deriveBuildFacts } from './collectors/build-systems/findings.js';
import { evaluate } from './scoring/engine.js';
import {
  effectiveBlocks,
  evaluateBlocks,
  evaluatePolicy,
  evaluateTemporalBlocks,
} from './scoring/policy.js';
import { loadRuleSet } from './scoring/rules.js';
import { HttpClient, HttpError, RateLimitError, type FetchLike } from './util/http.js';
import { packageRoot } from './util/paths.js';
import { parseGitRef, parseRepoRef } from './util/repo-ref.js';
import { redactSecrets } from './util/text.js';
import { buildDependencyIntroductions, deriveIntroductionFacts } from './deps/introductions.js';
import { collectDependencyHistory, type DependencyHistoryBudget } from './history/dependency.js';

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
  /** Query deps.dev for package metadata (default true). Network failures never mark a dependency safe. */
  depsDev?: boolean;
  /** Discover and ingest SBOM files (default true). */
  sbom?: boolean;
  /** Evaluate regulatory readiness packs and privacy/AI technical indicators (default true). */
  compliance?: boolean;
  /** Static capability / execution / secret scan of fetched files (default on). */
  codeScan?: boolean;
  /** Read repository files at this commit/ref instead of the default branch head (reproducible runs). */
  ref?: string;
  /** Reuse unchanged files across revisions analyzed in one run (see src/history). */
  blobCache?: BlobCache;
  /** Verify attestation bundles with the Sigstore public-good trust root (opt-in; contacts the Sigstore TUF repository). */
  verifyCrypto?: boolean;
  /** Alternative verifier (tests, other trust material). */
  verifier?: BundleVerifier;
  /** Download up to a few small release assets and compare their bytes with published digests (opt-in). */
  verifyAssets?: boolean;
  assetLimits?: Partial<AssetVerifyLimits>;
  /** Public keys and signer identity YOU trust (never read from the analyzed repository). Enables OpenPGP / minisign / identity checks. */
  trust?: TrustConfig;
  /** Look up the packages this repository publishes in their registries (default true). */
  registry?: boolean;
  /** Extract the external hostnames the repository's files refer to (default true; needs the code scan). */
  domains?: boolean;
  /** Look up the registries of the repository's dependencies, under a budget (default true; needs `registry`). */
  dependencyRegistry?: boolean;
  inspectDependencyArtifacts?: boolean;
  nameIntelligence?: boolean;
  /** Override the dependency-registry budget (packages, requests, time, versions, bytes). */
  dependencyRegistryBudget?: Partial<DepRegistryBudget>;
  /** Collect release/provenance metadata (default true). */
  releases?: boolean;
  /** Walk priority directories when the recursive tree is truncated or too large (default true). */
  targetedTree?: boolean;
  /** Override the targeted-retrieval budget (requests, nodes, bytes, time, depth). */
  retrievalBudget?: RetrievalBudget;
  /** Bounded, opt-in history lookup for dependency introductions. */
  dependencyHistory?: { enabled?: boolean; budget?: Partial<DependencyHistoryBudget> };
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
  const depsDevHttp = new HttpClient({ ...common, allowedHosts: DEPSDEV_HOSTS });
  const scanEnabled = opts.codeScan !== false;

  const [github, scorecard] = await Promise.all([
    collectGithub(ref, gh, clock, {
      scan: scanEnabled,
      sbom: opts.sbom !== false,
      ...(opts.blobCache ? { blobCache: opts.blobCache } : {}),
      ...(opts.targetedTree === false ? { targetedTree: false } : {}),
      ...(opts.releases === false ? { releases: false } : {}),
      ...(opts.verifyCrypto ? { verifyCrypto: true } : {}),
      ...(opts.verifier ? { verifier: opts.verifier } : {}),
      ...(opts.verifyAssets ? { verifyAssets: true } : {}),
      ...(opts.assetLimits ? { assetLimits: opts.assetLimits } : {}),
      ...(opts.trust ? { trust: opts.trust } : {}),
      blobHttp: new HttpClient({ ...common, allowedHosts: ATTESTATION_BLOB_HOSTS }),
      ...(opts.retrievalBudget ? { retrievalBudget: opts.retrievalBudget } : {}),
      ...(opts.ref ? { ref: parseGitRef(opts.ref) } : {}),
    }),
    opts.scorecard === false
      ? Promise.resolve({ evidence: [] as Evidence[], diagnostics: [] as Diagnostic[] })
      : collectScorecard(ref, sc, clock),
  ]);
  // Dependency intelligence: offline resolution first, then optional network enrichment. Network failures only ever
  // reduce coverage; they never turn an unchecked dependency into a safe one.
  // Registry intelligence for the packages THIS repository publishes (npm, PyPI, crates.io). Failures are diagnostics.
  const registryDiag: Diagnostic[] = [];
  const registryHttp = new HttpClient({ ...common, allowedHosts: REGISTRY_HOSTS });
  const registryIntel: RegistryIntel =
    opts.registry === false
      ? EMPTY_REGISTRY_INTEL
      : await collectRegistry({
          http: registryHttp,
          manifests: github.snapshot.manifests,
          analyzed: { owner: ref.owner, repo: ref.repo },
          clock,
          note: (code, message) =>
            registryDiag.push({ source: 'registry', level: 'warn', code, message }),
        });
  const depsStatic = analyzeDependencies({
    manifests: github.snapshot.manifests,
    locks: github.depInputs.locks,
    sboms: github.depInputs.sboms,
  });
  const osvRes = await collectVulnerabilities(
    depsStatic.deps,
    opts.osv === false ? undefined : osv,
    clock,
  );
  const depsDev: DepsDevResult | undefined =
    opts.depsDev === false
      ? undefined
      : await enrichWithDepsDev(depsStatic.deps, depsDevHttp, clock);
  const intel = finalizeIntel(depsStatic, osvRes, depsDev, {
    osvEnabled: opts.osv !== false,
    depsDevEnabled: opts.depsDev !== false,
  });
  const depRegistryDiag: Diagnostic[] = [];
  // Dependencies involved in a medium or high dependency finding are looked up first (see src/registry/dependency-priority.ts).
  const priorityHints: PriorityHints = new Map();
  {
    const byId = new Map(depsStatic.deps.map((d) => [d.id, d]));
    for (const f of buildDependencyFindings(intel))
      if (f.severity === 'medium' || f.severity === 'high')
        for (const eid of f.evidence_ids) {
          const d = byId.get(eid);
          if (!d) continue;
          const k = hintKey(d.package.ecosystem, d.package.name);
          const list = priorityHints.get(k) ?? [];
          if (!list.some((h) => h.reason === 'involved in a finding'))
            list.push({
              points: PRIORITY_POINTS.involvedInFinding,
              reason: 'involved in a finding',
            });
          priorityHints.set(k, list);
        }
  }
  const depRegistry: DependencyRegistryIntel =
    opts.registry === false || opts.dependencyRegistry === false
      ? EMPTY_DEP_REGISTRY_INTEL
      : await collectDependencyRegistry({
          http: registryHttp,
          dependencies: depsStatic.deps,
          clock,
          hints: priorityHints,
          trust: opts.trust,
          verifyCrypto: opts.verifyCrypto,
          ...(opts.dependencyRegistryBudget ? { budget: opts.dependencyRegistryBudget } : {}),
          note: (code, message) =>
            depRegistryDiag.push({ source: 'registry', level: 'warn', code, message }),
        });
  const dependencyHistory =
    opts.dependencyHistory?.enabled && github.snapshot.ref
      ? await collectDependencyHistory({
          http: gh,
          owner: ref.owner,
          repo: ref.repo,
          ref: github.snapshot.ref,
          dependencies: depsStatic.deps,
          manifests: github.snapshot.manifests,
          locks: github.depInputs.locks,
          ...(opts.blobCache ? { blobCache: opts.blobCache } : {}),
          ...(opts.dependencyHistory.budget ? { budget: opts.dependencyHistory.budget } : {}),
        })
      : undefined;
  const dependencyIntroductions = buildDependencyIntroductions(
    depsStatic.deps,
    depsStatic.locks,
    depRegistry,
    clock.now().toISOString(),
    dependencyHistory,
  );
  const dependencyArtifacts = opts.inspectDependencyArtifacts
    ? await inspectDownloadedArtifacts({
        http: registryHttp,
        candidates: depRegistry.packages.flatMap((p) =>
          p.versions.slice(0, 2).map((v) => ({
            registry: p.registry,
            package: p.name,
            version: v.version,
            url: v.artifact_url ?? null,
            digest: v.artifact_digest ?? null,
          })),
        ),
      })
    : EMPTY_DEPENDENCY_ARTIFACTS;
  const nameIntelligence = opts.nameIntelligence
    ? analyzeNames(
        depsStatic.deps.slice(0, 25).map((d) => ({
          name: d.package.name,
          ecosystem:
            d.package.ecosystem === 'PyPI'
              ? 'pypi'
              : d.package.ecosystem === 'crates.io'
                ? 'crates.io'
                : 'npm',
          evidence: d.id,
        })),
        depsStatic.deps.slice(0, 25).map((d) => ({
          name: d.package.name,
          ecosystem:
            d.package.ecosystem === 'PyPI'
              ? 'pypi'
              : d.package.ecosystem === 'crates.io'
                ? 'crates.io'
                : 'npm',
        })),
      )
    : EMPTY_NAME_INTELLIGENCE;
  const buildSources = github.scanned
    ? parseBuildSources(
        github.files
          .filter((f) =>
            /(?:MODULE\.bazel|WORKSPACE(?:\.bazel)?|BUILD(?:\.bazel)?|flake\.lock|flake\.nix|default\.nix|shell\.nix|BUCK2?|\.buckconfig)$/i.test(
              f.path,
            ),
          )
          .map((f) => ({ path: f.path, content: f.content })),
      )
    : EMPTY_BUILD_SOURCES;

  const identity = await classifier.classify(github.snapshot);
  identity.confidence_semantics ??= 'heuristic_uncalibrated';
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
  const externalDomains: ExternalDomains =
    opts.domains === false
      ? EMPTY_EXTERNAL_DOMAINS
      : github.scanned
        ? extractDomains({
            files: github.files,
            hooks: code.execution.hooks,
            detections: code.capabilities.detections,
          })
        : { ...EMPTY_EXTERNAL_DOMAINS, status: 'not_scanned' };
  const coverageMap = buildCoverageMap({
    retrieval: github.treeRetrieval,
    sourceScanRatio:
      code.scan.performed && code.scan.source_files_total > 0 ? code.scan.source_coverage : null,
    scanned: code.scan.performed,
    releasesRead: github.evidence.some((e) => e.id === 'github.releases.has_any'),
    workflowsSeen: github.evidence.some((e) => e.id === 'github.workflows.count' && e.value !== 0),
  });
  const identityV2 = classifyIdentityV2({
    snapshot: github.snapshot,
    legacy: identity,
    observedCapabilities: identity.capabilities,
    entrypointCount: code.execution.entrypoints.length,
    files: github.files,
  });

  const store = new EvidenceStore();
  const diagnostics: Diagnostic[] = [
    ...github.diagnostics,
    ...scorecard.diagnostics,
    ...osvRes.diagnostics,
    ...depsStatic.diagnostics,
    ...(depsDev?.diagnostics ?? []),
    ...registryDiag,
    ...depRegistryDiag,
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
  const scanReliable =
    code.scan.performed &&
    code.scan.source_coverage >= ABSENCE_MIN_COVERAGE &&
    code.scan.source_files_scanned >= ABSENCE_MIN_FILES;
  const complianceOn = opts.compliance !== false;
  const packs = complianceOn ? loadPacks(root, ruleSet.methodology) : [];
  const indicators = complianceOn
    ? collectIndicators({
        files: github.files,
        treePaths: github.allTreePaths,
        allDependencies: depsStatic.deps,
      })
    : [];
  const governance = analyzeGovernance(github.governanceInput);
  const timeline = buildTimeline({
    governance,
    registry: registryIntel,
    dependencyRegistry: depRegistry,
    releases: github.releaseIntel,
    patterns: BUILTIN_PATTERNS,
  });
  const facts = [
    ...(complianceOn ? deriveIndicatorFacts(indicators, scanReliable, code) : []),
    ...deriveFacts({
      store,
      code,
      artifact: { type: identity.artifact_type, confidence: identity.artifact_confidence },
    }),
    ...deriveDependencyFacts(intel, opts.sbom !== false),
    ...deriveReleaseFacts(github.releaseIntel, governance),
    ...deriveRegistryFacts(registryIntel),
    ...deriveDependencyRegistryFacts(depRegistry, timeline.correlations),
    ...deriveIntroductionFacts(dependencyIntroductions),
    ...deriveNameFacts(nameIntelligence),
    ...deriveBuildFacts(buildSources),
    ...(dependencyArtifacts.status === 'analyzed' &&
    dependencyArtifacts.artifacts.some((a) => a.domains.length > 0)
      ? [
          {
            id: 'registry.deps.install_domain_present',
            value: true,
            confidence: 0.75,
            scope: 'registry' as const,
            derived_from: dependencyArtifacts.artifacts.flatMap((a) => a.evidence),
            derived_by: 'dependency-artifacts@0.1',
          },
        ]
      : dependencyArtifacts.status === 'analyzed' &&
          dependencyArtifacts.inspected === dependencyArtifacts.eligible
        ? [
            {
              id: 'registry.deps.install_domain_present',
              value: false,
              confidence: 0.7,
              scope: 'registry' as const,
              derived_from: [],
              derived_by: 'dependency-artifacts@0.1',
            },
          ]
        : []),
    ...(dependencyArtifacts.status === 'analyzed'
      ? [
          {
            id: 'registry.deps.artifacts_inspected',
            value: dependencyArtifacts.inspected === dependencyArtifacts.eligible,
            confidence: 0.9,
            scope: 'registry' as const,
            derived_from: dependencyArtifacts.artifacts.flatMap((a) => a.evidence),
            derived_by: 'dependency-artifacts@0.1',
          },
        ]
      : []),
    ...deriveDomainFacts(externalDomains, scanReliable),
  ];
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

  // Regulatory readiness (technical indicators only; never a legal determination).
  const regulatory: Regulatory = complianceOn
    ? evaluateCompliance(
        {
          packs,
          identity: {
            artifact_type: identity.artifact_type,
            artifact_confidence: identity.artifact_confidence,
            domain: identity.domain,
            ecosystem: identity.ecosystem,
          },
          code,
          intel,
          allDependencies: depsStatic.deps,
          manifests: github.snapshot.manifests,
          files: github.files,
          treePaths: github.allTreePaths,
          scanReliable,
        },
        indicators,
        scoringStore,
      )
    : { engine_version: '0.1', disclaimer: LEGAL_DISCLAIMER, packs: [], indicators: [] };

  const scoring = evaluate(scoringStore, ruleSet.rules, profile, {
    unavailable: diagnostics.flatMap((d) => d.affects ?? []),
    notCollected: [
      ...(opts.scorecard === false ? ['scorecard.'] : []),
      ...(opts.osv === false ? ['osv.'] : []),
      ...(scanEnabled ? [] : SCAN_FACT_PREFIXES),
    ],
    insufficientCoverage: [
      ...(osvRes.ratioWithheld ? ['osv.vulnerable_ratio'] : []),
      ...(scanEnabled && facts.some((f) => f.id === 'scan.absence_reliable' && f.value === false)
        ? ['capability.', 'persistence.', 'secret.', 'execution.chain.']
        : []),
    ],
  });
  const cliMin = opts.minimums && Object.keys(opts.minimums).length > 0 ? opts.minimums : undefined;
  const minimums = cliMin ?? profile.minimums;
  const violations = evaluatePolicy(scoring, minimums);
  const findings = [
    ...buildFindings(code),
    ...buildDependencyFindings(intel),
    ...buildReleaseFindings(github.releaseIntel),
    ...buildRegistryFindings(registryIntel),
    ...buildDependencyRegistryFindings(depRegistry, timeline.correlations),
    ...buildNameFindings(nameIntelligence),
    ...buildSourceFindings(buildSources),
    ...buildDomainFindings(externalDomains),
    ...buildGovernanceFindings(governance),
  ];
  const blockViolations = [
    ...evaluateTemporalBlocks(profile.temporal_block, timeline),
    ...evaluateBlocks(
      effectiveBlocks(profile),
      buildComplianceContext(
        {
          packs: [],
          identity: {
            artifact_type: identity.artifact_type,
            artifact_confidence: identity.artifact_confidence,
            domain: identity.domain,
            ecosystem: identity.ecosystem,
          },
          code,
          intel,
          allDependencies: depsStatic.deps,
          manifests: github.snapshot.manifests,
          files: github.files,
          treePaths: github.allTreePaths,
          scanReliable,
        },
        indicators,
        scoringStore,
        findings.map((f) => ({
          id: f.id,
          category: f.category,
          severity: f.severity,
          rule_ids: f.rule_ids,
        })),
      ),
    ),
  ];

  const report: Omit<Report, 'integrity'> = {
    tool: { name: 'repo-radar', version: toolVersion(root) },
    schema_version: REPORT_SCHEMA_VERSION,
    analysis_manifest: {
      repository: `${ref.owner}/${ref.repo}`,
      commit: github.snapshot.ref ?? null,
      revision_kind: opts.ref && /^[0-9a-f]{40}$/i.test(opts.ref) ? 'immutable' : 'moving',
      tool_version: toolVersion(root),
      schema_version: REPORT_SCHEMA_VERSION,
      feature_flags: {
        verify_crypto: opts.verifyCrypto === true,
        verify_assets: opts.verifyAssets === true,
        compliance: complianceOn,
        dependency_registry: opts.dependencyRegistry !== false && opts.registry !== false,
        dependency_artifacts: opts.inspectDependencyArtifacts === true,
        dependency_attestations:
          opts.dependencyRegistry !== false &&
          opts.registry !== false &&
          opts.dependencyRegistryBudget?.maxAttestations !== 0,
        name_intelligence: opts.nameIntelligence === true,
        registry: opts.registry !== false,
        scorecard: opts.scorecard !== false,
        osv: opts.osv !== false,
        deps_dev: opts.depsDev !== false,
        sbom: opts.sbom !== false,
        domains: opts.domains !== false,
        releases: opts.releases !== false,
        code_scan: opts.codeScan !== false,
        trusted_root_identity: !!opts.trust?.expectedIdentity,
        dependency_history: opts.dependencyHistory?.enabled === true,
      },
      collector_versions: {
        github: '0.9',
        registry: '0.7',
        dependency_registry: '0.7',
        ...(opts.dependencyHistory?.enabled ? { dependency_history: '0.1' } : {}),
      },
      external_sources: [
        {
          source: 'github',
          classification: 'revision_bound',
          retrieved_at: clock.now().toISOString(),
        },
        {
          source: 'registry',
          classification: 'current_state',
          retrieved_at: clock.now().toISOString(),
        },
      ],
      trust_roots: opts.trust?.trustedRoots?.map((r) => r.label) ?? [],
      budgets: {
        max_scan_bytes: LIMITS.maxScanTotalBytes,
        max_artifacts: LIMITS.maxArtifactsPerRun,
        ...(opts.dependencyHistory?.enabled
          ? {
              dependency_history_candidates:
                opts.dependencyHistory.budget?.maxCandidates ??
                LIMITS.maxDependencyHistoryCandidates,
              dependency_history_commits:
                opts.dependencyHistory.budget?.maxCommits ?? LIMITS.maxDependencyHistoryCommits,
              dependency_history_requests:
                opts.dependencyHistory.budget?.maxRequests ?? LIMITS.maxDependencyHistoryRequests,
            }
          : {}),
      },
      coverage: {
        evidence: store.size,
        files: github.files.length,
        ...(dependencyHistory
          ? {
              dependency_history_candidates: dependencyHistory.coverage.candidates,
              dependency_history_analyzed: dependencyHistory.coverage.analyzed,
              dependency_history_resolved: dependencyHistory.coverage.resolved,
              dependency_history_uncertain: dependencyHistory.coverage.uncertain,
              dependency_history_skipped: dependencyHistory.coverage.skipped_by_budget,
            }
          : {}),
      },
    },
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
          deps_dev: opts.depsDev !== false,
          sbom: opts.sbom !== false,
          compliance: complianceOn
            ? packs.map((p) => `${p.pack.pack}@${p.pack.version}:${p.digest.slice(0, 12)}`)
            : false,
          dependency_history: opts.dependencyHistory?.enabled === true,
          dependency_history_budget: opts.dependencyHistory?.budget ?? null,
          deps_limits: {
            osv: OSV_LIMITS,
            deps_dev: DEPSDEV_LIMITS,
            sbom: SBOM_LIMITS,
            min_vuln_coverage: MIN_VULN_COVERAGE,
          },
          scan: scanEnabled,
          targeted_tree: opts.targetedTree !== false,
          releases: opts.releases !== false,
          registry: opts.registry !== false,
          dependency_registry:
            opts.registry !== false && opts.dependencyRegistry !== false
              ? { ...DEP_REGISTRY_BUDGET_DEFAULTS, ...opts.dependencyRegistryBudget }
              : false,
          verify_crypto: opts.verifyCrypto === true,
          verify_assets: opts.verifyAssets === true,
          inspect_dependency_artifacts: opts.inspectDependencyArtifacts === true,
          name_intelligence: opts.nameIntelligence === true,
          dependency_attestations:
            opts.dependencyRegistry !== false &&
            opts.registry !== false &&
            opts.dependencyRegistryBudget?.maxAttestations !== 0,
          domains: opts.domains !== false,
          trusted_keys: opts.trust?.keys.length ?? 0,
          expected_identity: !!opts.trust?.expectedIdentity,
          trusted_root_identity: opts.trust?.trustedRoots?.map((r) => r.label).sort() ?? [],
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
      revision_kind: opts.ref && /^[0-9a-f]{40}$/i.test(opts.ref) ? 'immutable' : 'moving',
    },
    identity,
    identity_v2: identityV2,
    retrieval: github.treeRetrieval,
    release_intel: github.releaseIntel,
    registry_intel: registryIntel,
    dependency_registry_intel: depRegistry,
    dependency_artifacts: dependencyArtifacts,
    name_intelligence: nameIntelligence,
    build_sources: buildSources,
    external_domains: externalDomains,
    timeline,
    governance,
    coverage_map: coverageMap,
    overall: scoring.overall,
    dimensions: scoring.dimensions,
    warnings: scoring.warnings,
    policy: {
      source: cliMin
        ? 'cli'
        : Object.keys(profile.minimums).length > 0 ||
            effectiveBlocks(profile).length + profile.temporal_block.length > 0
          ? 'profile'
          : 'none',
      enforced: !!opts.enforcePolicy || !!cliMin,
      minimums,
      blocks_evaluated: effectiveBlocks(profile).length + profile.temporal_block.length,
      block_violations: blockViolations,
      violations,
    },
    diagnostics: diagnostics.map((d) => ({ ...d, message: redactSecrets(d.message) })),
    stats: {
      evidence_count: store.size,
      http_requests:
        gh.requests + sc.requests + osv.requests + depsDevHttp.requests + registryHttp.requests,
      authenticated: gh.hasToken,
    },
    evidence: store.all(),
    facts,
    code_analysis: code,
    findings,
    dependency_intel: intel,
    dependency_introductions: { ...dependencyIntroductions, young_package_threshold_days: 30 },
    regulatory,
  };
  return { ...report, integrity: { report_sha256: sha256(JSON.stringify(report)) } };
}

export { HttpError, RateLimitError };
