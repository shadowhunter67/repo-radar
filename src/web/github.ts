/**
 * The only GitHub calls the web server itself makes (everything else happens inside the analysis worker): the free rate-limit
 * endpoint and exact-commit resolution. Both go to the fixed host api.github.com with the server token. Redirects are
 * followed by hand and only while they stay on that host, so the token can never follow a redirect elsewhere.
 */
const HOST = 'api.github.com';
const TIMEOUT_MS = 8000;
type Fetch = typeof fetch;
export type ResolveError = Error & { code: string; resetAt?: string };
const err = (code: string, message: string): ResolveError =>
  Object.assign(new Error(message), { code }) as ResolveError;

async function get(
  path: string,
  token: string | undefined,
  accept: string,
  doFetch: Fetch,
  signal?: AbortSignal,
): Promise<Response> {
  let url = `https://${HOST}${path}`;
  for (let hop = 0; hop < 3; hop++) {
    const res = await doFetch(url, {
      redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
      headers: {
        accept,
        'user-agent': 'repo-radar-web',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (![301, 302, 307, 308].includes(res.status)) return res;
    const next = new URL(res.headers.get('location') ?? '', url);
    if (next.protocol !== 'https:' || next.hostname !== HOST || next.port !== '')
      throw err('UPSTREAM_UNAVAILABLE', 'unexpected redirect target');
    url = next.toString();
  }
  throw err('UPSTREAM_UNAVAILABLE', 'too many redirects');
}

export function githubRateLimit(token: string | undefined, doFetch: Fetch = fetch) {
  return async () => {
    const res = await get('/rate_limit', token, 'application/vnd.github+json', doFetch);
    if (!res.ok) throw err('UPSTREAM_UNAVAILABLE', `rate_limit ${res.status}`);
    const core = ((await res.json()) as { resources?: { core?: Record<string, unknown> } })
      .resources?.core;
    const remaining = Number(core?.['remaining']);
    const limit = Number(core?.['limit']);
    const reset = Number(core?.['reset']);
    if (![remaining, limit, reset].every(Number.isFinite))
      throw err('UPSTREAM_UNAVAILABLE', 'bad rate_limit body');
    return { remaining, limit, resetAt: reset * 1000 };
  };
}

/** Resolve `owner/repo[@ref]` (default branch when no ref) to the exact 40-hex commit SHA with one request. */
export function githubResolveCommit(token: string | undefined, doFetch: Fetch = fetch) {
  return async (
    repo: { owner: string; repo: string; ref?: string },
    signal?: AbortSignal,
  ): Promise<string> => {
    const ref = repo.ref ?? 'HEAD';
    const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${ref
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const res = await get(path, token, 'application/vnd.github.sha', doFetch, signal);
    if (res.status === 404) throw err('REPOSITORY_NOT_FOUND', 'not found');
    if (res.status === 422) throw err('INVALID_REF', 'ref not found');
    if (res.status === 403 || res.status === 429) {
      const e = err('SERVICE_RATE_LIMITED', 'github rate limit');
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(reset) && reset > 0) e.resetAt = new Date(reset * 1000).toISOString();
      throw e;
    }
    if (!res.ok) throw err('UPSTREAM_UNAVAILABLE', `commit lookup ${res.status}`);
    const sha = (await res.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw err('UPSTREAM_UNAVAILABLE', 'unexpected commit lookup body');
    return sha;
  };
}
