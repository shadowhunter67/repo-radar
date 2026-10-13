import type { Dependency } from '../deps/model.js';
import type { RegistryId } from './model.js';
import type { Priority, SkipReason } from './dependency-model.js';

/**
 * Deterministic priority model for dependency registry lookups. The budget is finite, so something has to be chosen; the
 * choice is a fixed table of named factors that is reported with every selected AND every skipped dependency. Nothing is
 * learned, random or hidden: the same dependency list always produces the same ranking.
 *
 * Direct beats transitive, runtime beats development, vulnerable beats clean, unpinned beats pinned.
 */
export const PRIORITY_POINTS = {
  direct: 40,
  directUnknown: 20,
  runtime: 30,
  build: 25,
  unknownRelationship: 15,
  optionalOrPeer: 10,
  development: 4,
  test: 0,
  vulnerable: 35,
  involvedInFinding: 20,
  newlyIntroduced: 25,
  installHookKnown: 30,
  unpinned: 10,
  ambiguous: 10,
  auxiliary: -30,
} as const;

export interface PriorityHint {
  points: number;
  reason: string;
}

/** Callers can add factors that only they know (a historical diff: "newly introduced"; a finding: "install hook"). */
export type PriorityHints = Map<string, PriorityHint[]>;
export const hintKey = (ecosystem: string, name: string): string =>
  `${ecosystem}:${name.toLowerCase()}`;

export function scoreDependency(d: Dependency, hints?: PriorityHints): Priority {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(points >= 0 ? `${reason} (+${points})` : `${reason} (${points})`);
  };
  if (d.direct === true) add(PRIORITY_POINTS.direct, 'direct');
  else if (d.direct === 'unknown') add(PRIORITY_POINTS.directUnknown, 'directness unknown');
  switch (d.relationship) {
    case 'runtime':
      add(PRIORITY_POINTS.runtime, 'runtime');
      break;
    case 'build':
      add(PRIORITY_POINTS.build, 'build');
      break;
    case 'optional':
    case 'peer':
      add(PRIORITY_POINTS.optionalOrPeer, d.relationship);
      break;
    case 'development':
      add(PRIORITY_POINTS.development, 'development');
      break;
    case 'unknown':
      add(PRIORITY_POINTS.unknownRelationship, 'relationship unknown');
      break;
    default:
      break;
  }
  if (d.vulnerability.advisory_ids.length > 0) add(PRIORITY_POINTS.vulnerable, 'known advisory');
  if (d.resolution === 'unresolved') add(PRIORITY_POINTS.unpinned, 'unpinned');
  else if (d.resolution === 'ambiguous') add(PRIORITY_POINTS.ambiguous, 'ambiguous resolution');
  if (d.context === 'auxiliary') add(PRIORITY_POINTS.auxiliary, 'auxiliary manifest');
  for (const h of hints?.get(hintKey(d.package.ecosystem, d.package.name)) ?? [])
    add(h.points, h.reason);
  return { score, reasons: reasons.slice(0, 12) };
}

export const REGISTRY_OF: Record<string, RegistryId | undefined> = {
  npm: 'npm',
  PyPI: 'pypi',
  'crates.io': 'crates.io',
};

const NAME_RE: Record<RegistryId, RegExp> = {
  npm: /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
  pypi: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  'crates.io': /^[A-Za-z][A-Za-z0-9_-]*$/,
};

export interface Candidate {
  registry: RegistryId;
  /** The name as the registry knows it (npm aliases resolved). */
  name: string;
  dependencyIds: string[];
  resolvedVersions: string[];
  priority: Priority;
  direct: boolean | 'unknown';
  primary: boolean;
  /** Source repositories a second source (deps.dev) listed, for correspondence. */
  corroboration: string[];
}

export interface Selection {
  /** Eligible packages in priority order (highest first). */
  ranked: Candidate[];
  /** Dependencies that cannot be looked up at all, with the reason. */
  ineligible: {
    ecosystem: string;
    name: string;
    reason: SkipReason;
    priority: Priority;
    direct: boolean | 'unknown';
  }[];
}

/** Real package name behind an npm alias (`npm:real@1`); otherwise the dependency's own name. */
function lookupName(d: Dependency): string {
  const alias = d.requested?.alias_of;
  if (alias) {
    const m = /^(?:npm:)?(@?[^@]+(?:\/[^@]+)?)(?:@.*)?$/.exec(alias);
    if (m?.[1]) return m[1];
  }
  return d.package.name;
}

/**
 * Split dependencies into registry-lookup candidates (merged per registry package, best score wins) and ineligible ones.
 * Pure and deterministic: ties break on registry then name.
 */
export function selectCandidates(deps: Dependency[], hints?: PriorityHints): Selection {
  const byKey = new Map<string, Candidate>();
  const ineligible: Selection['ineligible'] = [];
  const seenIneligible = new Set<string>();
  const pushIneligible = (d: Dependency, reason: SkipReason, priority: Priority): void => {
    const k = `${d.package.ecosystem}:${d.package.name}:${reason}`;
    if (seenIneligible.has(k)) return;
    seenIneligible.add(k);
    ineligible.push({
      ecosystem: d.package.ecosystem,
      name: d.package.name.slice(0, 214),
      reason,
      priority,
      direct: d.direct,
    });
  };
  for (const d of deps) {
    const priority = scoreDependency(d, hints);
    const registry = REGISTRY_OF[d.package.ecosystem];
    if (!registry) {
      pushIneligible(d, 'unsupported_ecosystem', priority);
      continue;
    }
    if (d.resolution === 'not_registry') {
      pushIneligible(d, 'not_registry_source', priority);
      continue;
    }
    const name = lookupName(d);
    if (!NAME_RE[registry].test(name)) {
      pushIneligible(d, 'invalid_name', priority);
      continue;
    }
    const key = `${registry}:${name.toLowerCase()}`;
    const resolved = d.resolved?.version ? [d.resolved.version.slice(0, 100)] : [];
    const repos = d.package_info?.source_repositories ?? [];
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        registry,
        name,
        dependencyIds: [d.id.slice(0, 160)],
        resolvedVersions: resolved,
        priority,
        direct: d.direct,
        primary: d.context === 'primary',
        corroboration: repos.slice(0, 5),
      });
      continue;
    }
    if (prev.dependencyIds.length < 10) prev.dependencyIds.push(d.id.slice(0, 160));
    for (const v of resolved)
      if (!prev.resolvedVersions.includes(v) && prev.resolvedVersions.length < 5)
        prev.resolvedVersions.push(v);
    for (const r of repos)
      if (!prev.corroboration.includes(r) && prev.corroboration.length < 5)
        prev.corroboration.push(r);
    if (d.direct === true) prev.direct = true;
    else if (d.direct === 'unknown' && prev.direct === false) prev.direct = 'unknown';
    if (d.context === 'primary') prev.primary = true;
    if (priority.score > prev.priority.score) prev.priority = priority;
  }
  const ranked = [...byKey.values()].sort(
    (a, b) =>
      b.priority.score - a.priority.score ||
      (a.registry < b.registry ? -1 : a.registry > b.registry ? 1 : 0) ||
      (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1),
  );
  ineligible.sort((a, b) => b.priority.score - a.priority.score || (a.name < b.name ? -1 : 1));
  return { ranked, ineligible };
}
