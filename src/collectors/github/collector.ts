import type { CollectorResult } from '../../evidence/types.js';
import { EvidenceBuilder, type Clock } from '../../evidence/builder.js';
import { HttpClient, HttpError, RateLimitError, TooLargeError } from '../../util/http.js';
import type { RepoRef } from '../../util/repo-ref.js';
import { daysBetween, median, round } from '../../util/text.js';
import { parseManifest, type ParsedManifest } from '../manifests/parse.js';
import type { GithubCollection } from '../types.js';
import { analyzeReadme } from './readme.js';
import { analyzeTree, isStaticallyTyped, type TreeEntry } from './tree.js';
import { analyzeWorkflow, type WorkflowFacts } from './workflows.js';
import { nextRefCandidates, selectScanCandidates } from './scanfiles.js';
import type { FileRole, ScannedFile } from '../../analysis/types.js';
import { LIMITS } from '../../limits.js';

export const GITHUB_HOSTS = ['api.github.com', 'raw.githubusercontent.com'];
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

const MAX_WORKFLOWS = 20;
const MAX_MANIFESTS = 10;
const MAX_LOCKS = 6;
const MAX_SBOMS = 3;
const TREE_MAX_BYTES = 8 * 1024 * 1024;
/** Lockfiles and SBOMs are routinely larger than ordinary manifests. */
const DEPFILE_MAX_BYTES = 5 * 1024 * 1024;
const RAW_MAX_BYTES = 512 * 1024;
const STALE_DAYS = 180;

export class RepoNotFoundError extends Error {
  constructor(ref: RepoRef) {
    super(`repository ${ref.owner}/${ref.repo} not found or not accessible`);
    this.name = 'RepoNotFoundError';
  }
}

interface GhRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  archived: boolean;
  fork: boolean;
  default_branch: string;
  topics?: string[];
  language: string | null;
  license: { spdx_id: string | null } | null;
  created_at: string;
  pushed_at: string | null;
  stargazers_count: number;
  forks_count: number;
  size: number;
  has_issues: boolean;
}

export async function collectGithub(
  ref: RepoRef,
  http: HttpClient,
  clock: Clock,
  options: { scan?: boolean; ref?: string; sbom?: boolean } = {},
): Promise<GithubCollection & CollectorResult> {
  const b = new EvidenceBuilder('github', clock);
  const now = clock.now();
  const base = `${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const jsonHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const repoRes = await http.request(base, { headers: jsonHeaders });
  if (repoRes.status === 404) throw new RepoNotFoundError(ref);
  if (repoRes.status !== 200)
    throw new HttpError(`GitHub returned HTTP ${repoRes.status}`, repoRes.status, base);
  const repo = JSON.parse(repoRes.body) as GhRepo;
  const branch = repo.default_branch;
  // Files, tree and commits are read at `readRef` (a pinned commit for reproducible runs); API-derived signals
  // such as issues, releases, contributors and branch protection always reflect the current state.
  const readRef = options.ref ?? branch;
  if (options.ref) {
    b.diag(
      'info',
      'pinned_ref',
      `repository files read at ${options.ref}; issues, releases, contributors and protection reflect the current state`,
    );
  }

  /** Run an optional fetch; failures become diagnostics, never abort the analysis. */
  async function safe<T>(
    label: string,
    fn: () => Promise<T>,
    affects: string[] = [],
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RateLimitError) {
        b.diag(
          'warn',
          'rate_limited',
          `${label}: GitHub rate limit reached${http.hasToken ? '' : ' (set GITHUB_TOKEN for higher limits)'}`,
          affects,
        );
      } else if (e instanceof TooLargeError) {
        b.diag('warn', 'too_large', `${label}: response too large, skipped`, affects);
      } else {
        b.diag(
          'warn',
          'fetch_failed',
          `${label}: ${e instanceof Error ? e.message : String(e)}`,
          affects,
        );
      }
      return undefined;
    }
  }
  async function getJson<T>(
    label: string,
    path: string,
    affects: string[] = [],
    maxBytes?: number,
  ): Promise<{ data: T; headers: Headers } | undefined> {
    return safe(
      label,
      async () => {
        const r = await http.request(`${base}${path}`, {
          headers: jsonHeaders,
          ...(maxBytes ? { maxBytes } : {}),
        });
        if (r.status === 204) return { data: [] as unknown as T, headers: r.headers };
        if (r.status !== 200) throw new HttpError(`HTTP ${r.status}`, r.status, `${base}${path}`);
        return { data: JSON.parse(r.body) as T, headers: r.headers };
      },
      affects,
    );
  }

  // ---- group 1: independent API calls -------------------------------------------------------
  const [
    treeRes,
    readmeRes,
    contribRes,
    releasesRes,
    tagsRes,
    commitsRes,
    totalRes,
    issuesRes,
    pullsRes,
    branchRes,
    communityRes,
  ] = await Promise.all([
    getJson<{ tree?: TreeEntry[]; truncated?: boolean }>(
      'git tree',
      `/git/trees/${encodeURIComponent(readRef)}?recursive=1`,
      [
        'github.tree.',
        'github.file.',
        'github.workflows.',
        'manifest.',
        'heuristic.substance.',
        'osv.',
      ],
      // GitHub caps a recursive tree at 100k entries / 7 MB; the default 2 MB cap made large repositories invisible.
      TREE_MAX_BYTES,
    ),
    safe(
      'readme',
      async () => {
        const r = await http.request(`${base}/readme`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
          maxBytes: RAW_MAX_BYTES,
        });
        if (r.status === 404) return undefined;
        if (r.status !== 200) throw new HttpError(`HTTP ${r.status}`, r.status, `${base}/readme`);
        return r.body;
      },
      ['docs.readme.', 'heuristic.substance.readme_heavy'],
    ),
    getJson<{ login?: string; type?: string; contributions: number }[]>(
      'contributors',
      '/contributors?per_page=100',
      ['github.contributors.'],
    ),
    getJson<GhRelease[]>('releases', '/releases?per_page=30', ['github.releases.']),
    getJson<unknown[]>('tags', '/tags?per_page=1'),
    getJson<GhCommit[]>('commits', `/commits?per_page=100&sha=${encodeURIComponent(readRef)}`, [
      'github.commits.recent',
      'github.commits.last',
      'github.commits.distinct',
    ]),
    getJson<unknown[]>('commit count', `/commits?per_page=1&sha=${encodeURIComponent(readRef)}`, [
      'github.commits.total',
    ]),
    repo.has_issues
      ? getJson<GhIssue[]>('issues', '/issues?state=all&per_page=100&sort=updated&direction=desc', [
          'github.issues.',
        ])
      : Promise.resolve(undefined),
    getJson<GhPull[]>(
      'pull requests',
      '/pulls?state=all&per_page=100&sort=updated&direction=desc',
      ['github.pulls.'],
    ),
    getJson<{ protected?: boolean }>('branch', `/branches/${encodeURIComponent(branch)}`, [
      'github.branch.',
    ]),
    getJson<CommunityProfile>('community profile', '/community/profile'),
  ]);

  const headSha = commitsRes?.data?.[0]?.sha;
  const refStr = headSha ?? readRef;
  const url = (p: string): string => `${base}${p}`;
  const cap = { ref: refStr } as const;

  // ---- repo metadata ------------------------------------------------------------------------
  const repoUrl = base;
  const meta = { url: repoUrl, http_status: 200 };
  b.add('github.repo.archived', repo.archived, meta);
  b.add('github.repo.fork', repo.fork, meta);
  b.add('github.repo.default_branch', branch, meta);
  b.add('github.repo.license_spdx', repo.license?.spdx_id ?? 'none', meta);
  b.add('github.repo.has_description', !!repo.description?.trim(), meta);
  if (repo.description)
    b.add('github.repo.description_length', repo.description.trim().length, meta);
  b.add('github.repo.topic_count', (repo.topics ?? []).length, meta);
  if (repo.language) b.add('github.repo.language', repo.language, meta);
  b.add('github.repo.age_days', round(daysBetween(now, new Date(repo.created_at)), 1), meta);
  if (repo.pushed_at)
    b.add(
      'github.repo.days_since_push',
      round(daysBetween(now, new Date(repo.pushed_at)), 1),
      meta,
    );
  b.add('github.repo.stars', repo.stargazers_count, { ...meta, metadata: { context_only: true } });
  b.add('github.repo.forks', repo.forks_count, { ...meta, metadata: { context_only: true } });
  b.add('github.repo.size_kb', repo.size, meta);
  b.add('github.repo.has_issues', repo.has_issues, meta);

  // A SECURITY policy can be inherited from the owner's `.github` repository.
  async function orgSecurityPolicy(): Promise<boolean> {
    const owner = encodeURIComponent(ref.owner);
    for (const p of ['SECURITY.md', '.github/SECURITY.md']) {
      try {
        const r = await http.request(`${RAW}/${owner}/.github/HEAD/${p}`, { maxBytes: 4096 });
        if (r.status === 200 && r.body.trim().length > 0) return true;
      } catch {
        /* absent or unreachable: treated as "not found" */
      }
    }
    return false;
  }
  const orgSecurity =
    treeRes && !analyzeTree(treeRes.data.tree ?? []).flags.security_policy
      ? await orgSecurityPolicy()
      : false;

  // ---- tree-derived evidence ----------------------------------------------------------------
  const entries = treeRes?.data.tree ?? [];
  const truncated = treeRes?.data.truncated === true;
  const tree = analyzeTree(entries);
  if (treeRes) {
    const t = { url: url(`/git/trees/${branch}`), ...cap, confidence: truncated ? 0.6 : 1 };
    if (truncated)
      b.diag(
        'warn',
        'tree_truncated',
        'repository tree was truncated by GitHub; file-based signals may be incomplete',
      );
    b.add('github.tree.file_count', tree.fileCount, { ...t, metadata: { truncated } });
    b.add('github.tree.source_file_count', tree.sourceFileCount, t);
    b.add('github.tree.test_file_count', tree.testFileCount, t);
    // A file that is present is solid evidence even when the tree was truncated; absence is not.
    b.add('github.tree.has_tests', tree.testFileCount > 0, {
      ...t,
      confidence: tree.testFileCount > 0 ? 1 : t.confidence,
    });
    if (tree.sourceFileCount > 0) {
      b.add(
        'github.tree.test_to_source_ratio',
        round(tree.testFileCount / tree.sourceFileCount, 3),
        { ...t, kind: 'heuristic', confidence: t.confidence * 0.7 },
      );
    }
    const f = tree.flags;
    // Absence in a truncated tree is weak evidence; presence is always solid.
    const flagConf = (present: boolean): number => (present || !truncated ? 1 : 0.5);
    // GitHub's community profile also reflects files inherited from the owner's `.github` repo.
    const files = communityRes?.data.files ?? {};
    const community: Partial<Record<string, boolean>> = {
      code_of_conduct: !!(files.code_of_conduct ?? files.code_of_conduct_file),
      contributing: !!files.contributing,
      issue_templates: !!files.issue_template,
      pr_template: !!files.pull_request_template,
    };
    for (const [k, v] of Object.entries(f)) {
      if (k === 'lint_config' || k === 'type_config') continue;
      const inherited = !v && (community[k] === true || (k === 'security_policy' && orgSecurity));
      b.add(`github.file.${k}`, v || inherited, {
        ...t,
        confidence: flagConf(v || inherited),
        ...(inherited
          ? {
              metadata: {
                detected_by:
                  'community profile or owner .github repository (inherited default file)',
              },
            }
          : {}),
      });
    }
    b.add('github.workflows.count', tree.workflowPaths.length, t);
  }

  // ---- raw file fetches (never executed; parsed statically) ---------------------------------
  const rawFetchBytes = (path: string, maxBytes: number): Promise<string | undefined> =>
    safe(`raw ${path}`, async () => {
      const u = `${RAW}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${encodeURIComponent(refStr)}/${path.split('/').map(encodeURIComponent).join('/')}`;
      const r = await http.request(u, { maxBytes });
      return r.status === 200 ? r.body : undefined;
    });
  const rawFetch = (path: string): Promise<string | undefined> =>
    rawFetchBytes(path, RAW_MAX_BYTES);
  const depFetch = (path: string): Promise<string | undefined> =>
    rawFetchBytes(path, DEPFILE_MAX_BYTES);

  const wfPaths = tree.workflowPaths.slice(0, MAX_WORKFLOWS);
  const manifestPaths = pickManifests(tree.manifestPaths).slice(0, MAX_MANIFESTS);
  const lockPaths = tree.lockPaths.slice(0, MAX_LOCKS);
  const sbomPaths = options.sbom === false ? [] : tree.sbomPaths.slice(0, MAX_SBOMS);
  if (tree.sbomPaths.length > MAX_SBOMS && options.sbom !== false)
    b.diag('info', 'sboms_capped', `read ${MAX_SBOMS} of ${tree.sbomPaths.length} SBOM-like files`);
  if (tree.lockPaths.length > MAX_LOCKS)
    b.diag('info', 'locks_capped', `read ${MAX_LOCKS} of ${tree.lockPaths.length} lockfiles`);
  const [wfTexts, manifestTexts, lockTexts, sbomTexts] = await Promise.all([
    pool(wfPaths, 5, rawFetch),
    pool(manifestPaths, 5, rawFetch),
    pool(lockPaths, 3, depFetch),
    pool(sbomPaths, 2, depFetch),
  ]);

  // workflows
  const wfFacts: WorkflowFacts[] = wfTexts
    .filter((t): t is string => !!t)
    .map(analyzeWorkflow)
    .filter((w) => w.parsed);
  if (tree.workflowPaths.length > MAX_WORKFLOWS)
    b.diag(
      'info',
      'workflows_capped',
      `analyzed ${MAX_WORKFLOWS} of ${tree.workflowPaths.length} workflows`,
    );
  if (wfFacts.length > 0) {
    const w = {
      url: url('/contents/.github/workflows'),
      ...cap,
      confidence: wfFacts.length === tree.workflowPaths.length ? 1 : 0.7,
    };
    const ext = sum(wfFacts, (x) => x.externalActions);
    b.add('github.workflows.analyzed_count', wfFacts.length, w);
    b.add('github.workflows.external_action_count', ext, w);
    if (ext > 0)
      b.add(
        'github.workflows.pinned_actions_ratio',
        round(sum(wfFacts, (x) => x.pinnedActions) / ext, 3),
        w,
      );
    b.add(
      'github.workflows.permissions_declared_ratio',
      round(wfFacts.filter((x) => x.hasPermissions).length / wfFacts.length, 3),
      w,
    );
    b.add(
      'github.workflows.pull_request_target',
      wfFacts.some((x) => x.pullRequestTarget),
      w,
    );
    b.add(
      'github.workflows.dangerous_checkout',
      wfFacts.some((x) => x.dangerousCheckout),
      { ...w, kind: 'heuristic', confidence: w.confidence * 0.8 },
    );
    b.add(
      'github.workflows.expression_injection_risk',
      wfFacts.some((x) => x.expressionInjection),
      { ...w, kind: 'heuristic', confidence: w.confidence * 0.8 },
    );
    b.add(
      'github.workflows.runs_tests',
      wfFacts.some((x) => x.runsTests),
      { ...w, kind: 'heuristic', confidence: w.confidence * 0.8 },
    );
    b.add(
      'github.workflows.uses_sast',
      wfFacts.some((x) => x.usesSast),
      w,
    );
    b.add(
      'github.workflows.uses_provenance',
      wfFacts.some((x) => x.usesProvenance),
      w,
    );
    b.add(
      'heuristic.substance.ci_without_tests',
      !wfFacts.some((x) => x.runsTests) && tree.testFileCount === 0,
      { source: 'heuristic', kind: 'heuristic', confidence: 0.5, ...cap },
    );
  }

  // manifests
  const manifests: ParsedManifest[] = [];
  manifestPaths.forEach((p, i) => {
    const text = manifestTexts[i];
    if (!text) return;
    const m = parseManifest(p, text);
    if (m) manifests.push(m);
    else b.diag('info', 'manifest_unparsed', `could not parse ${p}`);
  });
  const pyproject = manifestTexts[manifestPaths.findIndex((p) => p === 'pyproject.toml')];
  const pyLint = !!pyproject && /^\s*\[tool\.(?:ruff|pylint|flake8|black)\b/m.test(pyproject);
  const devLint = manifests.some((m) =>
    m.devDependencyNames.some((n) =>
      /^(?:eslint|xo|oxlint|tslint|standard|@biomejs\/biome|@antfu\/eslint-config|clippy)$/.test(n),
    ),
  );
  const pyType = !!pyproject && /^\s*\[tool\.(?:mypy|pyright)\b/m.test(pyproject);
  b.add('github.file.lint_config', tree.flags.lint_config || pyLint || devLint, {
    ...cap,
    confidence: tree.flags.lint_config || pyLint || devLint ? 1 : truncated ? 0.5 : 0.9,
  });
  const typed = tree.flags.type_config || pyType || isStaticallyTyped(repo.language ?? undefined);
  b.add('github.file.type_check_config', typed, {
    ...cap,
    kind: 'heuristic',
    confidence: 0.8,
    metadata: { statically_typed_language: isStaticallyTyped(repo.language ?? undefined) },
  });

  const eco = [...new Set(manifests.map((m) => m.ecosystem))];
  const directDeps = sum(manifests, (m) => m.dependencies.length);
  if (manifests.length > 0) {
    const mu = { ...cap, source: 'manifest' as const };
    b.add('manifest.ecosystems', eco, mu);
    b.add('manifest.dependency_count', directDeps, mu);
    b.add('manifest.file_count', manifests.length, mu);
    // Only manifest kinds that *can* carry a description count (go.mod / requirements.txt cannot).
    const describable = manifests.filter((m) =>
      /(?:package\.json|pyproject\.toml|Cargo\.toml)$/.test(m.file),
    );
    if (describable.length > 0)
      b.add(
        'manifest.has_description',
        describable.some((m) => !!m.description?.trim()),
        mu,
      );
  }

  const depInputs: GithubCollection['depInputs'] = {
    locks: lockPaths.flatMap((p, i) =>
      lockTexts[i] ? [{ path: p, text: lockTexts[i] as string }] : [],
    ),
    sboms: sbomPaths.flatMap((p, i) =>
      sbomTexts[i] ? [{ path: p, text: sbomTexts[i] as string }] : [],
    ),
  };
  for (const [i, p] of lockPaths.entries())
    if (lockTexts[i] === undefined)
      b.diag(
        'info',
        'lockfile_unreadable',
        `could not read ${p} (missing, too large or a network error); versions it would resolve stay unresolved`,
      );

  // ---- readme -------------------------------------------------------------------------------
  if (readmeRes !== undefined || treeRes) {
    const ru = { url: url('/readme'), ...cap };
    b.add('docs.readme.present', readmeRes !== undefined, ru);
    if (readmeRes !== undefined) {
      const r = analyzeReadme(readmeRes);
      b.add('docs.readme.length_chars', r.lengthChars, ru);
      b.add('docs.readme.has_install', r.hasInstall, { ...ru, kind: 'heuristic', confidence: 0.8 });
      b.add('docs.readme.has_usage', r.hasUsage, { ...ru, kind: 'heuristic', confidence: 0.8 });
      b.add('docs.readme.has_config_docs', r.hasConfigDocs, {
        ...ru,
        kind: 'heuristic',
        confidence: 0.7,
      });
      b.add('docs.readme.has_deploy_docs', r.hasDeployDocs, {
        ...ru,
        kind: 'heuristic',
        confidence: 0.7,
      });
      b.add('docs.readme.code_block_count', r.codeBlockCount, ru);
      b.add('docs.readme.purpose_statement', !!r.purposeStatement, {
        ...ru,
        kind: 'heuristic',
        confidence: 0.6,
      });
      if (treeRes) {
        b.add(
          'heuristic.substance.readme_heavy',
          r.lengthChars >= 6000 && tree.sourceFileCount <= 5 && tree.testFileCount === 0,
          {
            source: 'heuristic',
            kind: 'heuristic',
            confidence: 0.5 * (truncated ? 0.6 : 1),
            metadata: { readme_chars: r.lengthChars, source_files: tree.sourceFileCount },
          },
        );
      }
    }
  }

  // ---- contributors / bus factor ------------------------------------------------------------
  if (contribRes) {
    const people = contribRes.data.filter(
      (c) => c.type !== 'Bot' && !/\[bot\]$/i.test(c.login ?? ''),
    );
    const total = sum(people, (c) => c.contributions);
    const cu = {
      url: url('/contributors'),
      ...cap,
      confidence: contribRes.data.length >= 100 ? 0.8 : 1,
      metadata: { capped_at_100: contribRes.data.length >= 100 },
    };
    b.add('github.contributors.count', people.length, cu);
    if (total > 0) {
      const sorted = [...people].sort((a, c) => c.contributions - a.contributions);
      b.add('github.contributors.top_share', round((sorted[0]?.contributions ?? 0) / total, 3), cu);
      let acc = 0;
      let n = 0;
      for (const c of sorted) {
        acc += c.contributions;
        n++;
        if (acc / total >= 0.5) break;
      }
      b.add('github.contributors.bus_factor', n, {
        ...cu,
        kind: 'heuristic',
        confidence: cu.confidence * 0.8,
      });
    }
  }

  // ---- commits ------------------------------------------------------------------------------
  if (commitsRes) {
    const commits = commitsRes.data;
    const cu = { url: url('/commits'), ...cap };
    if (commits.length > 0) {
      const lastDate = commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date;
      if (lastDate)
        b.add(
          'github.commits.last_commit_age_days',
          round(daysBetween(now, new Date(lastDate)), 1),
          cu,
        );
      const in90 = commits.filter((c) => {
        const d = c.commit?.committer?.date ?? c.commit?.author?.date;
        return d ? daysBetween(now, new Date(d)) <= 90 : false;
      }).length;
      const capped = commits.length >= 100 && in90 === commits.length;
      b.add('github.commits.recent_count_90d', in90, {
        ...cu,
        confidence: capped ? 0.8 : 1,
        metadata: { capped },
      });
      const authors = new Set(
        commits.map(
          (c) => c.author?.login ?? c.commit?.author?.email ?? c.commit?.author?.name ?? '?',
        ),
      );
      b.add('github.commits.distinct_authors_sampled', authors.size, {
        ...cu,
        metadata: { sample_size: commits.length },
      });
    } else {
      b.add('github.commits.recent_count_90d', 0, cu);
    }
  }
  if (totalRes) {
    const link = totalRes.headers.get('link') ?? '';
    const last = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
    if (link && !last) {
      // Paginated but the page count is unreadable: unknown, never "1".
      b.diag(
        'warn',
        'commit_count_unparsed',
        'could not read the total commit count from the Link header',
        ['github.commits.total'],
      );
    } else {
      const total = last ? Number(last[1]) : totalRes.data.length;
      b.add('github.commits.total', total, { url: url('/commits?per_page=1'), ...cap });
    }
  }

  // ---- releases -----------------------------------------------------------------------------
  if (releasesRes) {
    const rels = releasesRes.data.filter((r) => !r.draft && r.published_at);
    const tagsN = tagsRes?.data.length ?? 0;
    const ru = { url: url('/releases'), ...cap };
    b.add('github.releases.has_any', rels.length > 0 || tagsN > 0, {
      ...ru,
      metadata: { releases: rels.length, has_tags: tagsN > 0 },
    });
    if (rels.length > 0) {
      const dates = rels
        .map((r) => new Date(r.published_at as string))
        .sort((a, c) => c.getTime() - a.getTime());
      b.add('github.releases.latest_age_days', round(daysBetween(now, dates[0] as Date), 1), ru);
      if (dates.length >= 3) {
        const gaps: number[] = [];
        for (let i = 0; i < Math.min(dates.length - 1, 10); i++)
          gaps.push(daysBetween(dates[i] as Date, dates[i + 1] as Date));
        b.add('github.releases.median_gap_days', round(median(gaps) ?? 0, 1), {
          ...ru,
          confidence: Math.min(1, dates.length / 6),
        });
      }
      const assets = rels.slice(0, 5).flatMap((r) => (r.assets ?? []).map((a) => a.name ?? ''));
      if (assets.length > 0) {
        b.add(
          'github.releases.signed_assets',
          assets.some((n) =>
            /\.(?:sig|asc|pem|minisig|sigstore(?:\.json)?)$|\.intoto\.jsonl$|\.bundle$/i.test(n),
          ),
          ru,
        );
        b.add(
          'github.releases.provenance_assets',
          assets.some((n) => /\.intoto\.jsonl$|provenance|attestation/i.test(n)),
          ru,
        );
        b.add(
          'github.releases.sbom_assets',
          assets.some((n) => /sbom|\.spdx|cyclonedx|\.cdx\./i.test(n)),
          ru,
        );
      } else {
        b.diag(
          'info',
          'no_release_assets',
          'recent releases have no assets; signature/provenance asset checks skipped',
        );
      }
    }
  }

  // ---- issues / PR responsiveness (sampled) -------------------------------------------------
  if (issuesRes) {
    const issues = issuesRes.data.filter((i) => !i.pull_request);
    summarizeItems(b, 'issues', issues, now, url('/issues'), cap.ref);
  }
  if (pullsRes) summarizeItems(b, 'pulls', pullsRes.data, now, url('/pulls'), cap.ref);

  if (branchRes && typeof branchRes.data.protected === 'boolean') {
    b.add('github.branch.default_protected', branchRes.data.protected, {
      url: url(`/branches/${branch}`),
      ...cap,
      confidence: 0.9,
    });
  }

  // ---- static scan files (fetched as text, never executed) ----------------------------------
  const files: ScannedFile[] = [];
  const fetchStats = { skippedTooLarge: 0, skippedOverBudget: 0 };
  const doScan = options.scan !== false;
  if (doScan) {
    wfPaths.forEach((p, i) => {
      const t = wfTexts[i];
      if (t) files.push({ path: p, content: t, size: t.length, role: 'workflow' });
    });
    manifestPaths.forEach((p, i) => {
      const t = manifestTexts[i];
      if (t) files.push({ path: p, content: t, size: t.length, role: 'manifest' });
    });
    let totalBytes = files.reduce((a, f) => a + f.size, 0);
    let failed = 0;
    const known = new Set(files.map((f) => f.path));
    const quietFetch = async (path: string, role: FileRole): Promise<void> => {
      if (known.has(path)) return;
      known.add(path);
      if (
        files.length >= LIMITS.maxScanFiles + wfPaths.length + manifestPaths.length ||
        totalBytes >= LIMITS.maxScanTotalBytes
      ) {
        fetchStats.skippedOverBudget++;
        return;
      }
      try {
        const u = `${RAW}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${encodeURIComponent(refStr)}/${path.split('/').map(encodeURIComponent).join('/')}`;
        const r = await http.request(u, { maxBytes: LIMITS.maxScanFileBytes });
        if (r.status === 200) {
          totalBytes += r.body.length;
          files.push({ path, content: r.body, size: r.body.length, role });
        } else {
          failed++;
        }
      } catch (e) {
        if (e instanceof TooLargeError) fetchStats.skippedTooLarge++;
        else failed++;
      }
    };
    const selection = selectScanCandidates(entries, manifests);
    fetchStats.skippedTooLarge += selection.skippedTooLarge;
    const budget = LIMITS.maxScanFiles;
    const first = selection.candidates.slice(0, budget);
    fetchStats.skippedOverBudget += Math.max(0, selection.candidates.length - budget);
    await pool(first, 5, (c) => quietFetch(c.path, c.role));
    for (let round = 0; round < LIMITS.maxRefRounds; round++) {
      const next = nextRefCandidates(
        files.filter((f) => f.role !== 'workflow' && f.role !== 'manifest'),
        entries,
        known,
      );
      fetchStats.skippedTooLarge += next.skippedTooLarge;
      if (next.paths.length === 0) break;
      await pool(next.paths, 5, (p) => quietFetch(p, 'ref'));
    }
    if (failed > 0)
      b.diag('warn', 'scan_fetch_failed', `${failed} scan file(s) could not be fetched`);
  }

  const snapshot = {
    owner: ref.owner,
    repo: ref.repo,
    displayName: repo.name,
    topics: repo.topics ?? [],
    treePaths: entries
      .filter((e) => e.type === 'blob')
      .map((e) => e.path)
      .slice(0, 5000),
    manifests,
    hasDockerfile: tree.flags.dockerfile,
    hasActionYml: tree.flags.action_yml,
    defaultBranch: branch,
    htmlUrl: repo.html_url,
    ...(repo.description ? { description: repo.description } : {}),
    ...(repo.language ? { language: repo.language } : {}),
    ...(readmeRes !== undefined ? { readme: readmeRes } : {}),
    ...(headSha ? { ref: headSha } : {}),
  };
  return {
    evidence: b.evidence,
    diagnostics: b.diagnostics,
    snapshot,
    depInputs,
    files,
    allTreePaths: entries
      .filter((e) => e.type === 'blob')
      .map((e) => e.path)
      .slice(0, 100_000),
    sourceFileCount: tree.sourceFileCount,
    fetchStats,
    scanned: doScan,
  };
}

interface CommunityProfile {
  files?: Record<string, unknown>;
}
interface GhRelease {
  draft?: boolean;
  published_at?: string | null;
  assets?: { name?: string }[];
}
interface GhCommit {
  sha?: string;
  author?: { login?: string } | null;
  commit?: {
    author?: { name?: string; email?: string; date?: string };
    committer?: { date?: string };
  };
}
interface GhIssue {
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}
type GhPull = GhIssue;

function summarizeItems(
  b: EvidenceBuilder,
  kind: 'issues' | 'pulls',
  items: GhIssue[],
  now: Date,
  url: string,
  ref: string,
): void {
  const base = { url, ref };
  const closed = items.filter((i) => i.state === 'closed' && i.closed_at);
  const open = items.filter((i) => i.state === 'open');
  b.add(`github.${kind}.sample_size`, items.length, base);
  if (closed.length >= 3) {
    const days = closed.map((i) =>
      daysBetween(new Date(i.closed_at as string), new Date(i.created_at)),
    );
    b.add(`github.${kind}.median_days_to_close`, round(median(days) ?? 0, 1), {
      ...base,
      confidence: Math.min(1, closed.length / 20) * 0.9,
      metadata: { closed_in_sample: closed.length, sample: 'most recently updated 100' },
    });
  }
  if (open.length >= 3) {
    const stale = open.filter((i) => daysBetween(now, new Date(i.updated_at)) > STALE_DAYS).length;
    b.add(`github.${kind}.stale_open_ratio`, round(stale / open.length, 3), {
      ...base,
      confidence: Math.min(1, open.length / 20) * 0.9,
      metadata: { open_in_sample: open.length, stale_after_days: STALE_DAYS },
    });
  }
}

// Manifests under these directories are almost always private tooling, not what dependents install.
const AUXILIARY_DIR =
  /(?:^|\/)(?:examples?|docs?|website|test|tests|tools|scripts|benchmarks?|e2e|fixtures?)\//i;

export function pickManifests(paths: string[]): string[] {
  // Root manifest first (most representative), then published-looking workspace packages before auxiliary ones.
  const rank = (p: string): number => (p.includes('/') ? (AUXILIARY_DIR.test(p) ? 2 : 1) : 0);
  return [...paths].sort(
    (a, c) => rank(a) - rank(c) || a.split('/').length - c.split('/').length || (a < c ? -1 : 1),
  );
}

function sum<T>(xs: T[], f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
