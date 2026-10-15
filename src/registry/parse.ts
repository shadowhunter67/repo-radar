import type { RegistryId, RegistryPackage, RepoMatch } from './model.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 300): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, n) : null;

const CAP_VERSIONS = 40;

/** Remove control characters; keep a printable, bounded string. */
export function cleanName(v: unknown, n = 100): string {
  if (typeof v !== 'string') return '';
  return [...v]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('')
    .slice(0, n);
}
export const suspiciousName = (raw: unknown): boolean =>
  typeof raw === 'string' &&
  [...raw].some((c) => {
    const code = c.charCodeAt(0);
    return code < 32 || code === 127 || code > 126 || (code >= 0x80 && code <= 0x9f);
  });
export const publisher = (raw: unknown): { name: string; suspicious: boolean } | null => {
  const name = cleanName(raw);
  return name
    ? { name: name.replace(/[^\x20-\x7e]/g, '?'), suspicious: suspiciousName(raw) }
    : null;
};

/**
 * Normalize a repository URL to `owner/repo` when it is a GitHub URL; everything else stays unnormalized. Handles
 * git+https://, git://, ssh, scp-style, `github:owner/repo` and `owner/repo` shorthands. Names are lowercased for comparison.
 */
export function normalizeRepoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u = raw.trim().slice(0, 300);
  if (!u) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return u.toLowerCase().replace(/\.git$/, '');
  u = u.replace(/^git\+/, '').replace(/^github:/, 'https://github.com/');
  u = u
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  u = u.replace(/^git:\/\//, 'https://');
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (
    url.hostname.toLowerCase() !== 'github.com' &&
    url.hostname.toLowerCase() !== 'www.github.com'
  )
    return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0] as string;
  const repo = (parts[1] as string).replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/**
 * Package <-> repository correspondence. The package is one the analyzed repository's own manifest declares, so the
 * repository side already points at the package; this checks the registry side points back.
 * confirmed: the registry's repository URL is the analyzed repository.
 * likely: only the homepage/bug tracker URL is, or the URL names the same owner with a different repo name (renames).
 * conflicting: the registry names a different repository (or a non-GitHub host) as the source.
 * missing: the registry lists no source URL at all. unknown: the lookup did not succeed.
 */
export function matchRepository(
  analyzed: { owner: string; repo: string },
  declared: string | null,
  homepageNorm: string | null,
): { match: RepoMatch; reason: string; normalized: string | null; homepageMatch: boolean } {
  const me = `${analyzed.owner}/${analyzed.repo}`.toLowerCase();
  const normalized = normalizeRepoUrl(declared);
  const homepageMatch = homepageNorm === me;
  if (normalized === me)
    return {
      match: 'confirmed',
      reason: 'registry repository URL is the analyzed repository',
      normalized,
      homepageMatch,
    };
  if (normalized !== null) {
    if (normalized.split('/')[0] === me.split('/')[0] && homepageMatch)
      return {
        match: 'likely',
        reason: 'same owner and the homepage points here (repository renamed or moved?)',
        normalized,
        homepageMatch,
      };
    return {
      match: 'conflicting',
      reason: `registry names another repository (${normalized})`,
      normalized,
      homepageMatch,
    };
  }
  if (declared !== null)
    return {
      match: 'conflicting',
      reason: 'registry source URL is not a GitHub repository',
      normalized: null,
      homepageMatch,
    };
  if (homepageMatch)
    return {
      match: 'likely',
      reason: 'no repository URL, but the homepage points here',
      normalized: null,
      homepageMatch,
    };
  return {
    match: 'missing',
    reason: 'the registry lists no source repository',
    normalized: null,
    homepageMatch,
  };
}

export interface Common {
  name: string;
  declaredBy: string;
  /**
   * The analyzed repository. Absent for DEPENDENCY lookups: the repository field then keeps what the registry declares and
   * `unknown` correspondence, to be completed by `correspondDependency` from independent sources.
   */
  analyzed?: { owner: string; repo: string } | undefined;
  observedAt: string;
  /** Versions kept (newest first). Default 40. */
  capVersions?: number | undefined;
  /** Versions to look up in the full history before it is capped (dependencies: the versions the revision resolved). */
  resolvedVersions?: string[] | undefined;
}

function resolvedTimes(
  c: Common,
  rows: { version: string; published_at: string | null }[],
): Record<string, string | null> | undefined {
  if (!c.resolvedVersions || c.resolvedVersions.length === 0) return undefined;
  const out: Record<string, string | null> = {};
  for (const v of c.resolvedVersions.slice(0, 5))
    out[v.slice(0, 100)] = rows.find((r) => r.version === v)?.published_at ?? null;
  return out;
}

const capOf = (c: Common): number =>
  Math.max(1, Math.min(c.capVersions ?? CAP_VERSIONS, CAP_VERSIONS));

function repositoryBlock(
  c: Common,
  declared: string | null,
  home: string | null,
): RegistryPackage['repository'] {
  if (c.analyzed) {
    const mr = matchRepository(c.analyzed, declared, home);
    return {
      declared_url: declared ? declared.slice(0, 300) : null,
      normalized: mr.normalized,
      homepage_match: mr.homepageMatch,
      homepage_normalized: home,
      match: mr.match,
      reason: mr.reason,
    };
  }
  return {
    declared_url: declared ? declared.slice(0, 300) : null,
    normalized: normalizeRepoUrl(declared),
    homepage_match: false,
    homepage_normalized: home,
    match: 'unknown',
    reason: 'dependency: no analyzed repository to compare with; see correspondence',
  };
}

const emptyBase = (registry: RegistryId, c: Common): RegistryPackage => ({
  registry,
  name: c.name,
  declared_by: c.declaredBy,
  status: 'ok',
  status_detail: '',
  repository: {
    declared_url: null,
    normalized: null,
    homepage_match: false,
    match: 'unknown',
    reason: 'not looked up',
  },
  latest_version: null,
  versions_total: 0,
  versions: [],
  maintainers: { scope: 'current_state', names: [], duplicates: 0 },
  provenance: { reported: 'unknown', versions_with: 0 },
  observed_at: c.observedAt,
  limits: [],
});

export function failedPackage(
  registry: RegistryId,
  c: Common,
  status: RegistryPackage['status'],
  detail: string,
): RegistryPackage {
  const p = emptyBase(registry, c);
  p.status = status;
  p.status_detail = detail.slice(0, 200);
  p.repository.reason = 'registry lookup did not succeed; correspondence unknown';
  return p;
}

function dedupe(names: { name: string; suspicious: boolean }[]): {
  names: typeof names;
  duplicates: number;
} {
  const seen = new Set<string>();
  const out: typeof names = [];
  let dup = 0;
  for (const n of names) {
    const k = n.name.toLowerCase();
    if (seen.has(k)) dup++;
    else {
      seen.add(k);
      out.push(n);
    }
  }
  return { names: out.slice(0, 30), duplicates: dup };
}

/** npm packument (full document). Missing sections make the result `partial`, never a clean one. */
export function parseNpm(body: unknown, c: Common): RegistryPackage {
  const j = obj(body);
  const p = emptyBase('npm', c);
  if (Object.keys(j).length === 0 || !obj(j['versions']))
    return failedPackage('npm', c, 'malformed', 'packument is not an object');
  const times = obj(j['time']);
  const versions = obj(j['versions']);
  const distTags = obj(j['dist-tags']);
  p.latest_version = str(distTags['latest'], 100);
  const rows = Object.keys(versions).map((v) => {
    const vo = obj(versions[v]);
    const dist = obj(vo['dist']);
    const att = obj(dist['attestations']);
    const scripts = obj(vo['scripts']);
    const vrepo = vo['repository'];
    const vrepoUrl = typeof vrepo === 'string' ? vrepo : str(obj(vrepo)['url']);
    return {
      version: v.slice(0, 100),
      published_at: str(times[v], 40),
      publisher: publisher(obj(vo['_npmUser'])['name']),
      yanked_or_deprecated: typeof vo['deprecated'] === 'string' && vo['deprecated'].length > 0,
      has_integrity: typeof dist['integrity'] === 'string' || typeof dist['shasum'] === 'string',
      integrity: typeof dist['integrity'] === 'string' ? dist['integrity'].slice(0, 200) : null,
      has_provenance: Object.keys(att).length > 0,
      repository: vrepoUrl
        ? (normalizeRepoUrl(vrepoUrl) ?? vrepoUrl.trim().toLowerCase().slice(0, 120))
        : null,
      has_install_script:
        vo['hasInstallScript'] === true ||
        ['preinstall', 'install', 'postinstall'].some((k) => typeof scripts[k] === 'string'),
      maintainers: dedupe(
        arr(vo['maintainers']).flatMap((x) => {
          const n = publisher(obj(x)['name']);
          return n ? [n] : [];
        }),
      )
        .names.map((n) => n.name)
        .slice(0, 12),
    };
  });
  rows.sort(
    (a, b) => (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0),
  );
  p.versions_total = rows.length;
  const rt = resolvedTimes(c, rows);
  if (rt) p.resolved_times = rt;
  p.versions = rows.slice(0, capOf(c));
  if (rows.length > capOf(c))
    p.limits.push(`only the newest ${capOf(c)} of ${rows.length} versions are kept`);
  const m = dedupe(
    arr(j['maintainers']).flatMap((x) => {
      const n = publisher(obj(x)['name']);
      return n ? [n] : [];
    }),
  );
  p.maintainers = { scope: 'current_state', names: m.names, duplicates: m.duplicates };
  const repo = obj(j['repository']);
  const declared =
    typeof j['repository'] === 'string' ? (j['repository'] as string) : str(repo['url']);
  const home =
    normalizeRepoUrl(j['homepage']) ??
    normalizeRepoUrl(
      obj(j['bugs'])['url'] && String(obj(j['bugs'])['url']).replace(/\/issues.*$/, ''),
    );
  p.repository = repositoryBlock(c, declared, home);
  const withProv = rows.filter((r) => r.has_provenance).length;
  p.provenance = { reported: withProv > 0 ? 'yes' : 'no', versions_with: withProv };
  if (rows.length === 0) {
    p.status = 'partial';
    p.status_detail = 'no versions listed';
  }
  return p;
}

/** PyPI JSON API. Maintainers and per-version publishers are not exposed by this API. */
export function parsePypi(body: unknown, c: Common): RegistryPackage {
  const j = obj(body);
  const info = obj(j['info']);
  if (Object.keys(info).length === 0)
    return failedPackage('pypi', c, 'malformed', 'no info section');
  const p = emptyBase('pypi', c);
  p.latest_version = str(info['version'], 100);
  const releases = obj(j['releases']);
  const rows = Object.keys(releases).map((v) => {
    const files = arr(releases[v]).map(obj);
    const times = files
      .map((f) => Date.parse(String(f['upload_time_iso_8601'] ?? f['upload_time'] ?? '')))
      .filter(Number.isFinite);
    const first = times.length ? new Date(Math.min(...times)).toISOString() : null;
    return {
      version: v.slice(0, 100),
      published_at: first,
      publisher: null,
      yanked_or_deprecated: files.length > 0 && files.every((f) => f['yanked'] === true),
      has_integrity: files.some((f) => typeof obj(f['digests'])['sha256'] === 'string'),
      has_provenance: false,
    };
  });
  rows.sort(
    (a, b) => (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0),
  );
  p.versions_total = rows.length;
  const rt = resolvedTimes(c, rows);
  if (rt) p.resolved_times = rt;
  p.versions = rows.slice(0, capOf(c));
  if (rows.length > capOf(c))
    p.limits.push(`only the newest ${capOf(c)} of ${rows.length} versions are kept`);
  p.limits.push('PyPI exposes neither maintainers nor per-version publishers through this API');
  const urls = obj(info['project_urls']);
  const candidates = [
    urls['Source'],
    urls['Source Code'],
    urls['Repository'],
    urls['Code'],
    urls['GitHub'],
    urls['Homepage'],
    info['home_page'],
  ]
    .map((x) => str(x))
    .filter((x): x is string => !!x);
  const declared = candidates.find((u) => normalizeRepoUrl(u)) ?? candidates[0] ?? null;
  const home = normalizeRepoUrl(info['home_page']) ?? normalizeRepoUrl(urls['Homepage']);
  p.repository = repositoryBlock(c, declared, home);
  p.provenance = { reported: 'unknown', versions_with: 0 };
  p.limits.push('PyPI attestations are not read by this version');
  if (rows.length === 0) {
    p.status = 'partial';
    p.status_detail = 'no releases listed';
  }
  return p;
}

/** crates.io API (`/api/v1/crates/<name>`), optionally joined with `/owners`. */
export function parseCrates(body: unknown, owners: unknown, c: Common): RegistryPackage {
  const j = obj(body);
  const crate = obj(j['crate']);
  if (Object.keys(crate).length === 0)
    return failedPackage('crates.io', c, 'malformed', 'no crate section');
  const p = emptyBase('crates.io', c);
  p.latest_version = str(crate['max_stable_version'], 100) ?? str(crate['max_version'], 100);
  const rows = arr(j['versions'])
    .map((x) => {
      const v = obj(x);
      return {
        version: String(v['num'] ?? '').slice(0, 100),
        published_at: str(v['created_at'], 40),
        publisher: publisher(obj(v['published_by'])['login']),
        yanked_or_deprecated: v['yanked'] === true,
        has_integrity: typeof v['checksum'] === 'string',
        has_provenance: false,
      };
    })
    .filter((r) => r.version);
  rows.sort(
    (a, b) => (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0),
  );
  p.versions_total = rows.length;
  const rt = resolvedTimes(c, rows);
  if (rt) p.resolved_times = rt;
  p.versions = rows.slice(0, capOf(c));
  if (rows.length > capOf(c))
    p.limits.push(`only the newest ${capOf(c)} of ${rows.length} versions are kept`);
  const own = obj(owners);
  const list = arr(own['users']).flatMap((u) => {
    const n = publisher(obj(u)['login']);
    return n ? [n] : [];
  });
  const m = dedupe(list);
  p.maintainers = { scope: 'current_state', names: m.names, duplicates: m.duplicates };
  if (Object.keys(own).length === 0) p.limits.push('crate owners were not read');
  const declared = str(crate['repository']);
  const home = normalizeRepoUrl(crate['homepage']);
  p.repository = repositoryBlock(c, declared, home);
  p.provenance = { reported: 'unknown', versions_with: 0 };
  p.limits.push('crates.io trusted-publishing provenance is not read by this version');
  return p;
}
