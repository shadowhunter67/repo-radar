import { createHash } from 'node:crypto';
import type { FetchLike } from '../../src/util/http.js';
import type { Clock } from '../../src/evidence/builder.js';

export const NOW = new Date('2026-01-01T00:00:00Z');
export const fixedClock: Clock = { now: () => NOW };
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

export interface FakeItem {
  state: 'open' | 'closed';
  createdDaysAgo: number;
  updatedDaysAgo: number;
  closedDaysAgo?: number;
}
/** Rich release description for release-intelligence tests. */
export interface FakeReleaseDetail {
  tag: string;
  /** commit the tag points to */
  commit: string;
  /** annotated tags are resolved through /git/tags/<sha> */
  annotated?: boolean;
  verification?: { verified: boolean; reason: string };
  publishedBy?: string;
  /** name -> content (checksum files are served; other contents are only hashed) */
  assets: Record<string, string>;
  /** asset name -> attestation response body (served at /attestations/sha256:<digest>) */
  attestations?: Record<string, unknown>;
  /** override the browser_download_url of a named asset (for unsafe-URL tests) */
  downloadUrl?: Record<string, string>;
}
export interface FakeRelease {
  detail?: FakeReleaseDetail;
  daysAgo: number;
  assets?: string[];
  draft?: boolean;
  noDate?: boolean;
  prerelease?: boolean;
}

export interface FakeSpec {
  owner: string;
  repo: string;
  /** name GitHub reports (may differ from the URL slug in tests, e.g. Unicode/symbols) */
  displayName: string | null;
  description: string | null;
  topics: string[];
  language: string | null;
  archived: boolean;
  license: string | null;
  createdDaysAgo: number;
  pushedDaysAgo: number;
  /** path -> content. Paths define the git tree. */
  files: Record<string, string>;
  readme: string | null;
  contributors: { login: string; contributions: number; type?: string }[];
  releases: FakeRelease[];
  hasTags: boolean;
  /** ages (days) of the most recent commits, newest first */
  commitDaysAgo: number[];
  commitsTotal: number;
  issues: FakeItem[];
  pulls: FakeItem[];
  branchProtected: boolean;
  /** `null` -> Scorecard returns 404 */
  scorecard: { date: string; score: number; checks: { name: string; score: number }[] } | null;
  /** package name -> advisory ids; used by the OSV fake */
  osvVulns: Record<string, string[]>;
  /** URL substrings that should answer 403 rate limited */
  rateLimited: string[];
  /** URL substrings that should answer 500 */
  failing: string[];
  treeTruncated: boolean;
  /** Requests seen by the release endpoints (paths), for assertions. */
  releaseRequests: string[];
  /** The recursive tree answers with an oversized body (as for very large repositories). */
  treeTooLarge: boolean;
  /** With treeTruncated: how many entries the truncated recursive answer still contains. */
  treeKeep: number;
  /** Tree request URLs (relative to the repo) in the order they were made; filled by the fake. */
  treeRequests: string[];
  /** override the Link header of the commit-count request (null = use a realistic one) */
  linkHeader: string | null;
  /** override the whole OSV querybatch response body */
  osvRaw: unknown;
  /** deps.dev: URL substring -> JSON body (anything else answers 404) */
  depsDev: Record<string, unknown>;
  /** files in the owner's `.github` repo (org-level defaults), keyed by path */
  orgFiles: Record<string, string>;
  /** GitHub community profile `files` object (inherited health files show up here) */
  community: Record<string, unknown> | null;
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export function baseSpec(over: Partial<FakeSpec> = {}): FakeSpec {
  return {
    owner: 'acme',
    repo: 'widget',
    displayName: null,
    description: 'A thing',
    topics: [],
    language: 'TypeScript',
    archived: false,
    license: 'MIT',
    createdDaysAgo: 400,
    pushedDaysAgo: 2,
    files: {},
    readme: null,
    contributors: [],
    releases: [],
    hasTags: false,
    commitDaysAgo: [],
    commitsTotal: 0,
    issues: [],
    pulls: [],
    branchProtected: false,
    scorecard: null,
    osvVulns: {},
    rateLimited: [],
    failing: [],
    treeTruncated: false,
    releaseRequests: [],
    treeTooLarge: false,
    treeKeep: -1,
    treeRequests: [],
    linkHeader: null,
    osvRaw: null,
    depsDev: {},
    orgFiles: {},
    community: null,
    ...over,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function itemJson(i: FakeItem, pr: boolean): Record<string, unknown> {
  return {
    state: i.state,
    created_at: ago(i.createdDaysAgo),
    updated_at: ago(i.updatedDaysAgo),
    closed_at: i.closedDaysAgo === undefined ? null : ago(i.closedDaysAgo),
    ...(pr ? {} : {}),
  };
}

/** Deterministic stand-in for GitHub, raw.githubusercontent.com, Scorecard and OSV. */
export function fakeFetch(spec: FakeSpec, recorded: Recorded[] = []): FetchLike {
  const base = `https://api.github.com/repos/${spec.owner}/${spec.repo}`;
  const raw = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/`;
  const commits = spec.commitDaysAgo.map((d, i) => ({
    sha: `sha${String(i).padStart(37, '0')}`,
    author: { login: `dev${i % 3}` },
    commit: {
      author: { name: `Dev ${i % 3}`, email: `dev${i % 3}@example.com`, date: ago(d) },
      committer: { date: ago(d) },
    },
  }));

  return async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    recorded.push({ url, method: init?.method ?? 'GET', headers });

    if (spec.rateLimited.some((s) => url.includes(s))) {
      return json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(NOW.getTime() / 1000) + 3600),
      });
    }
    if (spec.failing.some((s) => url.includes(s))) return new Response('boom', { status: 500 });

    if (url.startsWith('https://api.securityscorecards.dev/')) {
      if (!spec.scorecard) return json({ message: 'not found' }, 404);
      return json({
        date: spec.scorecard.date,
        score: spec.scorecard.score,
        scorecard: { version: 'v5' },
        checks: spec.scorecard.checks,
      });
    }
    if (url === 'https://api.osv.dev/v1/querybatch') {
      const body = JSON.parse(String(init?.body)) as { queries: { package: { name: string } }[] };
      if (spec.osvRaw !== null) return json(spec.osvRaw);
      return json({
        results: body.queries.map((q) => {
          const ids = spec.osvVulns[q.package.name];
          return ids ? { vulns: ids.map((id) => ({ id })) } : {};
        }),
      });
    }
    if (url.startsWith('https://api.deps.dev/')) {
      const hit = Object.entries(spec.depsDev).find(([k]) => url.includes(k));
      return hit ? json(hit[1]) : json({ error: 'not found' }, 404);
    }
    const dlPrefix = `https://github.com/${spec.owner}/${spec.repo}/releases/download/`;
    if (url.startsWith(dlPrefix)) {
      const [tagPart, ...rest] = url.slice(dlPrefix.length).split('/');
      const tag = decodeURIComponent(tagPart ?? '');
      const name = decodeURIComponent(rest.join('/'));
      spec.releaseRequests.push('download:' + name);
      const d = spec.releases
        .flatMap((r) => (r.detail ? [r.detail] : []))
        .find((x) => x.tag === tag);
      const content = d?.assets[name];
      return content === undefined
        ? new Response('404', { status: 404 })
        : new Response(content, { status: 200 });
    }
    const orgRaw = `https://raw.githubusercontent.com/${spec.owner}/.github/HEAD/`;
    if (url.startsWith(orgRaw)) {
      const c = spec.orgFiles[url.slice(orgRaw.length)];
      return c === undefined
        ? new Response('404', { status: 404 })
        : new Response(c, { status: 200 });
    }
    if (url.startsWith(raw)) {
      const path = decodeURIComponent(url.slice(raw.length).split('/').slice(1).join('/'));
      const content = spec.files[path];
      return content === undefined
        ? new Response('404: Not Found', { status: 404 })
        : new Response(content, { status: 200 });
    }
    if (!url.startsWith(base)) {
      return url.startsWith('https://api.github.com/')
        ? json({ message: 'Not Found' }, 404)
        : new Response('unexpected host', { status: 599 });
    }

    const path = url.slice(base.length);
    if (path === '') {
      return json({
        name: spec.displayName ?? spec.repo,
        full_name: `${spec.owner}/${spec.repo}`,
        html_url: `https://github.com/${spec.owner}/${spec.repo}`,
        description: spec.description,
        archived: spec.archived,
        fork: false,
        default_branch: 'main',
        topics: spec.topics,
        language: spec.language,
        license: spec.license ? { spdx_id: spec.license } : null,
        created_at: ago(spec.createdDaysAgo),
        pushed_at: ago(spec.pushedDaysAgo),
        stargazers_count: 12,
        forks_count: 3,
        size: 100,
        has_issues: true,
      });
    }
    if (path.startsWith('/git/trees/')) {
      spec.treeRequests.push(path);
      const m = /^\/git\/trees\/([^?]+)(\?recursive=1)?$/.exec(path);
      const ref = decodeURIComponent(m?.[1] ?? '');
      const recursive = !!m?.[2];
      const isDir = ref.startsWith('tree:');
      if (spec.treeTooLarge && recursive && !isDir)
        return new Response('{}', { status: 200, headers: { 'content-length': '99999999' } });
      if (isDir || spec.treeTooLarge || (spec.treeTruncated && !recursive)) {
        const dir = isDir ? ref.slice(5) : '';
        const prefix = dir ? dir + '/' : '';
        const rel = Object.entries(spec.files).filter(([p]) => p.startsWith(prefix));
        const out = new Map<string, { path: string; type: string; sha?: string; size?: number }>();
        for (const [p, c] of rel) {
          const sub = p.slice(prefix.length);
          const slash = sub.indexOf('/');
          if (recursive) {
            const parts = sub.split('/');
            for (let i = 1; i < parts.length; i++) {
              const dp = parts.slice(0, i).join('/');
              out.set(dp, { path: dp, type: 'tree', sha: 'tree:' + prefix + dp });
            }
            out.set(sub, { path: sub, type: 'blob', size: c.length, sha: blobSha(c) });
          } else if (slash < 0)
            out.set(sub, { path: sub, type: 'blob', size: c.length, sha: blobSha(c) });
          else {
            const d = sub.slice(0, slash);
            out.set(d, { path: d, type: 'tree', sha: 'tree:' + prefix + d });
          }
        }
        return json({ tree: [...out.values()], truncated: false });
      }
      if (spec.treeTruncated && recursive) {
        return json({
          tree: Object.entries(spec.files)
            .slice(0, spec.treeKeep < 0 ? undefined : spec.treeKeep)
            .map(([p, c]) => ({ path: p, type: 'blob', size: c.length, sha: blobSha(c) })),
          truncated: true,
        });
      }
      return json({
        tree: Object.entries(spec.files).map(([p, c]) => ({
          path: p,
          type: 'blob',
          size: c.length,
          sha: blobSha(c),
        })),
        truncated: spec.treeTruncated,
      });
    }
    if (path === '/readme') {
      return spec.readme === null
        ? json({ message: 'Not Found' }, 404)
        : new Response(spec.readme, { status: 200 });
    }
    if (path.startsWith('/contributors'))
      return json(spec.contributors.map((c) => ({ type: 'User', ...c })));
    if (
      path.startsWith('/git/ref/tags/') ||
      path.startsWith('/git/tags/') ||
      path.startsWith('/attestations/')
    ) {
      spec.releaseRequests.push(path);
      const details = spec.releases.flatMap((r) => (r.detail ? [r.detail] : []));
      if (path.startsWith('/git/ref/tags/')) {
        const d = details.find(
          (x) => x.tag === decodeURIComponent(path.slice('/git/ref/tags/'.length)),
        );
        if (!d) return json({ message: 'Not Found' }, 404);
        return json({
          object: d.annotated
            ? { type: 'tag', sha: 'ab'.repeat(20) }
            : { type: 'commit', sha: d.commit },
        });
      }
      if (path.startsWith('/git/tags/')) {
        const d = details.find((x) => x.annotated);
        if (!d || path !== '/git/tags/' + 'ab'.repeat(20))
          return json({ message: 'Not Found' }, 404);
        return json({ object: { type: 'commit', sha: d.commit }, verification: d.verification });
      }
      const digest = path.slice('/attestations/sha256:'.length);
      for (const d of details)
        for (const [name, body] of Object.entries(d.attestations ?? {}))
          if (sha256(d.assets[name] ?? '') === digest) return json(body);
      return json({ message: 'Not Found' }, 404);
    }
    if (path.startsWith('/releases')) {
      return json(
        spec.releases.map((r) => ({
          draft: !!r.draft,
          published_at: r.noDate ? null : ago(r.daysAgo),
          ...(r.detail
            ? {
                tag_name: r.detail.tag,
                name: r.detail.tag,
                prerelease: !!r.prerelease,
                author: { login: r.detail.publishedBy ?? 'releaser' },
                assets: Object.entries(r.detail.assets).map(([name, content]) => ({
                  name,
                  size: content.length,
                  content_type: 'application/octet-stream',
                  digest: 'sha256:' + sha256(content),
                  download_count: 1,
                  browser_download_url:
                    r.detail?.downloadUrl?.[name] ??
                    `https://github.com/${spec.owner}/${spec.repo}/releases/download/${r.detail?.tag}/${encodeURIComponent(name)}`,
                })),
              }
            : { assets: (r.assets ?? []).map((name) => ({ name })) }),
        })),
      );
    }
    if (path.startsWith('/tags')) return json(spec.hasTags ? [{ name: 'v1' }] : []);
    if (path.startsWith('/commits?per_page=100')) return json(commits);
    if (path.startsWith('/commits?per_page=1')) {
      const realistic = `<${base}/commits?per_page=1&page=2>; rel="next", <${base}/commits?per_page=1&page=${spec.commitsTotal}>; rel="last"`;
      const link: Record<string, string> =
        spec.linkHeader !== null
          ? { link: spec.linkHeader }
          : spec.commitsTotal > 1
            ? { link: realistic }
            : {};
      return json(commits.slice(0, 1), 200, link);
    }
    if (path.startsWith('/issues')) return json(spec.issues.map((i) => itemJson(i, false)));
    if (path.startsWith('/pulls')) return json(spec.pulls.map((i) => itemJson(i, true)));
    if (path.startsWith('/community/profile')) {
      return spec.community ? json({ files: spec.community }) : json({ message: 'Not Found' }, 404);
    }
    if (path.startsWith('/branches/')) return json({ protected: spec.branchProtected });
    return new Response('not found', { status: 404 });
  };
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Git blob object id of a text (what GitHub reports as `sha` for a blob). */
export function blobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}
