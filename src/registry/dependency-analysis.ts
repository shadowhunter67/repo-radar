import type { DependencyRegistryEvent } from './dependency-model.js';
import type { RegistryPackage } from './model.js';
import { normalizeRepoUrl } from './parse.js';
import { REGISTRY_THRESHOLDS } from './signals.js';

/**
 * Pure analysis of one dependency's registry record: dated events from the sampled publish history, and the package <->
 * repository correspondence. No I/O. Everything described here is something the registry SAID about the past or about now;
 * none of it is a statement about intent.
 */
const DAY = 86_400_000;
const ts = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);
const safe = (s: string, n = 60): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, n);

/** A deps.dev project id (`github.com/owner/repo`) or any repository URL -> `owner/repo` for GitHub, else null. */
export function normalizeProjectId(raw: string): string | null {
  const m = /^(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(
    raw.trim().slice(0, 200),
  );
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  return normalizeRepoUrl(raw);
}

/**
 * Whether an event matters to THIS revision. An event at the resolved version, or just before it (the account that
 * published it may be the new one), matters whatever its age: a project pinned to a version from a takeover still depends
 * on it. An event after the resolved version, or with no resolved version known, matters while it is recent (the upgrade
 * path). Old events before the resolved version are history.
 */
export const RELEVANCE = { beforeDays: 90, recentDays: 730 } as const;
export function isRelevantEvent(
  e: { at: string; relative_to_resolved: string; days_from_resolved?: number | null },
  observedAt: string,
): boolean {
  const age = (Date.parse(observedAt) - Date.parse(e.at)) / DAY;
  if (e.relative_to_resolved === 'at') return true;
  if (e.relative_to_resolved === 'before')
    return (e.days_from_resolved ?? -Infinity) >= -RELEVANCE.beforeDays;
  return age <= RELEVANCE.recentDays;
}

export const DEP_EVENT_LIMITS = {
  perPackage: 10,
  /** A burst is this many versions within this many days after a quieter history. */
  burstVersions: 3,
  burstDays: 3,
  burstMinMedianGapDays: 30,
} as const;

type Version = RegistryPackage['versions'][number];

export interface DepEventResult {
  events: DependencyRegistryEvent[];
  /** Versions that could not take part in any event because the registry gave no usable publish time. */
  untimed: number;
}

export function dependencyEvents(
  pkg: RegistryPackage,
  resolvedVersions: string[],
  idPrefix = 'DEPREG',
): DepEventResult {
  const out: DependencyRegistryEvent[] = [];
  if (pkg.status !== 'ok' && pkg.status !== 'partial') return { events: out, untimed: 0 };
  const evidence = [`depregistry:${pkg.registry}:${safe(pkg.name, 80)}`];
  const observed = Date.parse(pkg.observed_at) || Date.now();
  // A publish time in the future (or before 1990) is registry metadata that cannot be true: such a version is untimed.
  const timed = pkg.versions.filter((v) => {
    const t = ts(v.published_at);
    return Number.isFinite(t) && t <= observed + DAY && t >= Date.UTC(1990, 0, 1);
  });
  const untimed = pkg.versions.length - timed.length;
  // oldest first; equal times keep a stable order by version string
  const chron = [...timed].sort(
    (a, b) => ts(a.published_at) - ts(b.published_at) || (a.version < b.version ? -1 : 1),
  );
  // The resolved version's publish time comes from the FULL history when the parser recorded it; the sampled window
  // (newest versions only) may not contain an older resolved version at all.
  const fromFull = resolvedVersions
    .map((v) => ts(pkg.resolved_times?.[v] ?? null))
    .filter((t) => Number.isFinite(t));
  const resolvedAt =
    fromFull.length > 0
      ? Math.min(...fromFull)
      : chron.filter((v) => resolvedVersions.includes(v.version)).map((v) => ts(v.published_at))[0];
  let n = 0;
  const add = (
    v: Version,
    type: DependencyRegistryEvent['type'],
    detail: string,
    confidence: number,
  ): void => {
    const at = ts(v.published_at);
    out.push({
      id: `${idPrefix}-${pkg.registry}-${safe(pkg.name, 40)}-${++n}`,
      type,
      at: new Date(at).toISOString(),
      registry: pkg.registry,
      package: safe(pkg.name, 214),
      version: safe(v.version, 100),
      detail: detail.slice(0, 300),
      confidence: Math.max(0, Math.min(1, confidence)),
      scope: 'publish_history',
      relative_to_resolved:
        resolvedAt === undefined
          ? 'unknown'
          : at < resolvedAt
            ? 'before'
            : at === resolvedAt
              ? 'at'
              : 'after',
      days_from_resolved:
        resolvedAt === undefined ? null : Math.round(((at - resolvedAt) / DAY) * 10) / 10,
      evidence,
      intent: 'undetermined',
    });
  };

  // ---- publisher: an account that published none of the earlier sampled versions --------------------------------
  const seenPub = new Set<string>();
  let pubCount = 0;
  for (const v of chron) {
    const name = v.publisher?.name.toLowerCase();
    if (!name) continue;
    if (pubCount >= 2 && !seenPub.has(name))
      add(
        v,
        'dependency_publisher_changed',
        `version ${safe(v.version, 40)} was published by an account that published none of the ${pubCount} earlier sampled versions`,
        0.35 + Math.min(0.3, pubCount / 60),
      );
    seenPub.add(name);
    pubCount++;
  }

  // ---- maintainers recorded WITH each version (npm); the registry's current set is deliberately not used ----------
  for (let i = 1; i < chron.length; i++) {
    const a = chron[i - 1]?.maintainers;
    const b = chron[i]?.maintainers;
    if (!a || !b || a.length === 0 || b.length === 0) continue; // empty = not recorded, not "no maintainers"
    const sa = new Set(a.map((x) => x.toLowerCase()));
    const sb = new Set(b.map((x) => x.toLowerCase()));
    const added = b.filter((x) => !sa.has(x.toLowerCase()));
    const removed = a.filter((x) => !sb.has(x.toLowerCase()));
    if (added.length + removed.length === 0) continue;
    add(
      chron[i] as Version,
      'dependency_maintainer_changed',
      `maintainers recorded with ${safe((chron[i] as Version).version, 40)}: added [${added
        .map((x) => safe(x, 30))
        .slice(0, 4)
        .join(', ')}], removed [${removed
        .map((x) => safe(x, 30))
        .slice(0, 4)
        .join(', ')}]`,
      0.5,
    );
  }

  // ---- source repository declared by the version ---------------------------------------------------------------
  for (let i = 1; i < chron.length; i++) {
    const a = chron[i - 1]?.repository;
    const b = chron[i]?.repository;
    if (a && b && a !== b)
      add(
        chron[i] as Version,
        'dependency_repository_changed',
        `the declared source repository changed from ${safe(a, 60)} to ${safe(b, 60)}`,
        0.6,
      );
  }

  // ---- dormancy and cadence ------------------------------------------------------------------------------------
  const recent = (v: Version): boolean =>
    observed - ts(v.published_at) <= REGISTRY_THRESHOLDS.recentDays * DAY;
  for (let i = 1; i < chron.length; i++) {
    const v = chron[i] as Version;
    const gap = (ts(v.published_at) - ts((chron[i - 1] as Version).published_at)) / DAY;
    if (gap >= REGISTRY_THRESHOLDS.dormancyDays && recent(v))
      add(
        v,
        'dependency_dormancy_ended',
        `version ${safe(v.version, 40)} was published ${Math.round(gap)} days after the previous one`,
        Math.min(0.7, 0.4 + chron.length / 80),
      );
  }
  if (chron.length >= 6) {
    const gaps = chron.slice(1).map((v, i) => ({
      v,
      days: (ts(v.published_at) - ts((chron[i] as Version).published_at)) / DAY,
    }));
    const newest = gaps[gaps.length - 1];
    const older = gaps
      .slice(0, -1)
      .map((g) => g.days)
      .sort((a, b) => a - b);
    const median = older[Math.floor(older.length / 2)] ?? 0;
    if (
      newest &&
      recent(newest.v) &&
      newest.days >= REGISTRY_THRESHOLDS.cadenceMinDays &&
      newest.days > REGISTRY_THRESHOLDS.cadenceFactor * Math.max(median, 1) &&
      // a gap this long is already reported as the end of a dormancy
      newest.days < REGISTRY_THRESHOLDS.dormancyDays
    )
      add(
        newest.v,
        'dependency_release_cadence_changed',
        `the newest gap (${Math.round(newest.days)} days) is far above the earlier median (${Math.round(median)} days)`,
        0.45,
      );
    const k = DEP_EVENT_LIMITS.burstVersions;
    if (median >= DEP_EVENT_LIMITS.burstMinMedianGapDays && chron.length > k) {
      const tail = chron.slice(-k);
      const span =
        (ts((tail[k - 1] as Version).published_at) - ts((tail[0] as Version).published_at)) / DAY;
      if (span <= DEP_EVENT_LIMITS.burstDays && recent(tail[k - 1] as Version))
        add(
          tail[k - 1] as Version,
          'dependency_release_cadence_changed',
          `${k} versions were published within ${Math.max(1, Math.round(span))} day(s) after a history with a median gap of ${Math.round(median)} days`,
          0.45,
        );
    }
  }

  // ---- provenance and install-time scripts (npm exposes both per version) --------------------------------------
  for (let i = 1; i < chron.length; i++) {
    const a = chron[i - 1] as Version;
    const b = chron[i] as Version;
    if (pkg.registry === 'npm') {
      if (!a.has_provenance && b.has_provenance)
        add(
          b,
          'dependency_provenance_added',
          `${safe(b.version, 40)} reports a provenance attestation, the previous version did not`,
          0.6,
        );
      if (a.has_provenance && !b.has_provenance)
        add(
          b,
          'dependency_provenance_removed',
          `${safe(b.version, 40)} reports no provenance attestation, the previous version did`,
          0.7,
        );
    }
    if (a.has_install_script === false && b.has_install_script === true)
      add(
        b,
        'dependency_install_hook_introduced',
        `${safe(b.version, 40)} declares an install-time script, the previous version did not`,
        0.75,
      );
  }

  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : 1));
  return { events: out.slice(-DEP_EVENT_LIMITS.perPackage), untimed };
}

/**
 * Package <-> repository correspondence for a DEPENDENCY. There is no analyzed repository to point back to, so agreement
 * between independent pointers is what counts, and the registry's own claim alone is at most `likely`:
 *  - confirmed: the registry names a GitHub repository, a second source (deps.dev) lists the same one, and a third pointer
 *    (homepage or a reported provenance attestation) does not disagree. The back-link from the repository to the package
 *    is NOT checked, so even `confirmed` means "pointers agree", not "the repository owner published this package".
 *  - likely: the registry names a GitHub repository and nothing contradicts it, but no second source corroborates it.
 *  - conflicting: the pointers disagree (registry vs deps.dev vs homepage).
 *  - missing: the registry lists no source at all. unknown: the lookup failed or the host is not GitHub (not comparable).
 */
export function correspondDependency(
  pkg: RegistryPackage,
  corroboration: string[],
): RegistryPackage['repository'] {
  const base = pkg.repository;
  const homepageNormalized = base.homepage_normalized ?? null;
  const keep = (
    match: RegistryPackage['repository']['match'],
    reason: string,
  ): RegistryPackage['repository'] => ({ ...base, match, reason: reason.slice(0, 200) });
  if (pkg.status !== 'ok' && pkg.status !== 'partial')
    return keep('unknown', 'registry lookup did not succeed; correspondence unknown');
  const declared = base.normalized;
  const second = [
    ...new Set(corroboration.map((u) => normalizeProjectId(u)).filter((x): x is string => !!x)),
  ];
  const provenance = pkg.versions[0]?.has_provenance === true;
  if (!declared) {
    if (base.declared_url)
      return keep('unknown', 'the registry source URL is not a GitHub repository; not compared');
    return keep('missing', 'the registry lists no source repository');
  }
  // The same repository NAME under another owner is how an organisation rename or transfer looks from two indexes that
  // refreshed at different times: a note, not a conflict.
  const nameOf = (r: string): string => r.slice(r.indexOf('/') + 1);
  const renamed =
    second.length > 0 &&
    !second.includes(declared) &&
    second.every((r) => nameOf(r) === nameOf(declared));
  const conflictsWithSecond = second.length > 0 && !second.includes(declared) && !renamed;
  const conflictsWithHome = homepageNormalized !== null && homepageNormalized !== declared;
  if (conflictsWithSecond)
    return keep(
      'conflicting',
      `the registry names ${declared} but deps.dev lists ${second.slice(0, 2).join(', ')}`,
    );
  if (conflictsWithHome)
    return keep(
      'conflicting',
      `the registry names ${declared} but its homepage points to ${homepageNormalized}`,
    );
  if (renamed)
    return keep(
      'likely',
      `the registry names ${declared} but deps.dev lists ${second.slice(0, 2).join(', ')}: same repository name under another owner (organisation rename or transfer?)`,
    );
  const agreeSecond = second.includes(declared);
  const agreeHome = homepageNormalized === declared;
  if (agreeSecond && (agreeHome || provenance))
    return keep(
      'confirmed',
      `registry, deps.dev and ${agreeHome ? 'homepage' : 'a reported provenance attestation'} agree on ${declared}; back-link not checked`,
    );
  if (agreeSecond || agreeHome)
    return keep(
      'likely',
      `${agreeSecond ? 'deps.dev' : 'the homepage'} agrees with the registry on ${declared}; one corroborating source only`,
    );
  return keep(
    'likely',
    `only the registry's own claim names ${declared}; no second source corroborates it`,
  );
}
