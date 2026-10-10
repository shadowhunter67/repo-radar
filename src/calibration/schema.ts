import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CAPABILITIES } from '../analysis/types.js';
import { ARTIFACT_TYPES } from '../identity/taxonomy.js';

/** A label a reviewer could not or would not decide is `unknown` or `disputed`; both are excluded from metrics and counted. */
export const TriSchema = z.enum(['yes', 'no', 'unknown', 'disputed']);
export type Tri = z.infer<typeof TriSchema>;

export const SPLITS = ['dev', 'validation', 'holdout'] as const;
export type Split = (typeof SPLITS)[number];

const ArtifactLabel = z.union([z.enum(ARTIFACT_TYPES), z.literal('disputed')]);

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
  /** Capability exists in non-test, non-example, non-vendor source or build files of the pinned revision. */
  capabilities: z.partialRecord(z.enum(CAPABILITIES), TriSchema),
  install_hooks: z.object({
    /** Code that runs automatically when a DEPENDENT installs/builds this package (npm lifecycle, setup.py, build.rs, ...). */
    automatic: TriSchema,
    names: z.array(z.string()).default([]),
  }),
  persistence: TriSchema,
  hard_coded_secrets: TriSchema,
  ambiguity_notes: z.string().default(''),
});
export type Label = z.infer<typeof LabelSchema>;

export const DatasetSchema = z.object({
  version: z.string(),
  selection_notes: z.string(),
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
