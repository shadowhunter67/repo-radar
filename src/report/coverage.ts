import { z } from 'zod';
import type { TreeRetrieval } from '../collectors/github/retrieval.js';

/**
 * Coverage by evidence class. One overall percentage hides what matters: a repository can have every manifest and workflow
 * read and still have read 4% of its source. Each class says HOW it was obtained, never just "how much".
 *
 * - `complete`: the whole repository tree was read, so every file of this class that exists was seen.
 * - `targeted`: a bounded, prioritised walk read the directories that normally hold this class; files in unread
 *   directories may exist.
 * - `sampled`: a bounded sample of files was read (source code).
 * - `partial`: some of it was read for another reason (truncated listing, scan budget).
 * - `none`: nothing could be read.
 */
export const COVERAGE_STATES = ['complete', 'targeted', 'sampled', 'partial', 'none'] as const;
export const EVIDENCE_CLASSES = [
  'manifest',
  'lockfile',
  'sbom',
  'ci',
  'build_config',
  'source',
  'documentation',
  'release_metadata',
] as const;

export const TreeRetrievalSchema = z.object({
  method: z.enum(['recursive', 'targeted', 'none']),
  complete: z.boolean(),
  reason: z.enum(['none', 'github_truncated', 'response_too_large', 'fetch_failed', 'disabled']),
  requests: z.number().int().min(0),
  nodes: z.number().int().min(0),
  bytes: z.number().int().min(0),
  explored: z.array(z.string().max(400)).max(200),
  unexplored: z.array(z.string().max(400)).max(25),
  unexplored_count: z.number().int().min(0),
  stopped_by: z.enum(['complete', 'request_budget', 'node_budget', 'byte_budget', 'time_budget']),
  github_truncated: z.boolean(),
  failed_requests: z.number().int().min(0),
  passes: z
    .array(
      z.object({
        name: z.enum([
          'root',
          'ci_build',
          'hinted',
          'declared_deep',
          'source_roots',
          'breadth',
          'manifest_seek',
        ]),
        directories: z.number().int().min(0),
      }),
    )
    .max(10),
  hints: z.object({
    files_read: z.number().int().min(0),
    directories_named: z.number().int().min(0),
    files: z.array(z.string().max(400)).max(20),
  }),
  skipped_by_rule: z.number().int().min(0),
  wide_directories: z.array(z.string().max(400)).max(10),
  /** Directories the project's own build files declare, followed from a separate budget (retrieval v3). */
  declared_paths: z.object({
    accepted: z.number().int().min(0),
    followed: z.number().int().min(0),
    deep: z.number().int().min(0),
    rejected_unsafe: z.number().int().min(0),
    rejected_depth: z.number().int().min(0),
    rejected_over_limit: z.number().int().min(0),
    requests: z.number().int().min(0),
    stopped_by: z.enum(['complete', 'request_budget', 'path_limit']),
  }),
  /** Bounded recursive listings of subtrees, keeping only manifest and build-definition files (retrieval v3). */
  manifest_seek: z.object({
    enabled: z.boolean(),
    requests: z.number().int().min(0),
    subtrees: z.number().int().min(0),
    truncated_subtrees: z.number().int().min(0),
    failed_subtrees: z.number().int().min(0),
    manifests_found: z.number().int().min(0),
    entries_scanned: z.number().int().min(0),
    stopped_by: z.enum([
      'not_needed',
      'complete',
      'request_budget',
      'subtree_budget',
      'scan_budget',
      'time_budget',
      'byte_budget',
      'node_budget',
      'disabled',
    ]),
  }),
});

export const CoverageEntrySchema = z.object({
  state: z.enum(COVERAGE_STATES),
  /** Fraction in [0,1] when it can be stated honestly (source files scanned / source files known). */
  ratio: z.number().min(0).max(1).nullable(),
  note: z.string(),
});
export const CoverageMapSchema = z.object({
  manifest: CoverageEntrySchema,
  lockfile: CoverageEntrySchema,
  sbom: CoverageEntrySchema,
  ci: CoverageEntrySchema,
  build_config: CoverageEntrySchema,
  source: CoverageEntrySchema,
  documentation: CoverageEntrySchema,
  release_metadata: CoverageEntrySchema,
});
export type CoverageMap = z.infer<typeof CoverageMapSchema>;

export interface CoverageInput {
  retrieval: TreeRetrieval;
  /** Source files fetched and scanned / source files known in the (possibly partial) tree; null when no scan ran. */
  sourceScanRatio: number | null;
  scanned: boolean;
  releasesRead: boolean;
  /** Directories the targeted walk read (to state which classes a targeted walk could see). */
  workflowsSeen: boolean;
}

const BUILD_DIRS =
  /^(?:\.github|\.circleci|\.buildkite|\.gitlab|\.mvn|gradle|buildSrc|build-logic|scripts?|ci|tools?|docker|deploy)(?:\/|$)/;

export function buildCoverageMap(i: CoverageInput): CoverageMap {
  const r = i.retrieval;
  const entry = (state: (typeof COVERAGE_STATES)[number], ratio: number | null, note: string) => ({
    state,
    ratio,
    note,
  });
  if (r.method === 'none') {
    const n = entry('none', null, `repository tree unavailable (${r.reason})`);
    return {
      manifest: n,
      lockfile: n,
      sbom: n,
      ci: n,
      build_config: n,
      source: n,
      documentation: n,
      release_metadata: i.releasesRead
        ? entry('complete', null, 'latest releases read from the API')
        : entry('none', null, 'release list unavailable'),
    };
  }
  const full = r.method === 'recursive' && r.complete;
  const structural = (what: string) =>
    full
      ? entry('complete', 1, 'whole tree read')
      : r.method === 'recursive'
        ? entry('partial', null, `${what}: GitHub truncated the recursive tree`)
        : entry(
            'targeted',
            null,
            `${what} read from priority directories (${r.explored.length} listed, ${r.unexplored_count} known directories unread; stopped by ${r.stopped_by})`,
          );
  const sourceState = !i.scanned
    ? entry('none', null, 'code scan disabled')
    : i.sourceScanRatio === null
      ? entry('none', null, 'no source files selected')
      : entry(
          full && i.sourceScanRatio >= 1 ? 'complete' : 'sampled',
          Math.round(i.sourceScanRatio * 100) / 100,
          full
            ? 'files fetched / source files in the tree (bounded file budget)'
            : 'files fetched / source files in the PARTIAL tree (true total is larger)',
        );
  const ci = i.workflowsSeen
    ? structural('workflows')
    : full
      ? entry('complete', 1, 'whole tree read; no workflows found')
      : entry('targeted', null, '.github/workflows not found among the directories read');
  return {
    manifest: structural('manifests'),
    lockfile: structural('lockfiles'),
    sbom: structural('SBOM-like files'),
    ci,
    build_config: structural('build configuration'),
    source: sourceState,
    documentation: full
      ? entry('complete', 1, 'whole tree read')
      : entry('partial', null, 'documentation directories are deliberately not walked'),
    release_metadata: i.releasesRead
      ? entry('complete', null, 'latest releases read from the API')
      : entry('none', null, 'release list unavailable'),
  };
}

export { BUILD_DIRS };
