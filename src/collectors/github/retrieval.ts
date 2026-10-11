import { extractHints, HINT_FILE_RE, type HintDirs } from './hints.js';
import { isSafeTreePath, type TreeEntry } from './tree.js';

/**
 * Targeted tree retrieval for repositories whose recursive git tree is too large for one response, or which GitHub
 * truncated (kubernetes, linux, nixpkgs, flink...). Instead of raising the size limit forever it runs a bounded, multi-pass,
 * prioritised walk:
 *
 *   root          the root listing
 *   ci_build      CI, build and installer directories (small, decide install/build behaviour)
 *   hinted        directories that workspace/build manifests near the root NAME (workspaces, Cargo members, Gradle includes,
 *                 Maven modules, CMake add_subdirectory, go.work, Makefile.am SUBDIRS, meson subdir)
 *   source_roots  conventional package/source roots (src, packages, crates, cmd, ...)
 *   breadth       everything else, shallow directories first
 *
 * Wide directories (hundreds of sub-directories: drivers/, pkgs/) are not expanded level by level; their children rank low
 * unless a hint names them. Documentation, tests, examples and vendored code rank LOW but are not forbidden; only
 * dependency/VCS/cache directories are never read. Everything is budgeted (requests, nodes, bytes, time, depth, hint reads);
 * an exhausted budget is a visible result (`stopped_by`) and the result is never presented as a complete tree.
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
  /** Small workspace/build manifests read to learn which directories matter. */
  maxHintReads: number;
  /** A directory with more sub-directories than this is "wide": its children are not expanded breadth-first. */
  wideFanout: number;
}

/** Budget for repositories whose recursive tree does not fit: explicit, finite, reported in every result. */
export const DEFAULT_RETRIEVAL_BUDGET: RetrievalBudget = {
  maxRequests: 90,
  maxNodes: 200_000,
  maxBytes: 32 * 1024 * 1024,
  maxMillis: 120_000,
  maxDepth: 4,
  maxHintReads: 16,
  wideFanout: 120,
};

export type StoppedBy =
  'complete' | 'request_budget' | 'node_budget' | 'byte_budget' | 'time_budget';

export const PASS_NAMES = ['root', 'ci_build', 'hinted', 'source_roots', 'breadth'] as const;
export type PassName = (typeof PASS_NAMES)[number];

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
  /** Listings per pass. */
  passes: { name: PassName; directories: number }[];
  /** Hint files read and the directories they named. */
  hints: { files_read: number; directories_named: number; files: string[] };
  /** Known directories that were never eligible (dependency/VCS/cache directories). */
  skipped_by_rule: number;
  /** Directories with more sub-directories than the fan-out limit (their children were deprioritised). */
  wide_directories: string[];
}

/** One non-recursive or recursive tree listing by object sha or ref name. */
export type TreeFetcher = (
  shaOrRef: string,
  recursive: boolean,
) => Promise<{ tree: TreeNode[]; truncated: boolean; bytes: number } | undefined>;

/** Reads a small repository file as text for hints (undefined when absent or unreadable). */
export type HintReader = (path: string) => Promise<string | undefined>;

/** Never read: dependency trees, VCS data, caches and virtual environments. */
const HARD_SKIP =
  /^(?:node_modules|\.git|__pycache__|\.venv|venv|site-packages|\.next|\.cache|\.tox|\.mypy_cache|\.gradle|\.idea|\.vscode)$/i;
/** Readable but ranked low: documentation, tests, examples, generated and vendored code, assets. */
const LOW_DIR =
  /^(?:vendor|third_party|thirdparty|dist|build|target|out|coverage|testdata|fixtures?|tests?|__tests__|e2e|spec|specs|docs?|doc|documentation|examples?|samples?|demo|demos|benchmarks?|bench|assets|images?|img|static|public|locales?|i18n|translations?|data|datasets|generated|gen)$/i;
/** Directories holding build, CI or install logic: listed recursively because they are small and high value. */
const BUILD_DIR =
  /^(?:\.github|\.circleci|\.buildkite|\.gitlab|\.mvn|gradle|buildSrc|build-logic|scripts?|ci|\.ci|tools?|tooling|docker|deploy|deployment|k8s|helm|infra|packaging|dev|bin|tasks?|release|releases?|cmake|\.cargo|hack|contrib|misc)$/i;
/** Directories that usually hold packages, modules or source roots. */
const SOURCE_DIR =
  /^(?:src|source|sources|lib|libs|app|apps|cmd|internal|pkg|packages|crates|modules|plugins|services|projects|components|python|js|ts|go|rust|java|kotlin|main|core|server|client|cli|api|sdk|frontend|backend|web)$/i;

export interface PriorityContext {
  hintExact?: ReadonlySet<string>;
  hintParents?: ReadonlySet<string>;
  /** Directories that lie on the way to a hinted directory (they must be listed to reach it). */
  hintAncestors?: ReadonlySet<string>;
  /** Parents whose children should not be expanded breadth-first. */
  wideParents?: ReadonlySet<string>;
}

const parentOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/** True when a hint names this directory (exactly, or as a direct child of a glob parent). */
export function isHinted(path: string, ctx: PriorityContext): boolean {
  if (ctx.hintExact?.has(path)) return true;
  const parent = path.includes('/') ? parentOf(path) : '';
  return (ctx.hintParents?.has(parent) ?? false) || (ctx.hintAncestors?.has(path) ?? false);
}

/** Higher is read earlier; -1 is never read. Pure and deterministic. */
export function dirPriority(path: string, ctx: PriorityContext = {}): number {
  const parts = path.split('/');
  const name = parts[parts.length - 1] as string;
  if (parts.some((p) => HARD_SKIP.test(p))) return -1;
  const depth = parts.length - 1;
  if (path === '.github' || path === '.github/workflows') return 1000;
  if (BUILD_DIR.test(parts[0] as string) && depth <= 2) return 900 - depth;
  if (isHinted(path, ctx)) return 800 - depth * 10;
  if (BUILD_DIR.test(name)) return 400 - depth * 100;
  // Breadth first: every directory of one level before any directory one level deeper.
  let p = 300 - depth * 100 + (SOURCE_DIR.test(name) ? 40 : 20);
  if (parts.some((x) => LOW_DIR.test(x))) p = Math.min(p, 8 - depth);
  if (ctx.wideParents?.has(parentOf(path))) p -= 250;
  return Math.max(p < 0 ? 1 : p, 1);
}

function passOf(path: string, ctx: PriorityContext): PassName {
  const parts = path.split('/');
  const name = parts[parts.length - 1] as string;
  if (path === '.github' || path === '.github/workflows' || BUILD_DIR.test(parts[0] as string))
    return 'ci_build';
  if (isHinted(path, ctx)) return 'hinted';
  if (SOURCE_DIR.test(name)) return 'source_roots';
  return 'breadth';
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
    readHint?: HintReader;
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
  const passCount = new Map<PassName, number>();
  const hintExact = new Set<string>();
  const hintParents = new Set<string>();
  const hintAncestors = new Set<string>();
  const hintFiles: string[] = [];
  const hintsRead = new Set<string>();
  const wide = new Set<string>();
  const ctx: PriorityContext = { hintExact, hintParents, hintAncestors, wideParents: wide };

  const addEntries = (prefix: string, list: TreeNode[]): void => {
    let subdirs = 0;
    for (const e of list) {
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      // Names come from the repository: traversal segments, backslashes and control characters are never followed.
      if (!isSafeTreePath(path) || hasControlChars(path)) continue;
      if (entries.has(path) || nodes >= budget.maxNodes) continue;
      entries.set(path, { ...e, path });
      nodes++;
      if (e.type === 'tree' && e.sha) {
        known.set(path, e.sha);
        subdirs++;
      }
    }
    if (subdirs > budget.wideFanout) wide.add(prefix);
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

  /** Read workspace/build manifests that appeared in a new listing and learn which directories they name. */
  const learnHints = async (dir: string): Promise<void> => {
    if (!opts.readHint) return;
    if (dir.split('/').filter(Boolean).length > 1) return; // hints near the root only
    const prefix = dir ? `${dir}/` : '';
    const files = [...entries.values()]
      .filter(
        (e) =>
          e.type === 'blob' &&
          e.path.startsWith(prefix) &&
          !e.path.slice(prefix.length).includes('/'),
      )
      .map((e) => e.path)
      .filter((p) => HINT_FILE_RE.test(p.slice(prefix.length)) && !hintsRead.has(p));
    for (const path of files) {
      if (hintsRead.size >= budget.maxHintReads || requests >= budget.maxRequests) return;
      if (now() - started > budget.maxMillis) return;
      hintsRead.add(path);
      requests++;
      let text: string | undefined;
      try {
        text = await opts.readHint(path);
      } catch {
        text = undefined;
      }
      if (text === undefined) continue;
      bytes += text.length;
      const name = path.slice(prefix.length);
      const h: HintDirs = extractHints(name, dir, text);
      if (h.exact.length + h.parents.length > 0) hintFiles.push(path);
      for (const d of [...h.exact, ...h.parents]) {
        const parts = d.split('/');
        for (let i = 1; i < parts.length; i++) hintAncestors.add(parts.slice(0, i).join('/'));
      }
      for (const d of h.exact) hintExact.add(d);
      for (const d of h.parents) hintParents.add(d);
    }
  };

  const bumpPass = (name: PassName): void =>
    void passCount.set(name, (passCount.get(name) ?? 0) + 1);

  const report = (
    complete: boolean,
    unexplored: string[],
    skippedByRule: number,
  ): RetrievalResult => ({
    entries: [...entries.values()],
    report: {
      method: entries.size > 0 ? 'targeted' : 'none',
      complete,
      reason: opts.reason,
      requests,
      nodes,
      bytes,
      explored,
      unexplored: unexplored.slice(0, 25),
      unexplored_count: unexplored.length,
      stopped_by: stopped,
      github_truncated: opts.githubTruncated || sawTruncated,
      failed_requests: failed,
      passes: PASS_NAMES.map((name) => ({ name, directories: passCount.get(name) ?? 0 })).filter(
        (p) => p.directories > 0,
      ),
      hints: {
        files_read: hintsRead.size,
        directories_named: hintExact.size + hintParents.size,
        files: hintFiles.slice(0, 20),
      },
      skipped_by_rule: skippedByRule,
      wide_directories: [...wide].slice(0, 10),
    },
  });

  // Pass 1: the root listing (non-recursive: always small).
  const root = await spend(rootRef, false);
  if (root === undefined || root === 'stop') return report(false, [], 0);
  addEntries('', root.tree);
  explored.push('');
  bumpPass('root');
  await learnHints('');

  const hasChildren = (dir: string): boolean => {
    const prefix = `${dir}/`;
    for (const p of entries.keys()) if (p.startsWith(prefix)) return true;
    return false;
  };
  // Passes 2-5: highest priority first. Priorities are re-evaluated every round because listings teach new hints.
  for (;;) {
    const queue = [...known.entries()]
      .filter(([path]) => !explored.includes(path) && !failedDirs.has(path))
      .map(([path, sha]) => ({
        path,
        sha,
        pr: dirPriority(path, ctx),
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
      bumpPass(passOf(next.path, ctx));
      if (r.truncated) sawTruncated = true;
      addEntries(next.path, r.tree);
      await learnHints(next.path);
    } else {
      failed++;
      failedDirs.add(next.path);
    }
  }

  const all = [...known.keys()].filter((p) => !explored.includes(p) && !hasChildren(p));
  const skippedByRule = all.filter((p) => dirPriority(p, ctx) < 0).length;
  const unexplored = all
    .filter((p) => dirPriority(p, ctx) >= 0)
    .sort((a, b) => dirPriority(b, ctx) - dirPriority(a, ctx) || (a < b ? -1 : 1));
  const complete =
    unexplored.length === 0 &&
    skippedByRule === 0 &&
    !sawTruncated &&
    !opts.githubTruncated &&
    failed === 0;
  return report(complete, unexplored, skippedByRule);
}
