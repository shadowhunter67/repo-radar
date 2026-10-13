import { extractHints, HINT_FILE_RE, type HintDirs } from './hints.js';
import { isSafeTreePath, type TreeEntry } from './tree.js';

/**
 * Targeted tree retrieval for repositories whose recursive git tree is too large for one response, or which GitHub
 * truncated (kubernetes, linux, nixpkgs, flink...). Instead of raising the size limit forever it runs a bounded, multi-pass,
 * prioritised walk:
 *
 *   root          the root listing
 *   ci_build      CI, build and installer directories (small, decide install/build behaviour)
 *   hinted        directories that workspace/build manifests NAME (workspaces, Cargo members, Gradle includes, Maven modules,
 *                 CMake add_subdirectory, go.work, Makefile.am SUBDIRS, meson subdir)
 *   declared_deep the same, when the declared path lies deeper than the generic depth budget allows
 *   source_roots  conventional package/source roots (src, packages, crates, cmd, ...)
 *   breadth       everything else, shallow directories first
 *   manifest_seek bounded recursive listings of selected subtrees that keep ONLY manifest and build-definition files
 *
 * Declared paths (retrieval v3). A path that the project's own build files name is followed even when it is deeper than the
 * generic depth budget, but from a SEPARATE budget (`declared`): the generic traversal is not widened, the declared pool is
 * finite, and a declared path is attacker-controlled text (it is normalized, depth-capped, count-capped and must pass the
 * tree path safety check; traversal and absolute paths are counted as rejected and never followed).
 *
 * Manifest seeking (retrieval v3). For directories the walk could not afford to list level by level, one recursive listing
 * of the subtree returns every path in it in a single request. Only manifest and build-definition files are kept (the subtree
 * is not stored), under its own request, subtree and scan budgets. A truncated listing is partial, never complete.
 *
 * Wide directories (hundreds of sub-directories: drivers/, pkgs/) are not expanded level by level; their children rank low
 * unless a hint names them. Documentation, tests, examples and vendored code rank LOW but are not forbidden; only
 * dependency/VCS/cache directories are never read. Everything is budgeted; an exhausted budget is a visible result
 * (`stopped_by`) and the result is never presented as a complete tree.
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
  /** Do not descend below this directory depth (root entries are depth 0). Declared paths have their own depth limit. */
  maxDepth: number;
  /** Small workspace/build manifests read near the root to learn which directories matter. */
  maxHintReads: number;
  /** A directory with more sub-directories than this is "wide": its children are not expanded breadth-first. */
  wideFanout: number;
  /** Paths the project's own build files declare: followed from their own pool, never from the generic one. */
  declared?: Partial<{
    /** Distinct declared directories accepted over the whole walk. */
    maxPaths: number;
    /** Deepest declared directory that is listed (root entries are depth 0). */
    maxDepth: number;
    /** Tree listings and hint-file reads spent on declared paths. */
    maxRequests: number;
    /** Hint files read inside declared directories (deeper than the root). */
    maxHintReads: number;
  }>;
  /** Bounded manifest-seeking pass over subtrees the walk could not list level by level. */
  seek?: Partial<{
    enabled: boolean;
    /** Recursive subtree listings. */
    maxRequests: number;
    maxSubtrees: number;
    /** Tree entries inspected (not kept) across all subtree listings. */
    maxEntriesScanned: number;
  }>;
}

/** A budget with every v3 field filled in (callers written before v3 pass budgets without `declared` / `seek`). */
export interface ResolvedBudget extends Omit<RetrievalBudget, 'declared' | 'seek'> {
  declared: Required<NonNullable<RetrievalBudget['declared']>>;
  seek: Required<NonNullable<RetrievalBudget['seek']>>;
}
const DECLARED_DEFAULTS = { maxPaths: 400, maxDepth: 8, maxRequests: 60, maxHintReads: 24 };
const SEEK_DEFAULTS = {
  enabled: true,
  maxRequests: 24,
  maxSubtrees: 24,
  maxEntriesScanned: 600_000,
};
export function resolveBudget(b: RetrievalBudget): ResolvedBudget {
  return {
    ...b,
    declared: { ...DECLARED_DEFAULTS, ...(b.declared ?? {}) },
    seek: { ...SEEK_DEFAULTS, ...(b.seek ?? {}) },
  };
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
  declared: DECLARED_DEFAULTS,
  seek: SEEK_DEFAULTS,
};

export type StoppedBy =
  'complete' | 'request_budget' | 'node_budget' | 'byte_budget' | 'time_budget';

export const PASS_NAMES = [
  'root',
  'ci_build',
  'hinted',
  'declared_deep',
  'source_roots',
  'breadth',
  'manifest_seek',
] as const;
export type PassName = (typeof PASS_NAMES)[number];

/** File names the seeking pass keeps from a subtree listing. */
export const SEEK_FILE_RE =
  /(?:^|\/)(?:package\.json|pyproject\.toml|setup\.py|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|settings\.gradle(?:\.kts)?|build\.gradle(?:\.kts)?|libs\.versions\.toml|CMakeLists\.txt|meson\.build)$/;

export interface DeclaredPathsReport {
  /** Declared directories accepted (exact paths and glob parents). */
  accepted: number;
  /** Declared directories actually listed. */
  followed: number;
  /** Of those, listed even though they lie deeper than the generic depth budget. */
  deep: number;
  rejected_unsafe: number;
  rejected_depth: number;
  rejected_over_limit: number;
  requests: number;
  stopped_by: 'complete' | 'request_budget' | 'path_limit';
}
export interface ManifestSeekReport {
  enabled: boolean;
  requests: number;
  subtrees: number;
  /** Listings GitHub truncated: the subtree is only partly seen. */
  truncated_subtrees: number;
  /** Listings that failed or were too large to download. */
  failed_subtrees: number;
  manifests_found: number;
  entries_scanned: number;
  stopped_by:
    | 'not_needed'
    | 'complete'
    | 'request_budget'
    | 'subtree_budget'
    | 'scan_budget'
    | 'time_budget'
    | 'byte_budget'
    | 'node_budget'
    | 'disabled';
}

export const EMPTY_DECLARED: DeclaredPathsReport = {
  accepted: 0,
  followed: 0,
  deep: 0,
  rejected_unsafe: 0,
  rejected_depth: 0,
  rejected_over_limit: 0,
  requests: 0,
  stopped_by: 'complete',
};
export const EMPTY_SEEK: ManifestSeekReport = {
  enabled: false,
  requests: 0,
  subtrees: 0,
  truncated_subtrees: 0,
  failed_subtrees: 0,
  manifests_found: 0,
  entries_scanned: 0,
  stopped_by: 'not_needed',
};

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
  declared_paths: DeclaredPathsReport;
  manifest_seek: ManifestSeekReport;
  /** Package manifests in the tree the walk produced, and how many of them were read (the read cap is finite). */
  manifest_paths: { in_tree: number; read: number; cap: number };
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

function passOf(path: string, ctx: PriorityContext, deepLimit: number): PassName {
  const parts = path.split('/');
  const name = parts[parts.length - 1] as string;
  if (path === '.github' || path === '.github/workflows' || BUILD_DIR.test(parts[0] as string))
    return 'ci_build';
  if (isHinted(path, ctx)) return parts.length - 1 > deepLimit ? 'declared_deep' : 'hinted';
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
  budgetIn: RetrievalBudget = DEFAULT_RETRIEVAL_BUDGET,
  opts: {
    initial?: TreeNode[];
    reason: TreeRetrieval['reason'];
    githubTruncated: boolean;
    now?: () => number;
    readHint?: HintReader;
  },
): Promise<RetrievalResult> {
  const budget = resolveBudget(budgetIn);
  const now = opts.now ?? Date.now;
  const started = now();
  /** Requests by pool: generic traversal, declared paths, manifest seeking. */
  const spent = { generic: 0, declared: 0, seek: 0 };
  const requests = (): number => spent.generic + spent.declared + spent.seek;
  let nodes = 0;
  let bytes = 0;
  let failed = 0;
  const failedDirs = new Set<string>();
  let stopped: StoppedBy = 'complete';
  let sawTruncated = false;
  const entries = new Map<string, TreeNode>();
  const explored: string[] = [];
  const exploredSet = new Set<string>();
  const partial = new Set<string>(); // listed recursively but truncated: seen, not complete
  const known = new Map<string, string>(); // directory path -> tree sha, not yet listed
  const passCount = new Map<PassName, number>();
  const hintExact = new Set<string>();
  const hintParents = new Set<string>();
  const hintAncestors = new Set<string>();
  const hintFiles: string[] = [];
  const hintsRead = new Set<string>();
  const wide = new Set<string>();
  const ctx: PriorityContext = { hintExact, hintParents, hintAncestors, wideParents: wide };
  /** Reads `stopped` through a function: closures assign it, which control-flow analysis cannot follow. */
  const stoppedNow = (): StoppedBy => stopped;
  const declared: DeclaredPathsReport = { ...EMPTY_DECLARED };
  const seek: ManifestSeekReport = { ...EMPTY_SEEK, enabled: budget.seek.enabled };
  let declaredHintReads = 0;
  const declaredDeep = budget.declared.maxDepth;

  const isDeclared = (path: string): boolean => isHinted(path, ctx);
  /** Declared directories may be listed deeper than the generic limit, up to the declared limit. */
  const depthLimitOf = (path: string): number =>
    isDeclared(path) ? Math.max(budget.maxDepth, declaredDeep) : budget.maxDepth;

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

  type Pool = 'generic' | 'declared' | 'seek';
  const poolLimit = (pool: Pool): number =>
    pool === 'generic'
      ? budget.maxRequests
      : pool === 'declared'
        ? budget.declared.maxRequests
        : budget.seek.maxRequests;
  const sharedStop = (): StoppedBy | undefined => {
    if (now() - started > budget.maxMillis) return 'time_budget';
    if (bytes >= budget.maxBytes) return 'byte_budget';
    if (nodes >= budget.maxNodes) return 'node_budget';
    return undefined;
  };

  const spend = async (
    sha: string,
    recursive: boolean,
    pool: Pool,
  ): Promise<Awaited<ReturnType<TreeFetcher>> | 'stop'> => {
    if (spent[pool] >= poolLimit(pool)) {
      if (pool === 'generic') stopped = 'request_budget';
      else if (pool === 'declared') declared.stopped_by = 'request_budget';
      return 'stop';
    }
    const s = sharedStop();
    if (s) {
      stopped = s;
      return 'stop';
    }
    spent[pool]++;
    const r = await fetchTree(sha, recursive);
    if (r) bytes += r.bytes;
    return r;
  };

  /** Accept the directories a hint file names: normalized, depth-capped, count-capped. */
  const acceptHints = (h: HintDirs): void => {
    declared.rejected_unsafe += h.rejected;
    for (const [list, set] of [
      [h.exact, hintExact],
      [h.parents, hintParents],
    ] as const)
      for (const d of list) {
        if (set.has(d)) continue;
        if (d.split('/').length - 1 > declaredDeep) {
          declared.rejected_depth++;
          continue;
        }
        if (hintExact.size + hintParents.size >= budget.declared.maxPaths) {
          declared.rejected_over_limit++;
          declared.stopped_by = 'path_limit';
          continue;
        }
        set.add(d);
        const parts = d.split('/');
        for (let i = 1; i < parts.length; i++) hintAncestors.add(parts.slice(0, i).join('/'));
      }
    declared.accepted = hintExact.size + hintParents.size;
  };

  /**
   * Read workspace/build manifests that appeared in a new listing and learn which directories they name. Near the root this
   * uses the generic hint allowance; inside a declared directory it uses the declared pool, so nested workspaces are followed
   * without widening the generic traversal.
   */
  const learnHints = async (dir: string): Promise<void> => {
    if (!opts.readHint) return;
    const depth = dir.split('/').filter(Boolean).length;
    const nearRoot = depth <= 1;
    if (!nearRoot && !isDeclared(dir)) return;
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
      const pool: Pool = nearRoot ? 'generic' : 'declared';
      if (nearRoot) {
        if (hintsRead.size - declaredHintReads >= budget.maxHintReads) return;
      } else if (declaredHintReads >= budget.declared.maxHintReads) return;
      if (spent[pool] >= poolLimit(pool)) return;
      if (now() - started > budget.maxMillis) return;
      hintsRead.add(path);
      if (!nearRoot) declaredHintReads++;
      spent[pool]++;
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
      acceptHints(h);
    }
  };

  const bumpPass = (name: PassName): void =>
    void passCount.set(name, (passCount.get(name) ?? 0) + 1);

  const hasChildren = (dir: string): boolean => {
    const prefix = `${dir}/`;
    for (const p of entries.keys()) if (p.startsWith(prefix)) return true;
    return false;
  };

  const finish = (): RetrievalResult => {
    const all = [...known.keys()].filter(
      (p) => !exploredSet.has(p) && !partial.has(p) && !hasChildren(p),
    );
    const skippedByRule = all.filter((p) => dirPriority(p, ctx) < 0).length;
    const unexplored = all
      .filter((p) => dirPriority(p, ctx) >= 0)
      .sort((a, b) => dirPriority(b, ctx) - dirPriority(a, ctx) || (a < b ? -1 : 1));
    const complete =
      unexplored.length === 0 &&
      skippedByRule === 0 &&
      partial.size === 0 &&
      !sawTruncated &&
      !opts.githubTruncated &&
      failed === 0;
    declared.requests = spent.declared;
    seek.requests = spent.seek;
    // Declared directories still waiting when their pool ran out: say so (the filter above never calls `spend` for them).
    if (
      declared.stopped_by === 'complete' &&
      spent.declared >= budget.declared.maxRequests &&
      [...known.keys()].some(
        (p) =>
          isDeclared(p) &&
          !exploredSet.has(p) &&
          !partial.has(p) &&
          !failedDirs.has(p) &&
          !hasChildren(p) &&
          dirPriority(p, ctx) >= 0,
      )
    )
      declared.stopped_by = 'request_budget';
    return {
      entries: [...entries.values()],
      report: {
        method: entries.size > 0 ? 'targeted' : 'none',
        complete,
        reason: opts.reason,
        requests: requests(),
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
        declared_paths: { ...declared },
        manifest_seek: { ...seek },
        manifest_paths: { in_tree: 0, read: 0, cap: 0 },
      },
    };
  };

  // Pass 1: the root listing (non-recursive: always small).
  const root = await spend(rootRef, false, 'generic');
  if (root === undefined || root === 'stop') return finish();
  addEntries('', root.tree);
  explored.push('');
  exploredSet.add('');
  bumpPass('root');
  await learnHints('');

  // Passes 2-5: highest priority first. Priorities are re-evaluated every round because listings teach new hints.
  for (;;) {
    const genericLeft = spent.generic < budget.maxRequests;
    const queue = [...known.entries()]
      .filter(([path]) => !exploredSet.has(path) && !failedDirs.has(path))
      .map(([path, sha]) => ({
        path,
        sha,
        pr: dirPriority(path, ctx),
        depth: path.split('/').length - 1,
        declared: isDeclared(path),
      }))
      .filter((d) => d.pr >= 0 && d.depth <= depthLimitOf(d.path) && !hasChildren(d.path))
      // A declared directory is paid for from the declared pool; once that is spent only a shallow one (inside the generic
      // depth limit) may fall back to the generic pool. Everything else waits for the seek pass.
      .filter((d) =>
        d.declared
          ? spent.declared < budget.declared.maxRequests ||
            (genericLeft && d.depth <= budget.maxDepth)
          : genericLeft,
      )
      .sort((a, b) => b.pr - a.pr || (a.path < b.path ? -1 : 1));
    const next = queue[0];
    if (!next) break;
    const recursive = BUILD_DIR.test(next.path.split('/')[0] as string) && next.depth <= 1;
    const pool: Pool =
      next.declared && spent.declared < budget.declared.maxRequests ? 'declared' : 'generic';
    const r = await spend(next.sha, recursive, pool);
    if (r === 'stop') break; // a shared limit (time, bytes, nodes) ended the walk: the pools above cannot be empty here
    if (r) {
      explored.push(next.path);
      exploredSet.add(next.path);
      if (next.declared) {
        declared.followed++;
        if (next.depth > budget.maxDepth) declared.deep++;
      }
      bumpPass(passOf(next.path, ctx, budget.maxDepth));
      if (r.truncated) sawTruncated = true;
      addEntries(next.path, r.tree);
      await learnHints(next.path);
    } else {
      failed++;
      failedDirs.add(next.path);
    }
  }
  if (spent.generic >= budget.maxRequests && stopped === 'complete') stopped = 'request_budget';

  // Manifest seeking: one recursive listing per remaining subtree, keeping only manifest and build-definition files.
  const candidates = (): { path: string; sha: string }[] =>
    [...known.entries()]
      .filter(
        ([p]) => !exploredSet.has(p) && !partial.has(p) && !failedDirs.has(p) && !hasChildren(p),
      )
      .filter(([p]) => dirPriority(p, ctx) >= 0 && !LOW_PATH.test(p))
      .map(([path, sha]) => ({ path, sha }))
      .sort(
        (a, b) => dirPriority(b.path, ctx) - dirPriority(a.path, ctx) || (a.path < b.path ? -1 : 1),
      );
  if (!budget.seek.enabled) seek.stopped_by = 'disabled';
  else if (
    stoppedNow() === 'time_budget' ||
    stoppedNow() === 'byte_budget' ||
    stoppedNow() === 'node_budget'
  )
    seek.stopped_by = stoppedNow() as ManifestSeekReport['stopped_by'];
  else {
    seek.stopped_by = 'complete';
    for (;;) {
      const next = candidates()[0];
      if (!next) {
        if (seek.subtrees === 0) seek.stopped_by = 'not_needed';
        break;
      }
      if (seek.subtrees >= budget.seek.maxSubtrees) {
        seek.stopped_by = 'subtree_budget';
        break;
      }
      if (seek.entries_scanned >= budget.seek.maxEntriesScanned) {
        seek.stopped_by = 'scan_budget';
        break;
      }
      const r = await spend(next.sha, true, 'seek');
      if (r === 'stop') {
        const s = sharedStop();
        seek.stopped_by =
          s === 'time_budget' || s === 'byte_budget' || s === 'node_budget' ? s : 'request_budget';
        if (s) stopped = s;
        break;
      }
      seek.subtrees++;
      if (!r) {
        seek.failed_subtrees++;
        failedDirs.add(next.path);
        continue;
      }
      seek.entries_scanned += r.tree.length;
      if (r.truncated) {
        seek.truncated_subtrees++;
        partial.add(next.path);
      } else {
        exploredSet.add(next.path);
        explored.push(next.path);
      }
      bumpPass('manifest_seek');
      for (const e of r.tree) {
        if (e.type !== 'blob') continue;
        const path = `${next.path}/${e.path}`;
        if (!SEEK_FILE_RE.test(path) || !isSafeTreePath(path) || hasControlChars(path)) continue;
        if (entries.has(path) || nodes >= budget.maxNodes) continue;
        entries.set(path, { ...e, path });
        nodes++;
        seek.manifests_found++;
      }
    }
  }
  return finish();
}

/** Subtrees the seeking pass does not spend requests on: documentation, tests, examples, vendored and generated code. */
const LOW_PATH = new RegExp(`(?:^|/)(?:${LOW_DIR.source.slice(4, -2)})(?:/|$)`, 'i');
