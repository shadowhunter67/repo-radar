import type { Dependency } from '../deps/model.js';
import type { Clock } from '../evidence/builder.js';
import {
  DEP_REGISTRY_BUDGET_DEFAULTS,
  type DepRegistryBudget,
  type DependencyRegistryEvent,
  type DependencyRegistryIntel,
  type DependencyRegistryPackage,
  type SkipReason,
} from '../registry/dependency-model.js';
import { correspondDependency, dependencyEvents } from '../registry/dependency-analysis.js';
import {
  selectCandidates,
  type Candidate,
  type PriorityHints,
} from '../registry/dependency-priority.js';
import type { RegistryPackage } from '../registry/model.js';
import type { HttpClient } from '../util/http.js';
import { HttpError } from '../util/http.js';
import { fetchRegistryPackage, makeRegistryGet } from './registry.js';
import { fetchNpmAttestation } from '../registry/attestation.js';
import type { TrustConfig } from '../trust/config.js';

/**
 * Registry lookups for the analyzed repository's dependencies, under an explicit budget.
 *
 * Order of work is the deterministic priority ranking; when a budget (packages, requests, time or bytes) runs out, the
 * remaining eligible packages are reported as SKIPPED with the reason, so coverage is never silently partial. A run-local
 * cache keyed by registry + package means a package requested by several manifests is fetched once. Any failure leaves the
 * package `unknown` (a failed status), never clean.
 */
const NOT_AVAILABLE = [
  'PyPI exposes neither maintainers nor per-version publishers: publisher history is unavailable for PyPI dependencies',
  'crates.io exposes the publisher of each version but not the owner set at the time: maintainer changes are npm only',
  'registry back-link (does the repository claim the package?) is not checked; correspondence means the pointers agree',
  'registry events are read from metadata only: dependency tarballs are never downloaded or inspected',
];

export async function collectDependencyRegistry(opts: {
  http: HttpClient;
  dependencies: Dependency[];
  clock: Clock;
  budget?: Partial<DepRegistryBudget>;
  hints?: PriorityHints;
  note: (code: string, message: string) => void;
  trust?: TrustConfig;
  verifyCrypto?: boolean;
}): Promise<DependencyRegistryIntel> {
  const budget: DepRegistryBudget = { ...DEP_REGISTRY_BUDGET_DEFAULTS, ...opts.budget };
  const budgetOut = {
    max_dependencies: budget.maxDependencies,
    max_requests: budget.maxRequests,
    max_elapsed_ms: budget.maxElapsedMs,
    max_versions: budget.maxVersions,
    max_bytes: budget.maxBytes,
    max_attestations: budget.maxAttestations,
    max_attestation_bytes: budget.maxAttestationBytes,
  };
  const { ranked, ineligible } = selectCandidates(opts.dependencies, opts.hints);
  const skippedCounts: Record<string, number> = {};
  const count = (r: SkipReason): void => {
    skippedCounts[r] = (skippedCounts[r] ?? 0) + 1;
  };
  for (const i of ineligible) count(i.reason);
  if (ranked.length === 0 && opts.dependencies.length === 0)
    return {
      version: '1',
      status: 'no_dependencies',
      budget: budgetOut,
      coverage: {
        eligible: 0,
        queried: 0,
        ok: 0,
        failed: 0,
        skipped: 0,
        direct_eligible: 0,
        direct_queried: 0,
        ratio: null,
      },
      skipped_counts: skippedCounts,
      skipped: [],
      packages: [],
      events: [],
      events_total: 0,
      requests: 0,
      bytes: 0,
      elapsed_ms: 0,
      limits_hit: [],
      not_available: NOT_AVAILABLE,
    };

  const started = opts.clock.now().getTime();
  const observedAt = opts.clock.now().toISOString();
  const limits: string[] = [];
  let requests = 0;
  let bytes = 0;
  let attestationsUsed = 0;
  const elapsed = (): number => Math.max(0, opts.clock.now().getTime() - started);
  const stop = (): SkipReason | null =>
    elapsed() > budget.maxElapsedMs
      ? 'budget_time'
      : bytes > budget.maxBytes
        ? 'budget_bytes'
        : requests >= budget.maxRequests
          ? 'budget_requests'
          : null;
  const hit = (msg: string): void => {
    if (!limits.includes(msg) && limits.length < 10) limits.push(msg);
  };
  const get = makeRegistryGet(
    opts.http,
    (url) => {
      const why = stop();
      if (why) throw new HttpError(`dependency registry ${why}`, 0, url);
      requests++;
    },
    (n) => {
      bytes += n;
    },
  );

  const cache = new Map<string, Promise<RegistryPackage>>();
  const lookup = (c: Candidate): Promise<RegistryPackage> => {
    const key = `${c.registry}:${c.name.toLowerCase()}`;
    let p = cache.get(key);
    if (!p) {
      p = fetchRegistryPackage(
        c.registry,
        {
          name: c.name,
          declaredBy: 'dependency',
          observedAt,
          capVersions: budget.maxVersions,
          resolvedVersions: c.resolvedVersions,
        },
        get,
        { crateOwners: false },
      ).then((r) => {
        if (r.failure)
          opts.note(
            'dependency_registry_lookup_failed',
            `${c.registry}:${c.name.slice(0, 60)}: ${r.failure}`,
          );
        return r.pkg;
      });
      cache.set(key, p);
    }
    return p;
  };

  const selected = ranked.slice(0, budget.maxDependencies);
  const overBudget = ranked.slice(budget.maxDependencies);
  const results = new Map<string, RegistryPackage | SkipReason>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const c = selected[i];
      if (!c) return;
      const why = stop();
      if (why) {
        results.set(`${c.registry}:${c.name.toLowerCase()}`, why);
        continue;
      }
      results.set(`${c.registry}:${c.name.toLowerCase()}`, await lookup(c));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, budget.concurrency) }, worker));

  const packages: DependencyRegistryPackage[] = [];
  const events: DependencyRegistryEvent[] = [];
  const skipped: DependencyRegistryIntel['skipped'] = [];
  const pushSkipped = (c: Candidate, reason: SkipReason): void => {
    count(reason);
    skipped.push({
      registry: c.registry,
      ecosystem: c.registry === 'pypi' ? 'PyPI' : c.registry,
      name: c.name.slice(0, 214),
      reason,
      priority: c.priority,
      direct: c.direct,
    });
  };
  for (const c of selected) {
    const r = results.get(`${c.registry}:${c.name.toLowerCase()}`);
    if (r === undefined || typeof r === 'string') {
      pushSkipped(c, r ?? 'budget_requests');
      continue;
    }
    // A budget that ran out DURING this lookup is a skip, not a failed lookup of the package.
    const cut = /^dependency registry (budget_\w+)/.exec(r.status_detail);
    if (cut) {
      pushSkipped(c, cut[1] as SkipReason);
      continue;
    }
    const repository = correspondDependency(r, c.corroboration);
    const attestationStates: Record<
      string,
      | 'no_provenance'
      | 'provenance_reported'
      | 'provenance_present_unverified'
      | 'provenance_verified'
      | 'source_binding_verified'
      | 'source_binding_conflict'
      | 'verification_failed'
      | 'verification_unavailable'
      | 'verification_skipped_resource_limit'
      | 'unknown'
    > = Object.fromEntries(
      r.versions.map((v) => [
        v.version,
        v.has_provenance ? 'provenance_reported' : 'no_provenance',
      ]),
    );
    if (!opts.verifyCrypto && c.registry === 'npm') {
      for (const version of r.versions.filter((v) => v.has_provenance))
        attestationStates[version.version] = 'provenance_present_unverified';
    } else if (c.registry === 'npm' && budget.maxAttestations === 0) {
      for (const version of r.versions.filter((v) => v.has_provenance))
        attestationStates[version.version] = 'unknown';
    } else if (c.registry === 'npm' && budget.maxAttestations > 0) {
      for (const version of r.versions
        .filter((v) => c.resolvedVersions.includes(v.version))
        .slice(0, 2)) {
        if (!version.has_provenance) continue;
        if (attestationsUsed >= budget.maxAttestations) {
          attestationStates[version.version] = 'unknown';
          continue;
        }
        const result = await fetchNpmAttestation({
          http: opts.http,
          name: c.name,
          version: version.version,
          versionDoc: version,
          publicGoodRoot: opts.trust?.trustedRoots?.find((x) => x.label === 'sigstore_public_good'),
        });
        requests++;
        attestationsUsed++;
        const state = result[0]?.state;
        if (state) attestationStates[version.version] = state;
      }
    }
    const pkg: DependencyRegistryPackage = {
      ...r,
      attestation_states: attestationStates,
      declared_by: (c.dependencyIds[0] ?? 'dependency').slice(0, 300),
      repository,
      dependency_ids: c.dependencyIds,
      resolved_versions: c.resolvedVersions,
      priority: c.priority,
      corroboration: {
        source: c.corroboration.length > 0 ? 'deps.dev' : 'none',
        repositories: c.corroboration.map((x) => x.slice(0, 120)).slice(0, 5),
      },
    };
    packages.push(pkg);
    events.push(...dependencyEvents(pkg, c.resolvedVersions).events);
  }
  for (const c of overBudget) pushSkipped(c, 'budget_dependencies');
  if (overBudget.length > 0)
    hit(
      `${overBudget.length} eligible package(s) were not queried: dependency budget (${budget.maxDependencies}) reached`,
    );
  for (const [reason, n] of Object.entries(skippedCounts))
    if (reason.startsWith('budget_') && reason !== 'budget_dependencies')
      hit(`${n} package(s) were not queried: ${reason.replace('_', ' ')} exhausted`);

  skipped.sort((a, b) => b.priority.score - a.priority.score);
  for (const i of ineligible)
    skipped.push({
      registry: null,
      ecosystem: i.ecosystem,
      name: i.name,
      reason: i.reason,
      priority: i.priority,
      direct: i.direct,
    });
  const ok = packages.filter((p) => p.status === 'ok' || p.status === 'partial').length;
  const directEligible = ranked.filter((c) => c.direct === true && c.primary).length;
  const directQueried = packages.filter((p) => {
    const c = selected.find(
      (x) => x.registry === p.registry && x.name.toLowerCase() === p.name.toLowerCase(),
    );
    return c?.direct === true && c.primary;
  }).length;
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : 1));
  return {
    version: '1',
    status: 'analyzed',
    budget: budgetOut,
    coverage: {
      eligible: ranked.length,
      queried: packages.length,
      ok,
      failed: packages.length - ok,
      skipped: ranked.length - packages.length,
      direct_eligible: directEligible,
      direct_queried: directQueried,
      ratio: ranked.length === 0 ? null : packages.length / ranked.length,
    },
    skipped_counts: skippedCounts,
    skipped: skipped.slice(0, 40),
    packages: packages.slice(0, 100),
    events: events.slice(-120),
    events_total: events.length,
    requests,
    bytes,
    elapsed_ms: Math.round(elapsed()),
    limits_hit: limits,
    not_available: NOT_AVAILABLE,
  };
}
