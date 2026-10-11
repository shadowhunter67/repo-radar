import type { Clock } from '../evidence/builder.js';
import type { Diagnostic } from '../evidence/types.js';
import { type HttpClient, HttpError, RateLimitError, TooLargeError } from '../util/http.js';
import { runPool } from '../util/pool.js';
import { sanitizeForTerminal } from '../util/text.js';
import type { Advisory, Dependency, DepEcosystem } from './model.js';
import { maxSatisfying } from './semver.js';

/**
 * deps.dev (https://deps.dev, Google Open Source Insights; data is CC-BY-4.0) as an OPTIONAL package-intelligence
 * source. Package names and versions are attacker-controlled, so every request goes through the allow-listed
 * HttpClient (https only, one host, no redirects off-host, size and time caps) and every value is URL-encoded.
 *
 * What it is used for:
 *  - metadata (licenses, advisory keys, provenance listing) of EXACT versions that came from the repository;
 *  - the registry's CURRENT version satisfying an unresolved range, recorded as `registry_candidate`.
 * A registry candidate is today's answer, not the revision's; it is never used to reach a vulnerability conclusion.
 */
export const DEPSDEV_HOSTS = ['api.deps.dev'];
const BASE = 'https://api.deps.dev/v3/systems';
export const DEPSDEV_LIMITS = {
  maxVersionLookups: 40,
  maxCandidateLookups: 30,
  concurrency: 4,
  maxBytes: 3_000_000,
} as const;

const SYSTEM: Partial<Record<DepEcosystem, string>> = {
  npm: 'npm',
  PyPI: 'pypi',
  'crates.io': 'cargo',
  Go: 'go',
  Maven: 'maven',
};

export interface DepsDevResult {
  state: 'ok' | 'partial' | 'unavailable' | 'not_needed';
  requests: number;
  enriched: number;
  candidates: number;
  detail?: string;
  diagnostics: Diagnostic[];
  advisories: Advisory[];
}

type Fetched =
  | { ok: true; json: Record<string, unknown> }
  | {
      ok: false;
      reason: 'not_found' | 'rate_limited' | 'http_error' | 'network' | 'malformed' | 'too_large';
    };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown, n = 200): string | undefined =>
  typeof v === 'string' && v ? sanitizeForTerminal(v, n) : undefined;

export async function enrichWithDepsDev(
  deps: Dependency[],
  http: HttpClient,
  clock: Clock,
): Promise<DepsDevResult> {
  const result: DepsDevResult = {
    state: 'not_needed',
    requests: 0,
    enriched: 0,
    candidates: 0,
    diagnostics: [],
    advisories: [],
  };
  const exactTargets = deps
    .filter(
      (d) =>
        d.direct === true &&
        d.resolution === 'resolved' &&
        d.resolved &&
        SYSTEM[d.package.ecosystem],
    )
    .sort((a, b) => Number(b.context === 'primary') - Number(a.context === 'primary'))
    .slice(0, DEPSDEV_LIMITS.maxVersionLookups);
  const candidateTargets = deps
    .filter(
      (d) =>
        d.direct === true &&
        d.context === 'primary' &&
        d.resolution === 'unresolved' &&
        (d.package.ecosystem === 'npm' || d.package.ecosystem === 'crates.io') &&
        (d.requested?.kind === 'range' || d.requested?.kind === 'tag'),
    )
    .slice(0, DEPSDEV_LIMITS.maxCandidateLookups);
  if (exactTargets.length === 0 && candidateTargets.length === 0) return result;

  const memo = new Map<string, Promise<Fetched>>();
  let failures = 0;
  let successes = 0;
  let stopped: string | undefined;
  const failureReasons = new Map<string, number>();

  const get = (url: string): Promise<Fetched> => {
    const hit = memo.get(url);
    if (hit) return hit;
    const p = (async (): Promise<Fetched> => {
      if (stopped) return { ok: false, reason: 'rate_limited' };
      try {
        result.requests++;
        const r = await http.request(url, {
          maxBytes: DEPSDEV_LIMITS.maxBytes,
          headers: { Accept: 'application/json' },
        });
        if (r.status === 404) return { ok: false, reason: 'not_found' };
        if (r.status !== 200) return { ok: false, reason: 'http_error' };
        try {
          const j: unknown = JSON.parse(r.body);
          return isObj(j) ? { ok: true, json: j } : { ok: false, reason: 'malformed' };
        } catch {
          return { ok: false, reason: 'malformed' };
        }
      } catch (e) {
        if (e instanceof RateLimitError) {
          stopped = 'deps.dev rate limit reached';
          return { ok: false, reason: 'rate_limited' };
        }
        if (e instanceof TooLargeError) return { ok: false, reason: 'too_large' };
        return {
          ok: false,
          reason: e instanceof HttpError && e.status > 0 ? 'http_error' : 'network',
        };
      }
    })().then((f) => {
      if (f.ok) successes++;
      else if (f.reason !== 'not_found') {
        failures++;
        failureReasons.set(f.reason, (failureReasons.get(f.reason) ?? 0) + 1);
      }
      return f;
    });
    memo.set(url, p);
    return p;
  };

  const enc = encodeURIComponent;
  const now = clock.now().toISOString();

  await runPool(exactTargets, DEPSDEV_LIMITS.concurrency, async (d) => {
    const resolved = d.resolved;
    const system = SYSTEM[d.package.ecosystem];
    if (!resolved || !system) return;
    const url = `${BASE}/${system}/packages/${enc(d.package.name)}/versions/${enc(resolved.version)}`;
    const f = await get(url);
    if (!f.ok) return;
    const j = f.json;
    const licenses = (Array.isArray(j['licenses']) ? j['licenses'] : [])
      .map((l) => s(l, 100))
      .filter((x): x is string => !!x)
      .slice(0, 10);
    const repos = (Array.isArray(j['relatedProjects']) ? j['relatedProjects'] : [])
      .map((p) => (isObj(p) && isObj(p['projectKey']) ? s(p['projectKey']['id'], 200) : undefined))
      .filter((x): x is string => !!x)
      .slice(0, 5);
    const published = s(j['publishedAt'], 40);
    d.package_info = {
      source: 'deps.dev',
      licenses,
      ...(published ? { published_at: published } : {}),
      ...(typeof j['isDeprecated'] === 'boolean' ? { deprecated: j['isDeprecated'] } : {}),
      source_repositories: repos,
      slsa_provenance_listed:
        Array.isArray(j['slsaProvenances']) && j['slsaProvenances'].length > 0,
    };
    d.derived_from.push('registry:deps.dev');
    result.enriched++;
    for (const k of (Array.isArray(j['advisoryKeys']) ? j['advisoryKeys'] : []).slice(0, 25)) {
      const id = isObj(k) ? s(k['id'], 100) : undefined;
      if (id)
        result.advisories.push({
          id,
          source: 'deps.dev',
          package: d.package.name,
          version: resolved.version,
          lookup_url: url,
          looked_up_at: now,
        });
    }
  });

  await runPool(candidateTargets, DEPSDEV_LIMITS.concurrency, async (d) => {
    const system = SYSTEM[d.package.ecosystem];
    if (!system || !d.requested) return;
    const f = await get(`${BASE}/${system}/packages/${enc(d.package.name)}`);
    if (!f.ok) return;
    const versions = (Array.isArray(f.json['versions']) ? f.json['versions'] : [])
      .slice(0, 5000)
      .flatMap((v) => {
        if (!isObj(v) || !isObj(v['versionKey'])) return [];
        const ver = s(v['versionKey']['version'], 100);
        return ver ? [{ ver, isDefault: v['isDefault'] === true }] : [];
      });
    const flavor = d.package.ecosystem === 'npm' ? 'npm' : 'cargo';
    const pick =
      d.requested.kind === 'tag'
        ? d.requested.spec === 'latest'
          ? versions.find((v) => v.isDefault)?.ver
          : undefined
        : maxSatisfying(
            d.requested.spec,
            versions.map((v) => v.ver),
            flavor,
          );
    if (!pick) return;
    d.registry_candidate = {
      version: pick,
      source: 'deps.dev',
      observed_at: now,
      note: 'what the registry offers today for the requested spec; NOT necessarily the version this revision used, and not used for vulnerability conclusions',
    };
    d.derived_from.push('registry:deps.dev');
    result.candidates++;
  });

  if (failures > 0 && successes === 0) result.state = 'unavailable';
  else if (failures > 0 || stopped) result.state = 'partial';
  else result.state = 'ok';
  if (result.state !== 'ok') {
    const why = [...failureReasons].map(([k, n]) => `${k} x${n}`).join(', ');
    result.detail = `${stopped ?? 'some deps.dev requests failed'}${why ? ` (${why})` : ''}`;
    result.diagnostics.push({
      source: 'deps.dev',
      level: 'warn',
      code: result.state === 'unavailable' ? 'depsdev_unavailable' : 'depsdev_partial',
      message: `deps.dev metadata is ${result.state === 'unavailable' ? 'unavailable' : 'incomplete'}: ${result.detail}. Effect: registry metadata (licenses, provenance listing, current-version candidates) is missing for some or all dependencies; vulnerability results from OSV are unaffected and no dependency was treated as safe because of this.`,
    });
  }
  return result;
}
