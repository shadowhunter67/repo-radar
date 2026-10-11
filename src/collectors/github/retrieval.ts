import { isSafeTreePath, type TreeEntry } from './tree.js';

/**
 * Targeted tree retrieval for repositories whose recursive git tree is too large for one response, or which GitHub
 * truncated. Instead of raising the size limit forever, a bounded, prioritised walk fetches only the directories that are
 * likely to hold structural evidence (manifests, workflows, build files, source roots) and says exactly what it did not read.
 *
 * Everything is budgeted: requests, tree nodes, bytes and wall-clock time. An exhausted budget is a visible result
 * (`stopped_by`), never a silent truncation, and the result is never presented as a complete tree.
 */
const hasControlChars = (p: string): boolean =>
  [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export interface TreeNode extends TreeEntry {
  sha?: string;
}

export interface RetrievalBudget {
  maxRequests: number;
  maxNodes: number;
  maxBytes: number;
  maxMillis: number;
  /** Do not descend below this directory depth (root entries are depth 0). */
  maxDepth: number;
}

export const DEFAULT_RETRIEVAL_BUDGET: RetrievalBudget = {
  maxRequests: 70,
  maxNodes: 150_000,
  maxBytes: 24 * 1024 * 1024,
  maxMillis: 90_000,
  maxDepth: 3,
};

export type StoppedBy =
  'complete' | 'request_budget' | 'node_budget' | 'byte_budget' | 'time_budget';

export interface TreeRetrieval {
  method: 'recursive' | 'targeted' | 'none';
  /** True only when every directory of the repository was read. A targeted walk is practically never complete. */
  complete: boolean;
  /** Why the plain recursive tree was not enough. */
  reason: 'none' | 'github_truncated' | 'response_too_large' | 'fetch_failed' | 'disabled';
  requests: number;
  nodes: number;
  bytes: number;
  /** Directories that were listed. */
  explored: string[];
  /** Known directories that were NOT listed (priority order, capped). */
  unexplored: string[];
  unexplored_count: number;
  stopped_by: StoppedBy;
  github_truncated: boolean;
  /** Subtree requests that failed (rate limit, network, ...): those directories are unexplored. */
  failed_requests: number;
}

/** One non-recursive or recursive tree listing by object sha or ref name. */
export type TreeFetcher = (
  shaOrRef: string,
  recursive: boolean,
) => Promise<{ tree: TreeNode[]; truncated: boolean; bytes: number } | undefined>;

const SKIP_DIR =
  /^(?:node_modules|vendor|third_party|thirdparty|dist|build|target|out|__pycache__|\.git|\.venv|venv|site-packages|coverage|\.next|\.cache|testdata|fixtures?|tests?|__tests__|e2e|spec|specs|docs?|doc|documentation|examples?|samples?|demo|demos|benchmarks?|bench|assets|images?|img|static|public|locales?|i18n|translations?|data|datasets|\.idea|\.vscode)$/i;
/** Directories holding build, CI or install logic: listed recursively because they are small and high value. */
const BUILD_DIR =
  /^(?:\.github|\.circleci|\.buildkite|\.gitlab|\.mvn|gradle|buildSrc|build-logic|scripts?|ci|\.ci|tools?|tooling|docker|deploy|deployment|k8s|helm|infra|packaging|dev|bin|tasks?|release|releases?)$/i;
/** Directories that usually hold packages, modules or source roots: descended one level at a time. */
const SOURCE_DIR =
  /^(?:src|source|sources|lib|libs|app|apps|cmd|internal|pkg|packages|crates|modules|plugins|services|projects|components|python|js|ts|go|rust|java|kotlin|main|core|server|client|cli|api|sdk|frontend|backend|web)$/i;

/**
 * Higher is read earlier; -1 is never read. Pure and deterministic.
 *
 * CI/build directories come first (they are small and decide install/build behaviour). Everything else is read
 * breadth-first: all directories at one depth before any directory one level deeper, with source-root names ahead of
 * unknown names inside a level. This is what finds the manifests of a repository with many sibling modules (a Maven
 * reactor, a Cargo workspace) before it descends into the source tree of the first module.
 */
export function dirPriority(path: string): number {
  const parts = path.split('/');
  const name = parts[parts.length - 1] as string;
  if (parts.some((p) => SKIP_DIR.test(p))) return -1;
  if (/^.git$/i.test(parts[0] as string)) return -1;
  const depth = parts.length - 1;
  if (path === '.github' || path === '.github/workflows') return 1000;
  if (BUILD_DIR.test(parts[0] as string) && depth <= 2) return 900 - depth;
  if (BUILD_DIR.test(name)) return 400 - depth * 100;
  const tier = SOURCE_DIR.test(name) ? 40 : 20;
  return Math.max(1, 300 - depth * 100 + tier);
}

export interface RetrievalResult {
  entries: TreeNode[];
  report: TreeRetrieval;
}

/**
 * Walk the repository from its root listing. `rootRef` is a branch name or commit sha. `initial` entries (for example
 * a truncated recursive listing) are merged without being fetched again.
 */
export async function retrieveTargeted(
  fetchTree: TreeFetcher,
  rootRef: string,
  budget: RetrievalBudget = DEFAULT_RETRIEVAL_BUDGET,
  opts: {
    initial?: TreeNode[];
    reason: TreeRetrieval['reason'];
    githubTruncated: boolean;
    now?: () => number;
  },
): Promise<RetrievalResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  let requests = 0;
  let nodes = 0;
  let bytes = 0;
  let failed = 0;
  const failedDirs = new Set<string>();
  let stopped: StoppedBy = 'complete';
  let sawTruncated = false;
  const entries = new Map<string, TreeNode>();
  const explored: string[] = [];
  const known = new Map<string, string>(); // directory path -> tree sha, not yet listed

  const addEntries = (prefix: string, list: TreeNode[]): void => {
    for (const e of list) {
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      // Names come from the repository: traversal segments, backslashes and control characters are never followed.
      if (!isSafeTreePath(path) || hasControlChars(path)) continue;
      if (entries.has(path) || nodes >= budget.maxNodes) continue;
      entries.set(path, { ...e, path });
      nodes++;
      if (e.type === 'tree' && e.sha) known.set(path, e.sha);
    }
  };

  for (const e of opts.initial ?? []) {
    entries.set(e.path, e);
    nodes++;
    if (e.type === 'tree' && e.sha) known.set(e.path, e.sha);
  }

  const spend = async (
    sha: string,
    recursive: boolean,
  ): Promise<Awaited<ReturnType<TreeFetcher>> | 'stop'> => {
    if (requests >= budget.maxRequests) {
      stopped = 'request_budget';
      return 'stop';
    }
    if (now() - started > budget.maxMillis) {
      stopped = 'time_budget';
      return 'stop';
    }
    if (bytes >= budget.maxBytes) {
      stopped = 'byte_budget';
      return 'stop';
    }
    if (nodes >= budget.maxNodes) {
      stopped = 'node_budget';
      return 'stop';
    }
    requests++;
    const r = await fetchTree(sha, recursive);
    if (r) bytes += r.bytes;
    return r;
  };

  // Root listing (non-recursive: always small).
  const root = await spend(rootRef, false);
  if (root && root !== 'stop') addEntries('', root.tree);
  else if (root === undefined) {
    return {
      entries: [...entries.values()],
      report: {
        method: entries.size > 0 ? 'targeted' : 'none',
        complete: false,
        reason: opts.reason,
        requests,
        nodes,
        bytes,
        explored,
        unexplored: [],
        unexplored_count: 0,
        stopped_by: stopped,
        github_truncated: opts.githubTruncated,
        failed_requests: failed,
      },
    };
  }
  explored.push('');

  // Prioritised walk. Directories already present in `initial` (as blobs below them) are not fetched again.
  const hasChildren = (dir: string): boolean => {
    const prefix = `${dir}/`;
    for (const p of entries.keys()) if (p.startsWith(prefix)) return true;
    return false;
  };
  for (;;) {
    const queue = [...known.entries()]
      .filter(([path]) => !explored.includes(path) && !failedDirs.has(path))
      .map(([path, sha]) => ({
        path,
        sha,
        pr: dirPriority(path),
        depth: path.split('/').length - 1,
      }))
      .filter((d) => d.pr >= 0 && d.depth <= budget.maxDepth && !hasChildren(d.path))
      .sort((a, b) => b.pr - a.pr || (a.path < b.path ? -1 : 1));
    const next = queue[0];
    if (!next) break;
    const recursive = BUILD_DIR.test(next.path.split('/')[0] as string) && next.depth <= 1;
    const r = await spend(next.sha, recursive);
    if (r === 'stop') break;
    if (r) {
      explored.push(next.path);
      if (r.truncated) sawTruncated = true;
      addEntries(next.path, r.tree);
    } else {
      failed++;
      failedDirs.add(next.path);
    }
  }

  // Everything that is a known directory but was never listed.
  const unexplored = [...known.keys()]
    .filter((p) => !explored.includes(p) && !hasChildren(p))
    .sort((a, b) => dirPriority(b) - dirPriority(a) || (a < b ? -1 : 1));
  const truncatedAny = opts.githubTruncated || sawTruncated;
  const complete = unexplored.length === 0 && !truncatedAny && failed === 0;
  return {
    entries: [...entries.values()],
    report: {
      method: 'targeted',
      complete,
      reason: opts.reason,
      requests,
      nodes,
      bytes,
      explored,
      unexplored: unexplored.slice(0, 25),
      unexplored_count: unexplored.length,
      stopped_by: stopped,
      github_truncated: truncatedAny,
      failed_requests: failed,
    },
  };
}
