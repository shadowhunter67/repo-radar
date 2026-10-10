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
export interface FakeRelease {
  daysAgo: number;
  assets?: string[];
  draft?: boolean;
  noDate?: boolean;
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
  /** override the Link header of the commit-count request (null = use a realistic one) */
  linkHeader: string | null;
  /** override the whole OSV querybatch response body */
  osvRaw: unknown;
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
    linkHeader: null,
    osvRaw: null,
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
      return json({
        tree: Object.entries(spec.files).map(([p, c]) => ({
          path: p,
          type: 'blob',
          size: c.length,
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
    if (path.startsWith('/releases')) {
      return json(
        spec.releases.map((r) => ({
          draft: !!r.draft,
          published_at: r.noDate ? null : ago(r.daysAgo),
          assets: (r.assets ?? []).map((name) => ({ name })),
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
