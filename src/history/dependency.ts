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
  | 'introduced_again_other_line'
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
  introduced_with_manifest_creation?: boolean;
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
    parent_blob_fetches: number;
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
    changed = 0,
    parentBlobFetches = 0;
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
        parent_blob_fetches: 0,
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
  let oldestAddedWithoutRename = false;
  let oldestRename: RenameObservation | undefined;
  let oldestPreviousText: string | undefined;
  const oldest = ordered[0];
  if (oldest?.sha) {
    const detail = await request<{ files?: { status?: string; previous_filename?: string }[] }>(
      `/commits/${encodeURIComponent(oldest.sha)}`,
    );
    const file = detail?.files?.find((f) => f.previous_filename || f.status === 'added');
    if (file?.status === 'renamed' && file.previous_filename)
      oldestRename = {
        state: 'confirmed_rename',
        path: input.path,
        previous_filename: file.previous_filename,
        commit_sha: oldest.sha,
      };
    if (oldestRename && oldest.parents?.[0]?.sha) {
      const previousBody = await request<{ content?: string; encoding?: string }>(
        `/contents/${oldestRename.previous_filename!.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(oldest.parents[0].sha)}`,
        Math.min(512 * 1024, b.maxBytes),
      );
      if (previousBody?.content && previousBody.encoding === 'base64')
        oldestPreviousText = Buffer.from(
          previousBody.content.replace(/\s/g, ''),
          'base64',
        ).toString('utf8');
    } else if (file?.status === 'added') oldestAddedWithoutRename = true;
  }
  const states = new Map<string, State>();
  const parentStates = new Map<string, State>();
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
    const parent = c.parents?.[0]?.sha;
    if (c.sha === oldest?.sha && oldestPreviousText !== undefined)
      for (const n of input.names)
        parentStates.set(
          `${c.sha}\0${n.toLowerCase()}`,
          stateFor(input.path, oldestPreviousText, n),
        );
    if (oldestPreviousText !== undefined && c.sha === oldest?.sha) {
      // The parent file was read under the API-reported previous filename above.
    } else if (parent && !states.has(`${parent}\0${input.names[0]?.toLowerCase() ?? ''}`)) {
      const parentBody = await request<{ content?: string; encoding?: string; sha?: string }>(
        `/contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(parent)}`,
        Math.min(512 * 1024, b.maxBytes),
      );
      parentBlobFetches++;
      if (parentBody?.content && parentBody.encoding === 'base64') {
        const parentRaw = Buffer.from(parentBody.content.replace(/\s/g, ''), 'base64').toString(
          'utf8',
        );
        for (const n of input.names)
          parentStates.set(`${c.sha}\0${n.toLowerCase()}`, stateFor(input.path, parentRaw, n));
      } else
        for (const n of input.names)
          parentStates.set(`${c.sha}\0${n.toLowerCase()}`, {
            state: 'unknown',
            parents: [],
            evidence: [`history:${input.path}:${parent}`],
          });
    } else
      for (const n of input.names)
        parentStates.set(
          `${c.sha}\0${n.toLowerCase()}`,
          states.get(`${parent ?? ''}\0${n.toLowerCase()}`) ?? {
            state: 'unknown',
            parents: [],
            evidence: [],
          },
        );
    if ((c.parents?.length ?? 0) > 1) {
      for (const extra of c.parents!.slice(1)) {
        const extraBody = await request<{ content?: string; encoding?: string }>(
          `/contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(extra.sha ?? '')}`,
          Math.min(512 * 1024, b.maxBytes),
        );
        parentBlobFetches++;
        for (const n of input.names) {
          const key = `${c.sha}\0${n.toLowerCase()}`;
          const old = parentStates.get(key);
          if (extraBody?.content && extraBody.encoding === 'base64') {
            const extraState = stateFor(
              input.path,
              Buffer.from(extraBody.content.replace(/\s/g, ''), 'base64').toString('utf8'),
              n,
            );
            if (extraState.state === 'present') parentStates.set(key, extraState);
            else if (!old) parentStates.set(key, extraState);
          } else if (!old) parentStates.set(key, { state: 'unknown', parents: [], evidence: [] });
        }
      }
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
    introduced_with_manifest_creation: oldestAddedWithoutRename,
  }));
  for (const e of entries) if (oldestRename) e.renames = [oldestRename];
  for (const e of entries) {
    let first: DependencyHistoryEvent | undefined;
    let removed = false;
    const transitions: Array<{
      c: CommitRow;
      current: State;
      parent: State;
      kind: HistoryEventKind;
    }> = [];
    for (const c of ordered.sort(
      (a, b) =>
        (date(a) ?? '').localeCompare(date(b) ?? '') || (a.sha ?? '').localeCompare(b.sha ?? ''),
    )) {
      if (!c.sha) continue;
      const s = states.get(`${c.sha}\0${e.dependency_id.toLowerCase()}`) ?? {
        state: 'unknown',
        parents: [],
        evidence: [],
      };
      const parent = parentStates.get(`${c.sha}\0${e.dependency_id.toLowerCase()}`) ?? {
        state: 'unknown',
        parents: [],
        evidence: [],
      };
      if (s.state === 'unknown' || parent.state === 'unknown') continue;
      let kind: HistoryEventKind | undefined;
      const parentPresent = parent.state === 'present';
      if (!c.parents || c.parents.length <= 1) {
        if (!parentPresent && s.state === 'present')
          kind = first
            ? removed
              ? 'reintroduced'
              : 'introduced_again_other_line'
            : e.history_status === 'history_complete'
              ? 'introduced'
              : 'introduced_within_window';
        else if (parentPresent && s.state === 'absent') kind = 'removed';
      } else {
        const anyParentPresent = parentPresent;
        if (s.state === 'present' && !anyParentPresent)
          kind = first ? 'introduced_again_other_line' : 'introduced';
        else if (s.state === 'absent' && anyParentPresent) kind = 'removed';
      }
      if (
        !kind &&
        parent.state === 'present' &&
        s.state === 'present' &&
        (parent.spec !== s.spec ||
          parent.version !== s.version ||
          parent.parents.join('\0') !== s.parents.join('\0'))
      )
        kind =
          parent.parents.join('\0') !== s.parents.join('\0')
            ? 'parent_changed'
            : parent.version !== s.version
              ? 'version_changed'
              : 'spec_changed';
      if (kind) transitions.push({ c, current: s, parent, kind });
      if (kind) {
        const ev: DependencyHistoryEvent = {
          kind,
          commit_sha: c.sha,
          timestamp: date(c),
          evidence_ids: [...s.evidence, `history:${input.path}:${c.sha}`].slice(0, 8),
          ...(s.spec ? { spec: s.spec } : {}),
          ...(s.version ? { version: s.version } : {}),
          ...(s.parents.length ? { parent_chain: s.parents } : {}),
          ...(kind === 'parent_changed' ? { parent_changed_from: parent.parents } : {}),
        };
        e.events.push(ev);
        if (kind === 'removed') removed = true;
        if (!first && kind !== 'removed') {
          first = ev;
          const cc = ordered.find((x) => x.sha === ev.commit_sha);
          e.author = cc?.author?.login ?? cc?.commit?.author?.name ?? null;
          e.committer = cc?.committer?.login ?? cc?.commit?.committer?.name ?? null;
        }
      }
    }
    if (first?.timestamp) {
      e.introduction = 'known';
      e.introduced_at = { commit_sha: first.commit_sha, timestamp: first.timestamp };
      e.first_introduced_at = e.introduced_at;
      e.evidence_ids = first.evidence_ids;
      e.confidence = e.history_status === 'history_complete' ? 0.85 : 0.55;
      e.introduction_commit_uncertain = e.history_status !== 'history_complete';
      if (e.introduced_with_manifest_creation) {
        e.history_status = 'history_partial';
        e.introduction_commit_uncertain = true;
      }
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
      parent_blob_fetches: parentBlobFetches,
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
    parent_blob_fetches: 0,
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
      parent_blob_fetches: stats.parent_blob_fetches + t.stats.parent_blob_fetches,
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
