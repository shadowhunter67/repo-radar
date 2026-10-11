import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CAPABILITIES } from '../analysis/types.js';
import { ARTIFACT_TYPES } from '../identity/taxonomy.js';
import { PACKAGING } from '../identity/v2.js';

/** A label a reviewer could not or would not decide is `unknown` or `disputed`; both are excluded from metrics and counted. */
export const TriSchema = z.enum(['yes', 'no', 'unknown', 'disputed']);
export type Tri = z.infer<typeof TriSchema>;

/** Where a field stands after human review. Never forced into consensus. */
export const FIELD_STATUSES = ['agreed', 'disagreed', 'uncertain', 'needs_adjudication'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export const SPLITS = ['dev', 'validation', 'holdout'] as const;
export type Split = (typeof SPLITS)[number];

const ArtifactLabel = z.union([z.enum(ARTIFACT_TYPES), z.literal('disputed')]);

/** Phase 4 label family (dependency intelligence and SBOM). Every field may be `unknown` or `not_applicable`. */
export const TriNaSchema = z.enum(['yes', 'no', 'unknown', 'disputed', 'not_applicable']);
export type TriNa = z.infer<typeof TriNaSchema>;
export const SBOM_CONSISTENCY = [
  'consistent',
  'partial',
  'mismatch',
  'unable_to_compare',
  'unknown',
  'not_applicable',
  'disputed',
] as const;
export const DependencyLabelSchema = z.object({
  has_lockfile: TriNaSchema.default('unknown'),
  /** Lockfile file names that cover the primary project(s), e.g. [package-lock.json]. */
  lockfile_types: z.array(z.string()).default([]),
  /** What the lockfile covers: the root project only, a workspace, or nothing in this tree. */
  lockfile_scope: z.enum(['root', 'workspace', 'none', 'unknown']).default('unknown'),
  /** Number of manifests that declare dependencies of the primary project (excluding examples/tests/tools). */
  dependency_manifest_count: z.union([z.number(), z.literal('unknown')]).default('unknown'),
  /** Direct dependencies (all relationships) declared by those manifests. */
  direct_dependency_count_expected: z.union([z.number(), z.literal('unknown')]).default('unknown'),
  /** A reasonable tool could assign an exact version to (nearly) all direct registry dependencies from this revision. */
  exact_version_expected: TriNaSchema.default('unknown'),
  /** Exact versions exist for enough dependencies that a vulnerability lookup is meaningful. */
  osv_checkable: TriNaSchema.default('unknown'),
  osv_expected_known_vulnerabilities: TriNaSchema.default('unknown'),
  has_sbom: TriNaSchema.default('unknown'),
  sbom_format: z.enum(['CycloneDX', 'SPDX', 'other', 'none', 'unknown']).default('unknown'),
  sbom_scope: z
    .enum(['application', 'library', 'container', 'mixed', 'ci_workflow', 'none', 'unknown'])
    .default('unknown'),
  sbom_consistency: z.enum(SBOM_CONSISTENCY).default('unknown'),
  manifest_sbom_missing: TriNaSchema.default('unknown'),
  sbom_extra_components: TriNaSchema.default('unknown'),
  /** Manifests under examples/tests/docs/tools declare dependencies that could be mistaken for the project's own. */
  auxiliary_dependency_presence: TriNaSchema.default('unknown'),
  /** It is genuinely unclear which manifests/lockfiles define "the" dependencies of the project. */
  dependency_scope_ambiguity: TriNaSchema.default('unknown'),
});
export type DependencyLabel = z.infer<typeof DependencyLabelSchema>;

export const LabelSchema = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  split: z.enum(SPLITS),
  /** True if analyzer output for this repository was looked at while building or tuning the analyzer. */
  tuned_on: z.boolean(),
  labelled_on: z.string(),
  review: z.object({
    kind: z.enum(['ai-assisted-single', 'human-single', 'human-double']),
    method: z.string(),
    reviewers: z.array(z.string()).min(1),
  }),
  artifact_type: ArtifactLabel,
  /** Other artifact types a reviewer would also accept (ambiguous artifacts). */
  artifact_also_acceptable: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  domain: z.string(),
  domain_also_acceptable: z.array(z.string()).default([]),
  /** Identity v2 packaging axis (how the repository is packaged, not what it is). Optional: absent = not labelled. */
  packaging: z.enum(PACKAGING).optional(),
  packaging_also_acceptable: z.array(z.enum(PACKAGING)).default([]),
  /** Capability exists in non-test, non-example, non-vendor source or build files of the pinned revision. */
  capabilities: z.partialRecord(z.enum(CAPABILITIES), TriSchema),
  install_hooks: z.object({
    /** Code that runs automatically when a DEPENDENT installs/builds this package (npm lifecycle, setup.py, build.rs, ...). */
    automatic: TriSchema,
    names: z.array(z.string()).default([]),
  }),
  persistence: TriSchema,
  hard_coded_secrets: TriSchema,
  /** Optional: labels of the dependency/SBOM family. Absent for corpora labelled before Phase 4. */
  dependencies: DependencyLabelSchema.optional(),
  ambiguity_notes: z.string().default(''),
  /** Review state per field (field names as in the adjudication worksheet). Absent field = not human-reviewed. */
  field_status: z.record(z.string(), z.enum(FIELD_STATUSES)).default({}),
  /** Individual reviewer opinions kept side by side instead of a forced consensus. */
  opinions: z
    .array(
      z.object({
        field: z.string(),
        reviewer: z.string().max(64),
        value: z.string().max(200),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
      }),
    )
    .default([]),
});
export type Label = z.infer<typeof LabelSchema>;

export const DatasetSchema = z.object({
  version: z.string(),
  selection_notes: z.string(),
  /** Identifier of the corpus, e.g. `fresh-holdout-0.4`; used by results and release gates. */
  corpus_id: z.string().optional(),
  /** Methodology version this corpus was built to evaluate (a fresh holdout is only valid for that version). */
  for_methodology: z.string().optional(),
  /** All repositories belong to this split (a fresh holdout is entirely `holdout`). Overrides the hash rule. */
  fixed_split: z.enum(SPLITS).optional(),
  repositories: z
    .array(
      z.object({
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        categories: z.array(z.string()),
        tuned_on: z.boolean().optional(),
      }),
    )
    .min(1),
});
export type Dataset = z.infer<typeof DatasetSchema>;

/**
 * Stable split assignment: sha256("owner/repo") first byte mod 10 -> 0-3 dev, 4-6 validation, 7-9 holdout.
 * Repositories whose analyzer output was inspected during development are forced into `dev`.
 */
export function assignSplit(repo: string, tunedOn: boolean): Split {
  if (tunedOn) return 'dev';
  const b = createHash('sha256').update(repo.toLowerCase()).digest()[0] as number;
  const m = b % 10;
  return m <= 3 ? 'dev' : m <= 6 ? 'validation' : 'holdout';
}
