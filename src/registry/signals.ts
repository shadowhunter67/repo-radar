import type { RegistryPackage, RegistrySignal } from './model.js';

/**
 * Observable publisher/package signals. None is a vulnerability and none says anything about intent: a new publisher is also
 * what a legitimate hand-over looks like. Signals that describe publish history carry the event time; signals about the
 * registry's current state say so. Missing data (PyPI has no per-version publishers) simply yields no signal.
 */
export const REGISTRY_THRESHOLDS = {
  dormancyDays: 365,
  /** Newest gap this many times longer than the median earlier gap (and at least cadenceMinDays). */
  cadenceFactor: 5,
  cadenceMinDays: 90,
  /** Versions whose publishers are compared with the earlier history. */
  recentWindow: 3,
} as const;

const DAY = 86_400_000;
const ts = (s: string | null): number => (s ? Date.parse(s) : NaN);

export function registrySignals(pkg: RegistryPackage): RegistrySignal[] {
  const out: RegistrySignal[] = [];
  let n = 0;
  const add = (s: Omit<RegistrySignal, 'id' | 'package' | 'registry'>): void => {
    out.push({
      id: `REG-${pkg.registry}-${pkg.name}-${++n}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 120),
      package: pkg.name,
      registry: pkg.registry,
      ...s,
    });
  };
  if (pkg.status !== 'ok' && pkg.status !== 'partial') return out;
  const dated = pkg.versions.filter((v) => Number.isFinite(ts(v.published_at))); // newest first
  const latest = pkg.versions.find((v) => v.version === pkg.latest_version) ?? pkg.versions[0];

  // ---- state observations -------------------------------------------------------------------------------------
  if (pkg.repository.match === 'conflicting')
    add({
      kind: 'repository_mismatch',
      at: null,
      detail: pkg.repository.reason,
      confidence: 0.8,
      scope: 'current_state',
    });
  if (latest) {
    if (pkg.registry === 'npm') {
      if (latest.has_provenance)
        add({
          kind: 'provenance_present',
          at: latest.published_at,
          detail: `the registry reports a provenance attestation for ${latest.version.slice(0, 40)} (not verified here)`,
          confidence: 0.8,
          scope: 'publish_history',
        });
      else
        add({
          kind: 'provenance_missing',
          at: latest.published_at,
          detail: `the registry reports no provenance attestation for ${latest.version.slice(0, 40)}`,
          confidence: 0.7,
          scope: 'publish_history',
        });
    }
    if (!latest.has_integrity)
      add({
        kind: 'integrity_missing',
        at: latest.published_at,
        detail: 'no integrity metadata is listed for the latest version',
        confidence: 0.6,
        scope: 'publish_history',
      });
  }
  const names = [
    ...pkg.maintainers.names,
    ...pkg.versions.flatMap((v) => (v.publisher ? [v.publisher] : [])),
  ];
  if (names.some((x) => x.suspicious))
    add({
      kind: 'suspicious_publisher_name',
      at: null,
      detail:
        'a maintainer or publisher name contains non-ASCII or control characters (shown with escapes)',
      confidence: 0.6,
      scope: 'current_state',
    });
  if (pkg.maintainers.duplicates > 0)
    add({
      kind: 'duplicate_maintainer_identity',
      at: null,
      detail: `${pkg.maintainers.duplicates} maintainer name(s) repeat (case-insensitive)`,
      confidence: 0.5,
      scope: 'current_state',
    });

  // ---- publish history ----------------------------------------------------------------------------------------
  const withPub = pkg.versions.filter((v) => v.publisher);
  if (withPub.length >= REGISTRY_THRESHOLDS.recentWindow + 2) {
    const recent = withPub.slice(0, REGISTRY_THRESHOLDS.recentWindow);
    const earlier = new Set(
      withPub.slice(REGISTRY_THRESHOLDS.recentWindow).map((v) => v.publisher?.name.toLowerCase()),
    );
    const fresh = recent.filter((v) => !earlier.has(v.publisher?.name.toLowerCase()));
    if (fresh.length > 0) {
      const first = fresh[fresh.length - 1]!;
      add({
        kind: 'new_publisher',
        at: first.published_at,
        detail: `${fresh.length} of the newest ${recent.length} versions were published by an account that published none of the ${withPub.length - recent.length} earlier versions in the sample (first: ${first.version.slice(0, 40)})`,
        confidence: Math.min(0.7, 0.3 + withPub.length / 60),
        scope: 'publish_history',
      });
    }
  }
  if (dated.length >= 3) {
    // gaps between consecutive publishes, newest first
    const gaps = dated.slice(0, -1).map((v, i) => ({
      at: v.published_at,
      version: v.version,
      days: (ts(v.published_at) - ts(dated[i + 1]!.published_at)) / DAY,
    }));
    const big = gaps.find((g) => g.days >= REGISTRY_THRESHOLDS.dormancyDays);
    if (big)
      add({
        kind: 'dormancy_then_publish',
        at: big.at,
        detail: `version ${big.version.slice(0, 40)} was published ${Math.round(big.days)} days after the previous one`,
        confidence: Math.min(0.7, 0.4 + dated.length / 80),
        scope: 'publish_history',
      });
    const older = gaps
      .slice(1)
      .map((g) => g.days)
      .sort((a, b) => a - b);
    const first = gaps[0];
    if (first && older.length >= 4) {
      const median = older[Math.floor(older.length / 2)]!;
      if (
        first.days >= REGISTRY_THRESHOLDS.cadenceMinDays &&
        first.days > REGISTRY_THRESHOLDS.cadenceFactor * Math.max(median, 1)
      )
        add({
          kind: 'cadence_change',
          at: first.at,
          detail: `the newest gap (${Math.round(first.days)} days) is far above the earlier median (${Math.round(median)} days)`,
          confidence: 0.5,
          scope: 'publish_history',
        });
    }
  }
  return out;
}
