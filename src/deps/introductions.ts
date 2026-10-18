import type { LockIndex } from './lock.js';
import type { Dependency } from './model.js';
import type { DependencyRegistryIntel } from '../registry/dependency-model.js';
import type { Fact } from '../facts/index.js';

export const INTRODUCTION_LIMITS = { entries: 300, parentChain: 8 } as const;
export const YOUNG_PACKAGE_DAYS = 30;

export type IntroductionState = 'known' | 'unknown';
export type ParentProvenance = 'verified' | 'reported' | 'none' | 'unknown';

export interface DependencyIntroduction {
  dependency_id: string;
  ecosystem: string;
  package: string;
  resolved_version: string | null;
  direct: boolean | 'unknown';
  parent_chain: string[];
  parent_chain_capped: boolean;
  introduction: IntroductionState;
  introduced_in_revision: string | null;
  introduced_with_count: number | null;
  parent_provenance: ParentProvenance;
  package_first_published_at: string | null;
  resolved_version_published_at: string | null;
  introduced_before_first_publish_days: number | null;
  versions_published_after_introduction: number | null;
  young_package_present: boolean | null;
  release_age_days_min: number | null;
  evidence_ids: string[];
}

export interface DependencyIntroductions {
  version: '1';
  coverage: {
    considered: number;
    with_known_introduction: number;
    unknown: number;
    capped: number;
  };
  entries: DependencyIntroduction[];
  limits_hit: string[];
}

const DAY = 86_400_000;
const validTime = (s: string | null | undefined): number | undefined => {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};

function parentChain(d: Dependency, locks: LockIndex[]): { names: string[]; capped: boolean } {
  const entry = locks
    .flatMap((l) => l.entries)
    .find(
      (e) =>
        e.name === d.package.name &&
        e.version === d.resolved?.version &&
        e.path.includes('node_modules/'),
    );
  if (!entry) return { names: [], capped: false };
  const parts = entry.path.split('/');
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== 'node_modules' || i + 1 >= parts.length) continue;
    const name = parts[i + 1];
    if (!name) continue;
    if (name === d.package.name) break;
    if (name.startsWith('@') && parts[i + 2]) {
      names.push(`${name}/${parts[i + 2]}`);
      i++;
    } else names.push(name);
  }
  const capped = names.length > INTRODUCTION_LIMITS.parentChain;
  return { names: names.slice(-INTRODUCTION_LIMITS.parentChain), capped };
}

export function buildDependencyIntroductions(
  dependencies: Dependency[],
  locks: LockIndex[],
  registry: DependencyRegistryIntel,
  observedAt: string,
): DependencyIntroductions {
  const observed = validTime(observedAt);
  const reg = new Map<string, (typeof registry.packages)[number]>();
  for (const p of registry.packages) reg.set(`${p.registry}:${p.name.toLowerCase()}`, p);
  const entries: DependencyIntroduction[] = [];
  let capped = 0;
  for (const d of dependencies.slice(0, INTRODUCTION_LIMITS.entries)) {
    const chain = parentChain(d, locks);
    if (chain.capped) capped++;
    const p = reg.get(
      `${d.package.ecosystem === 'PyPI' ? 'pypi' : d.package.ecosystem}:${d.package.name.toLowerCase()}`,
    );
    const versions = p?.versions ?? [];
    const times = versions
      .map((v) => validTime(v.published_at))
      .filter((x): x is number => x !== undefined && (!observed || x <= observed));
    const first = times.length ? Math.min(...times) : undefined;
    const resolvedVersion = d.resolved?.version;
    const candidateResolvedAt = resolvedVersion
      ? (validTime(p?.resolved_times?.[resolvedVersion]) ??
        validTime(versions.find((v) => v.version === resolvedVersion)?.published_at))
      : undefined;
    const resolvedAt =
      candidateResolvedAt !== undefined &&
      (observed === undefined || candidateResolvedAt <= observed)
        ? candidateResolvedAt
        : undefined;
    const releaseAge =
      observed !== undefined && resolvedAt !== undefined
        ? Math.max(0, Math.floor((observed - resolvedAt) / DAY))
        : null;
    entries.push({
      dependency_id: d.id,
      ecosystem: d.package.ecosystem,
      package: d.package.name,
      resolved_version: d.resolved?.version ?? null,
      direct: d.direct,
      parent_chain: chain.names,
      parent_chain_capped: chain.capped,
      introduction: 'unknown',
      introduced_in_revision: null,
      introduced_with_count: null,
      parent_provenance: chain.names.length ? 'unknown' : 'none',
      package_first_published_at: first === undefined ? null : new Date(first).toISOString(),
      resolved_version_published_at:
        resolvedAt === undefined ? null : new Date(resolvedAt).toISOString(),
      introduced_before_first_publish_days: null,
      versions_published_after_introduction: null,
      young_package_present: releaseAge === null ? null : releaseAge < YOUNG_PACKAGE_DAYS,
      release_age_days_min: releaseAge,
      evidence_ids: [d.id, ...(d.lockfile_path ? [d.lockfile_path] : [])].slice(0, 4),
    });
  }
  const known = entries.filter((e) => e.introduction === 'known').length;
  return {
    version: '1',
    coverage: {
      considered: dependencies.length,
      with_known_introduction: known,
      unknown: dependencies.length - known,
      capped,
    },
    entries,
    limits_hit:
      dependencies.length > INTRODUCTION_LIMITS.entries ? ['dependency_introductions'] : [],
  };
}

export function deriveIntroductionFacts(intros: DependencyIntroductions): Fact[] {
  const facts: Fact[] = [];
  const known = intros.coverage.with_known_introduction > 0;
  if (known)
    facts.push({
      id: 'deps.introduced_in_revision',
      value: true,
      confidence: 0.8,
      scope: 'dependency',
      derived_from: intros.entries
        .filter((e) => e.introduction === 'known')
        .flatMap((e) => e.evidence_ids),
      derived_by: 'dependency-introductions@0.1',
    });
  const young = intros.entries.some((e) => e.young_package_present === true);
  if (young)
    facts.push({
      id: 'registry.deps.young_package_present',
      value: true,
      confidence: 0.8,
      scope: 'registry',
      derived_from: intros.entries
        .filter((e) => e.young_package_present === true)
        .flatMap((e) => e.evidence_ids),
      derived_by: 'dependency-introductions@0.1',
    });
  const ages = intros.entries
    .map((e) => e.release_age_days_min)
    .filter((x): x is number => x !== null);
  if (ages.length)
    facts.push({
      id: 'registry.deps.release_age_days_min',
      value: Math.min(...ages),
      confidence: 0.8,
      scope: 'registry',
      derived_from: intros.entries
        .filter((e) => e.release_age_days_min !== null)
        .flatMap((e) => e.evidence_ids),
      derived_by: 'dependency-introductions@0.1',
    });
  return facts;
}
