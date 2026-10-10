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
}
