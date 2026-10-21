import type { Dependency } from '../deps/model.js';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import type { LockIndex } from '../deps/lock.js';
import type { HttpClient } from '../util/http.js';
import type { BlobCache } from '../collectors/github/blobcache.js';
import { LIMITS } from '../limits.js';

export interface DependencyHistoryBudget {
  maxCandidates: number;
  maxCommits: number;
  maxRequests: number;
  maxElapsedMs: number;
  maxChangedFiles: number;
  maxBytes: number;
}

export const DEFAULT_DEPENDENCY_HISTORY_BUDGET: DependencyHistoryBudget = {
  maxCandidates: LIMITS.maxDependencyHistoryCandidates,
  maxCommits: LIMITS.maxDependencyHistoryCommits,
  maxRequests: LIMITS.maxDependencyHistoryRequests,
  maxElapsedMs: LIMITS.maxDependencyHistoryMs,
  maxChangedFiles: LIMITS.maxDependencyHistoryChangedFiles,
  maxBytes: LIMITS.maxDependencyHistoryBytes,
};

export type DependencyHistoryStatus =
  'history_complete' | 'history_partial' | 'history_budget_exhausted' | 'history_unavailable';

export interface DependencyHistoryResult {
  dependency_id: string;
  introduction: 'known' | 'unknown';
  introduced_at: { commit_sha: string; timestamp: string } | null;
  introduced_via: 'manifest' | 'lockfile' | 'parent_dependency' | 'workspace' | 'unknown';
  evidence_file: string | null;
  evidence_ids: string[];
  author: string | null;
  committer: string | null;
  confidence: number;
  history_status: DependencyHistoryStatus;
  merge_commit: boolean;
  squash_like: boolean;
  introduction_commit_uncertain: boolean;
}

export interface DependencyHistoryCollection {
  entries: DependencyHistoryResult[];
  coverage: {
    candidates: number;
    analyzed: number;
    resolved: number;
    uncertain: number;
    skipped_by_budget: number;
  };
  limits_hit: string[];
}

interface CommitRow {
  sha?: string;
  commit?: {
    author?: { name?: string; date?: string };
    committer?: { name?: string; date?: string };
  };
  author?: { login?: string };
  committer?: { login?: string };
  parents?: { sha?: string }[];
}

const safePath = (path: string): boolean =>
  path.length <= 300 && !path.startsWith('/') && !path.includes('..') && /^[\w./@+,-]+$/.test(path);

function present(content: string, path: string, d: Dependency): boolean {
  if (path.endsWith('.json')) {
    try {
      const value = JSON.parse(content) as Record<string, unknown>;
      const direct = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ];
      return direct.some((section) => {
        const group = value[section];
        return (
          !!group &&
          typeof group === 'object' &&
          d.package.name in (group as Record<string, unknown>)
        );
      });
    } catch {
      return false;
    }
  }
  if (path.endsWith('.lock') || path.endsWith('.lockfile') || path.endsWith('.sum'))
    return new RegExp(
      `(?:^|["'\\s/])${d.package.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:["'@\\s/:])`,
    ).test(content);
  const escaped = d.package.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|["'\\s])${escaped}(?:["'\\s:=])`).test(content);
}

export async function collectDependencyHistory(input: {
  http: HttpClient;
  owner: string;
  repo: string;
  ref: string;
  dependencies: Dependency[];
  manifests: ParsedManifest[];
  locks: LockIndex[] | { path: string; text: string }[];
  blobCache?: BlobCache;
  budget?: Partial<DependencyHistoryBudget>;
}): Promise<DependencyHistoryCollection> {
  const budget = { ...DEFAULT_DEPENDENCY_HISTORY_BUDGET, ...input.budget };
  const started = Date.now();
  const selected = input.dependencies.slice(0, budget.maxCandidates);
  const entries: DependencyHistoryResult[] = [];
  let requests = 0;
  let commitsRead = 0;
  let bytes = 0;
  let changedFiles = 0;
  const limits = selected.length < input.dependencies.length ? ['history_candidates'] : [];
  const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const requestJson = async <T>(path: string, maxBytes = 1_000_000): Promise<T | undefined> => {
    if (requests >= budget.maxRequests || Date.now() - started >= budget.maxElapsedMs)
      return undefined;
    requests++;
    try {
      const response = await input.http.request(`${base}${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        maxBytes,
      });
      if (response.status !== 200) return undefined;
      bytes += response.body.length;
      if (bytes > budget.maxBytes) return undefined;
      return JSON.parse(response.body) as T;
    } catch {
      return undefined;
    }
  };
  for (const d of selected) {
    const path = d.direct ? d.manifest_path : (d.lockfile_path ?? d.manifest_path);
    if (!path || !safePath(path)) {
      entries.push({
        dependency_id: d.id,
        introduction: 'unknown',
        introduced_at: null,
        introduced_via: 'unknown',
        evidence_file: null,
        evidence_ids: [],
        author: null,
        committer: null,
        confidence: 0,
        history_status: 'history_unavailable',
        merge_commit: false,
        squash_like: false,
        introduction_commit_uncertain: true,
      });
      continue;
    }
    const commits = await requestJson<CommitRow[]>(
      `/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(input.ref)}&per_page=${Math.min(100, budget.maxCommits)}`,
    );
    if (!commits) {
      entries.push({
        dependency_id: d.id,
        introduction: 'unknown',
        introduced_at: null,
        introduced_via: 'unknown',
        evidence_file: path,
        evidence_ids: [`history:${path}`],
        author: null,
        committer: null,
        confidence: 0,
        history_status:
          requests >= budget.maxRequests ? 'history_budget_exhausted' : 'history_unavailable',
        merge_commit: false,
        squash_like: false,
        introduction_commit_uncertain: true,
      });
      continue;
    }
    let found: { commit: CommitRow; timestamp: string; merge: boolean } | undefined;
    for (const commit of [...commits].reverse().slice(0, budget.maxCommits)) {
      if (!commit.sha || !commit.commit?.committer?.date || commitsRead >= budget.maxCommits) break;
      commitsRead++;
      const body = await requestJson<{ content?: string; encoding?: string; sha?: string }>(
        `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(commit.sha)}`,
        Math.min(512 * 1024, budget.maxBytes),
      );
      if (!body?.content || body.encoding !== 'base64') continue;
      const raw = Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
      changedFiles++;
      if (changedFiles > budget.maxChangedFiles) break;
      if (body.sha)
        input.blobCache?.set(`${input.owner}/${input.repo}@${commit.sha}:${path}`, body.sha, raw);
      if (present(raw, path, d)) {
        found = {
          commit,
          timestamp: commit.commit.committer.date,
          merge: (commit.parents?.length ?? 0) > 1,
        };
        break;
      }
    }
    const status: DependencyHistoryStatus =
      found && commitsRead < budget.maxCommits ? 'history_complete' : 'history_partial';
    entries.push({
      dependency_id: d.id,
      introduction: found ? 'known' : 'unknown',
      introduced_at:
        found?.commit?.sha && found.timestamp
          ? { commit_sha: found.commit.sha, timestamp: found.timestamp }
          : null,
      introduced_via: d.direct ? 'manifest' : 'lockfile',
      evidence_file: path,
      evidence_ids: found?.commit?.sha
        ? [`history:${path}:${found.commit.sha}`]
        : [`history:${path}`],
      author: found?.commit?.author?.login ?? found?.commit?.commit?.author?.name ?? null,
      committer: found?.commit?.committer?.login ?? found?.commit?.commit?.committer?.name ?? null,
      confidence: found ? (status === 'history_complete' ? 0.85 : 0.6) : 0,
      history_status: status,
      merge_commit: found?.merge ?? false,
      squash_like: false,
      introduction_commit_uncertain: !found || status !== 'history_complete',
    });
  }
  const resolved = entries.filter((e) => e.introduction === 'known').length;
  return {
    entries,
    coverage: {
      candidates: input.dependencies.length,
      analyzed: selected.length,
      resolved,
      uncertain: entries.filter((e) => e.introduction_commit_uncertain).length,
      skipped_by_budget: Math.max(0, input.dependencies.length - selected.length),
    },
    limits_hit: limits,
  };
}
