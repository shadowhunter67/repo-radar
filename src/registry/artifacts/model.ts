import { z } from 'zod';
import { ARTIFACT_PROVENANCE_CLASSES } from './provenance.js';

export const DependencyArtifactSchema = z.object({
  registry: z.enum(['npm', 'pypi', 'crates.io']),
  package: z.string().max(214),
  version: z.string().max(100),
  url: z.string().max(500).nullable(),
  state: z.enum([
    'verified',
    'verification_unavailable',
    'invalid',
    'unsupported',
    'failed',
    'skipped',
  ]),
  entries: z.number().int().min(0),
  total_size: z.number().int().min(0),
  hooks: z.array(z.object({ name: z.string(), text: z.string().max(65536) })).max(20),
  domains: z.array(z.string().max(253)).max(100),
  mismatches: z.array(z.string().max(200)).max(20),
  executable_entry_present: z.boolean().nullable().optional(),
  native_binary_present: z.boolean().nullable().optional(),
  repository_host: z
    .enum(['github.com', 'gitlab.com', 'bitbucket.org', 'other', 'unknown'])
    .nullable()
    .optional(),
  publisher_organization: z.string().max(200).nullable().optional(),
  reason: z.string().max(200).nullable(),
  evidence: z.array(z.string().max(160)).max(10),
  provenance_class: z.enum(ARTIFACT_PROVENANCE_CLASSES).optional(),
  source_confidence: z.number().min(0).max(1).optional(),
});
export type DependencyArtifact = z.infer<typeof DependencyArtifactSchema>;
export const DependencyArtifactsSchema = z.object({
  version: z.literal('1'),
  status: z.enum(['disabled', 'analyzed']),
  eligible: z.number().int().min(0),
  candidates: z.number().int().min(0),
  downloaded: z.number().int().min(0),
  digest_verified: z.number().int().min(0),
  inspected: z.number().int().min(0),
  skipped: z.record(z.string(), z.number().int().min(0)),
  artifacts: z.array(DependencyArtifactSchema).max(20),
  limits_hit: z.array(z.string().max(200)).max(10),
  not_available: z.array(z.string().max(200)).max(10),
});
export type DependencyArtifacts = z.infer<typeof DependencyArtifactsSchema>;
export const EMPTY_DEPENDENCY_ARTIFACTS: DependencyArtifacts = {
  version: '1',
  status: 'disabled',
  eligible: 0,
  candidates: 0,
  downloaded: 0,
  digest_verified: 0,
  inspected: 0,
  skipped: {},
  artifacts: [],
  limits_hit: [],
  not_available: [],
};
