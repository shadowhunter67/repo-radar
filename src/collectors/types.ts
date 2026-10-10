import type { ScannedFile } from '../analysis/types.js';
import type { ParsedManifest, LockedPackage } from './manifests/parse.js';

/** What the identity engine (and humans) can read about a repo, independent of scoring. */
export interface RepoSnapshot {
  owner: string;
  repo: string;
  /** Exactly as GitHub reports it; never altered. */
  displayName: string;
  description?: string;
  topics: string[];
  language?: string;
  readme?: string;
  treePaths: string[];
  manifests: ParsedManifest[];
  hasDockerfile: boolean;
  hasActionYml: boolean;
  defaultBranch: string;
  ref?: string;
  htmlUrl: string;
}

export interface GithubCollection {
  snapshot: RepoSnapshot;
  locked: LockedPackage[];
  /** Total direct runtime dependencies across parsed manifests. */
  directDependencyCount: number;
  /** Files fetched for static scanning (scripts, build files, workflows, manifests, source sample). */
  files: ScannedFile[];
  /** All blob paths of the git tree (bounded); used to resolve local references. */
  allTreePaths: string[];
  sourceFileCount: number;
  fetchStats: { skippedTooLarge: number; skippedOverBudget: number };
  /** False when scanning was disabled by the caller. */
  scanned: boolean;
}
