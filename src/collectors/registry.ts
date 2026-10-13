import type { Clock } from '../evidence/builder.js';
import { failedPackage, parseCrates, parseNpm, parsePypi, type Common } from '../registry/parse.js';
import type { RegistryId, RegistryIntel, RegistryPackage } from '../registry/model.js';
import { registrySignals } from '../registry/signals.js';
import type { HttpClient } from '../util/http.js';
import { HttpError, RateLimitError, TooLargeError } from '../util/http.js';
import type { ParsedManifest } from './manifests/parse.js';

/** Hosts the registry client may reach (redirects included). Registry-provided URLs are never followed elsewhere. */
export const REGISTRY_HOSTS = ['registry.npmjs.org', 'pypi.org', 'crates.io'];

export const REGISTRY_LIMITS = {
  maxPackages: 4,
  maxRequests: 10,
  npmMaxBytes: 8 * 1024 * 1024,
  jsonMaxBytes: 16 * 1024 * 1024,
} as const;

const NAME_RE: Record<RegistryId, RegExp> = {
  npm: /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
  pypi: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  'crates.io': /^[A-Za-z][A-Za-z0-9_-]*$/,
};

/** Packages the analyzed repository itself declares as publishable. Dependencies are not looked up here. */
export function declaredPackages(
  manifests: ParsedManifest[],
): { registry: RegistryId; name: string; declaredBy: string }[] {
  const out: { registry: RegistryId; name: string; declaredBy: string }[] = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    const registry: RegistryId | undefined =
      m.ecosystem === 'npm'
        ? 'npm'
        : m.ecosystem === 'PyPI'
          ? 'pypi'
          : m.ecosystem === 'crates.io'
            ? 'crates.io'
            : undefined;
    if (!registry || !m.name || m.isPrivate) continue;
    if (!NAME_RE[registry].test(m.name)) continue;
    if (
      /(?:^|\/)(?:examples?|tests?|docs?|fixtures?|benchmarks?|benches|fuzz|xtask|testing|internal)\//i.test(
        m.file,
      )
    )
      continue;
    const key = `${registry}:${m.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ registry, name: m.name, declaredBy: m.file.slice(0, 300) });
  }
  return out.slice(0, REGISTRY_LIMITS.maxPackages);
}

export function statusOf(e: unknown): { status: RegistryPackage['status']; detail: string } {
  if (e instanceof RateLimitError)
    return { status: 'rate_limited', detail: 'registry rate limit reached' };
  if (e instanceof TooLargeError)
    return { status: 'too_large', detail: 'response larger than the size limit' };
  if (e instanceof HttpError) {
    if (e.status === 404) return { status: 'not_found', detail: 'package not found' };
    if (e.status >= 500)
      return { status: 'server_error', detail: `registry answered HTTP ${e.status}` };
    if (e.status === 429) return { status: 'rate_limited', detail: 'registry rate limit reached' };
    if (/timed? ?out|abort/i.test(e.message))
      return { status: 'timeout', detail: 'request timed out' };
    return { status: 'unavailable', detail: e.message.replace(/[^\x20-\x7e]/g, '?').slice(0, 120) };
  }
  return {
    status: 'unavailable',
    detail: (e instanceof Error ? e.message : 'failed').replace(/[^\x20-\x7e]/g, '?').slice(0, 120),
  };
}

export type RegistryGet = (url: string, maxBytes: number) => Promise<{ body: unknown }>;

/**
 * One package lookup (own packages and dependencies share it). Never throws: every failure becomes a package with a failed
 * status, which downstream code reads as "unknown", never as clean.
 */
export async function fetchRegistryPackage(
  registry: RegistryId,
  c: Common,
  get: RegistryGet,
): Promise<{ pkg: RegistryPackage; failure?: string }> {
  try {
    if (registry === 'npm') {
      const { body } = await get(
        `https://registry.npmjs.org/${c.name.replace('/', '%2F')}`,
        REGISTRY_LIMITS.npmMaxBytes,
      );
      return { pkg: parseNpm(body, c) };
    }
    if (registry === 'pypi') {
      const { body } = await get(
        `https://pypi.org/pypi/${encodeURIComponent(c.name)}/json`,
        REGISTRY_LIMITS.jsonMaxBytes,
      );
      return { pkg: parsePypi(body, c) };
    }
    const { body } = await get(
      `https://crates.io/api/v1/crates/${encodeURIComponent(c.name)}`,
      REGISTRY_LIMITS.jsonMaxBytes,
    );
    let owners: unknown;
    try {
      owners = (
        await get(
          `https://crates.io/api/v1/crates/${encodeURIComponent(c.name)}/owners`,
          REGISTRY_LIMITS.jsonMaxBytes,
        )
      ).body;
    } catch {
      owners = undefined; // owners are optional: the package stays `ok` and says owners were not read
    }
    return { pkg: parseCrates(body, owners, c) };
  } catch (e) {
    const s =
      e instanceof SyntaxError
        ? { status: 'malformed' as const, detail: 'response is not valid JSON' }
        : statusOf(e);
    return { pkg: failedPackage(registry, c, s.status, s.detail), failure: s.status };
  }
}

/** Build the guarded `get` used by both collectors: content-type check, JSON parse, status check. */
export function makeRegistryGet(
  http: HttpClient,
  guard: (url: string) => void,
  onBody?: (bytes: number) => void,
): RegistryGet {
  return async (url, maxBytes) => {
    guard(url);
    const r = await http.request(url, { headers: { Accept: 'application/json' }, maxBytes });
    onBody?.(r.body.length);
    if (r.status !== 200) throw new HttpError(`HTTP ${r.status}`, r.status, url);
    const ct = r.headers.get('content-type') ?? '';
    if (ct && !/json/i.test(ct)) throw new SyntaxError('unexpected content type');
    return { body: JSON.parse(r.body) as unknown };
  };
}

export async function collectRegistry(opts: {
  http: HttpClient;
  manifests: ParsedManifest[];
  analyzed: { owner: string; repo: string };
  clock: Clock;
  note: (code: string, message: string) => void;
}): Promise<RegistryIntel> {
  const wanted = declaredPackages(opts.manifests);
  if (wanted.length === 0)
    return {
      version: '1',
      status: 'no_packages',
      packages: [],
      signals: [],
      requests: 0,
      limits_hit: [],
    };
  const observedAt = opts.clock.now().toISOString();
  const limits: string[] = [];
  let requests = 0;
  const get = makeRegistryGet(opts.http, (url) => {
    if (requests >= REGISTRY_LIMITS.maxRequests)
      throw new HttpError('registry request budget reached', 0, url);
    requests++;
  });
  const packages: RegistryPackage[] = [];
  for (const w of wanted) {
    const c = { name: w.name, declaredBy: w.declaredBy, analyzed: opts.analyzed, observedAt };
    const r = await fetchRegistryPackage(w.registry, c, get);
    if (r.failure)
      opts.note('registry_lookup_failed', `${w.registry}:${w.name.slice(0, 60)}: ${r.failure}`);
    packages.push(r.pkg);
  }
  const signals = packages.flatMap((p) => registrySignals(p)).slice(0, 60);
  return { version: '1', status: 'analyzed', packages, signals, requests, limits_hit: limits };
}
