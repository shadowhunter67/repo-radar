import type { Dependency } from '../deps/model.js';
import type { LockIndex } from '../deps/lock.js';
import { parseLock } from '../deps/lock.js';
import { parseManifest, type ParsedManifest } from '../collectors/manifests/parse.js';
import type { HttpClient } from '../util/http.js';
import type { BlobCache } from '../collectors/github/blobcache.js';
import { LIMITS } from '../limits.js';

export const HISTORY_PARSER_VERSION = 'history-parser-v2';
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
export type HistoryEventKind =
  | 'introduced'
  | 'introduced_within_window'
  | 'removed'
  | 'reintroduced'
  | 'spec_changed'
  | 'version_changed'
  | 'parent_changed';
export interface DependencyHistoryEvent {
  kind: HistoryEventKind;
  commit_sha: string;
  timestamp: string | null;
  evidence_ids: string[];
  spec?: string;
  version?: string;
  parent_chain?: string[];
  parent_changed_from?: string[];
}
export interface RenameObservation {
  state: 'confirmed_rename' | 'likely_move' | 'unrelated_new_file' | 'unknown';
  path: string;
  previous_filename?: string;
  commit_sha?: string;
}
export interface DependencyHistoryResult {
  dependency_id: string;
  relationship: 'direct' | 'transitive' | 'unknown';
  introduction: 'known' | 'unknown';
  introduced_at: { commit_sha: string; timestamp: string } | null;
  first_introduced_at?: { commit_sha: string; timestamp: string } | null;
  introduced_via: 'manifest' | 'lockfile' | 'parent_dependency' | 'workspace' | 'unknown';
  evidence_file: string | null;
  evidence_ids: string[];
  author: string | null;
  committer: string | null;
  confidence: number;
  history_status: DependencyHistoryStatus;
  merge_commit: boolean;
  squash_like: boolean;
  squash_like_confidence?: 'likely';
  history_granularity_limited?: boolean;
  introduction_commit_uncertain: boolean;
  events: DependencyHistoryEvent[];
  current_present?: boolean | 'unknown';
  window?: { complete: boolean; commits_scanned: number; oldest_scanned_sha: string | null };
  renames?: RenameObservation[];
  parent_chain?: string[];
  possible_parents?: string[];
  parent_chain_ambiguous?: boolean;
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
  stats?: {
    requests: number;
    commits_scanned: number;
    pages: number;
    blob_cache_hits: number;
    blob_cache_misses: number;
    bytes: number;
    elapsed_ms: number;
    budget_exhausted: boolean;
  };
}
interface CommitRow {
  sha?: string;
  commit?: {
    author?: { name?: string; date?: string };
    committer?: { name?: string; date?: string };
    message?: string;
  };
  author?: { login?: string };
  committer?: { login?: string };
  parents?: { sha?: string }[];
}
interface State {
  state: 'present' | 'absent' | 'unknown';
  spec?: string;
  version?: string;
  parents: string[];
  evidence: string[];
}
const safePath = (p: string): boolean =>
  p.length <= 300 && !p.startsWith('/') && !p.includes('..') && /^[\w./@+,-]+$/.test(p);
const date = (c: CommitRow): string | null =>
  c.commit?.committer?.date ?? c.commit?.author?.date ?? null;
const stateFor = (path: string, text: string, name: string): State => {
  try {
    const m = parseManifest(path, text);
    if (m) {
      const all = [
        ...(m.rawDeps ?? []).map((x) => ({ name: x.name, spec: x.spec })),
        ...m.dependencies,
      ];
      const hit = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
      return hit
        ? { state: 'present', spec: hit.spec, parents: [], evidence: [`history:${path}`] }
        : { state: 'absent', parents: [], evidence: [`history:${path}`] };
    }
    if (/(?:lock|sum)$/.test(path)) {
      const l = parseLock(path, text);
      if (!l) return { state: 'unknown', parents: [], evidence: [`history:${path}`] };
      const es = l.entries.filter((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!es.length) return { state: 'absent', parents: [], evidence: [`history:${path}`] };
      const ps = new Set<string>();
      for (const e of es) {
        const a = e.path.split('/');
        for (let i = 0; i < a.length - 1; i++)
          if (a[i] === 'node_modules' && a[i + 1] !== name) ps.add(a[i + 1]!);
      }
      return {
        state: 'present',
        version: es[0]?.version,
        parents: [...ps].sort().slice(0, 16),
        evidence: [`history:${path}`],
      };
    }
  } catch {
    return { state: 'unknown', parents: [], evidence: [`history:${path}`] };
  }
  return { state: 'unknown', parents: [], evidence: [`history:${path}`] };
};
export async function traceManifestHistory(input: {
  http: HttpClient;
  owner: string;
  repo: string;
  ref: string;
  path: string;
  names: string[];
  budget?: Partial<DependencyHistoryBudget>;
  blobCache?: BlobCache;
}): Promise<{
  entries: DependencyHistoryResult[];
  stats: NonNullable<DependencyHistoryCollection['stats']>;
}> {
  const b = { ...DEFAULT_DEPENDENCY_HISTORY_BUDGET, ...input.budget };
  const started = Date.now();
  let requests = 0,
    bytes = 0,
    pages = 0,
    scanned = 0,
    changed = 0;
  let exhausted = false;
  const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const request = async <T>(p: string, max = 1000000): Promise<T | undefined> => {
    if (
      requests >= b.maxRequests ||
      Date.now() - started >= b.maxElapsedMs ||
      bytes >= b.maxBytes
    ) {
      exhausted = true;
      return undefined;
    }
    requests++;
    try {
      const r = await input.http.request(`${base}${p}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        maxBytes: max,
      });
      if (r.status !== 200) return undefined;
      bytes += r.body.length;
      if (bytes > b.maxBytes) {
        exhausted = true;
        return undefined;
      }
      return JSON.parse(r.body) as T;
    } catch {
      return undefined;
    }
  };
  if (!safePath(input.path))
    return {
      entries: input.names.map((n) => ({
        dependency_id: n,
        relationship: 'unknown',
        introduction: 'unknown',
        introduced_at: null,
        introduced_via: 'unknown',
        evidence_file: input.path,
        evidence_ids: [],
        author: null,
        committer: null,
        confidence: 0,
        history_status: 'history_unavailable',
        merge_commit: false,
        squash_like: false,
        introduction_commit_uncertain: true,
        events: [],
        current_present: 'unknown',
      })),
      stats: {
        requests,
        commits_scanned: 0,
        pages,
        blob_cache_hits: 0,
        blob_cache_misses: 0,
        bytes,
        elapsed_ms: Date.now() - started,
        budget_exhausted: false,
      },
    };
  const commits: CommitRow[] = [];
  const ps = Math.min(100, Math.max(1, b.maxCommits));
  for (let page = 1; commits.length < b.maxCommits; page++) {
    const x = await request<CommitRow[]>(
      `/commits?path=${encodeURIComponent(input.path)}&sha=${encodeURIComponent(input.ref)}&per_page=${ps}&page=${page}`,
    );
    pages++;
    if (!x?.length) break;
    commits.push(...x.slice(0, b.maxCommits - commits.length));
    if (x.length < ps) break;
  }
  const ordered = [...commits].reverse();
  const states = new Map<string, State>();
  for (const c of ordered) {
    if (!c.sha || scanned >= b.maxCommits || changed >= b.maxChangedFiles) {
      exhausted = true;
      break;
    }
    const body = await request<{ content?: string; encoding?: string; sha?: string }>(
      `/contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(c.sha)}`,
      Math.min(512 * 1024, b.maxBytes),
    );
    scanned++;
    if (!body?.content || body.encoding !== 'base64') {
      for (const n of input.names)
        states.set(`${c.sha}\0${n.toLowerCase()}`, {
          state: 'unknown',
          parents: [],
          evidence: [`history:${input.path}:${c.sha}`],
        });
      continue;
    }
    const raw = Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
    changed++;
    if (body.sha)
      input.blobCache?.setRevision(
        `${input.owner}/${input.repo}`,
        c.sha,
        input.path,
        body.sha,
        raw,
      );
    for (const n of input.names) {
      const s =
        input.blobCache?.memoParse(
          `${input.owner}/${input.repo}`,
          body.sha,
          `history:${input.path}:${n}`,
          HISTORY_PARSER_VERSION,
          () => stateFor(input.path, raw, n),
        ) ?? stateFor(input.path, raw, n);
      states.set(`${c.sha}\0${n.toLowerCase()}`, s);
    }
  }
  const entries: DependencyHistoryResult[] = input.names.map((n) => ({
    dependency_id: n,
    relationship: 'unknown',
    introduction: 'unknown',
    introduced_at: null,
    first_introduced_at: null,
    introduced_via: 'unknown',
    evidence_file: input.path,
    evidence_ids: [],
    author: null,
    committer: null,
    confidence: 0,
    history_status: exhausted
      ? 'history_budget_exhausted'
      : commits.length < b.maxCommits
        ? 'history_complete'
        : 'history_partial',
    merge_commit: false,
    squash_like: false,
    introduction_commit_uncertain: true,
    events: [],
    current_present: 'unknown',
    window: {
      complete: commits.length < b.maxCommits && !exhausted,
      commits_scanned: scanned,
      oldest_scanned_sha: ordered[0]?.sha ?? null,
    },
    renames: [],
  }));
  for (const e of entries) {
    let prev: State = { state: 'absent', parents: [], evidence: [] };
    let first: DependencyHistoryEvent | undefined;
    for (const c of ordered) {
      if (!c.sha) continue;
      const s = states.get(`${c.sha}\0${e.dependency_id.toLowerCase()}`) ?? {
        state: 'unknown',
        parents: [],
        evidence: [],
      };
      if (s.state === 'unknown') {
        prev = s;
        continue;
      }
      let kind: HistoryEventKind | undefined;
      if (prev.state !== 'present' && s.state === 'present')
        kind = first
          ? 'reintroduced'
          : e.history_status === 'history_complete'
            ? 'introduced'
            : 'introduced_within_window';
      else if (prev.state === 'present' && s.state === 'absent') kind = 'removed';
      else if (
        prev.state === 'present' &&
        s.state === 'present' &&
        (prev.spec !== s.spec ||
          prev.version !== s.version ||
          prev.parents.join('\0') !== s.parents.join('\0'))
      )
        kind =
          prev.parents.join('\0') !== s.parents.join('\0')
            ? 'parent_changed'
            : prev.version !== s.version
              ? 'version_changed'
              : 'spec_changed';
      if (kind) {
        const ev: DependencyHistoryEvent = {
          kind,
          commit_sha: c.sha,
          timestamp: date(c),
          evidence_ids: [...s.evidence, `history:${input.path}:${c.sha}`].slice(0, 8),
          ...(s.spec ? { spec: s.spec } : {}),
          ...(s.version ? { version: s.version } : {}),
          ...(s.parents.length ? { parent_chain: s.parents } : {}),
          ...(kind === 'parent_changed' ? { parent_changed_from: prev.parents } : {}),
        };
        e.events.push(ev);
        if (!first && kind !== 'removed') {
          first = ev;
          const cc = ordered.find((x) => x.sha === ev.commit_sha);
          e.author = cc?.author?.login ?? cc?.commit?.author?.name ?? null;
          e.committer = cc?.committer?.login ?? cc?.commit?.committer?.name ?? null;
        }
      }
      prev = s;
    }
    if (first?.timestamp) {
      e.introduction = 'known';
      e.introduced_at = { commit_sha: first.commit_sha, timestamp: first.timestamp };
      e.first_introduced_at = e.introduced_at;
      e.evidence_ids = first.evidence_ids;
      e.confidence = e.history_status === 'history_complete' ? 0.85 : 0.55;
      e.introduction_commit_uncertain = e.history_status !== 'history_complete';
      e.merge_commit = (ordered.find((c) => c.sha === first!.commit_sha)?.parents?.length ?? 0) > 1;
    }
    const last = ordered.at(-1);
    e.current_present = last?.sha
      ? states.get(`${last.sha}\0${e.dependency_id.toLowerCase()}`)?.state === 'present'
      : 'unknown';
  }
  return {
    entries,
    stats: {
      requests,
      commits_scanned: scanned,
      pages,
      blob_cache_hits: input.blobCache?.hits ?? 0,
      blob_cache_misses: input.blobCache?.misses ?? 0,
      bytes,
      elapsed_ms: Date.now() - started,
      budget_exhausted: exhausted,
    },
  };
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
  const b = { ...DEFAULT_DEPENDENCY_HISTORY_BUDGET, ...input.budget };
  const selected = input.dependencies.slice(0, b.maxCandidates);
  const groups = new Map<string, Dependency[]>();
  for (const d of selected) {
    const p = d.direct ? d.manifest_path : (d.lockfile_path ?? d.manifest_path);
    if (p) groups.set(p, [...(groups.get(p) ?? []), d]);
  }
  const entries: DependencyHistoryResult[] = [];
  let stats = {
    requests: 0,
    commits_scanned: 0,
    pages: 0,
    blob_cache_hits: 0,
    blob_cache_misses: 0,
    bytes: 0,
    elapsed_ms: 0,
    budget_exhausted: false,
  };
  for (const [p, ds] of groups) {
    const t = await traceManifestHistory({
      ...input,
      path: p,
      names: ds.map((d) => d.package.name),
      budget: b,
    });
    stats = {
      requests: stats.requests + t.stats.requests,
      commits_scanned: stats.commits_scanned + t.stats.commits_scanned,
      pages: stats.pages + t.stats.pages,
      blob_cache_hits: t.stats.blob_cache_hits,
      blob_cache_misses: t.stats.blob_cache_misses,
      bytes: stats.bytes + t.stats.bytes,
      elapsed_ms: stats.elapsed_ms + t.stats.elapsed_ms,
      budget_exhausted: stats.budget_exhausted || t.stats.budget_exhausted,
    };
    for (const e of t.entries) {
      const d = ds.find((x) => x.package.name === e.dependency_id);
      if (d) {
        e.dependency_id = d.id;
        e.relationship =
          d.direct === true ? 'direct' : d.direct === false ? 'transitive' : 'unknown';
        e.introduced_via = d.direct ? 'manifest' : 'lockfile';
      }
      entries.push(e);
    }
  }
  const known = entries.filter((e) => e.introduction === 'known').length;
  return {
    entries,
    coverage: {
      candidates: input.dependencies.length,
      analyzed: selected.length,
      resolved: known,
      uncertain: entries.filter((e) => e.introduction_commit_uncertain).length,
      skipped_by_budget: Math.max(0, input.dependencies.length - selected.length),
    },
    limits_hit: selected.length < input.dependencies.length ? ['history_candidates'] : [],
    stats,
  };
}
