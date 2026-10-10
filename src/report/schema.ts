import { z } from 'zod';
import { EvidenceSchema } from '../evidence/types.js';
import { SemanticIdentitySchema } from '../identity/types.js';
import { DIMENSIONS } from '../scoring/types.js';

export const REPORT_SCHEMA_VERSION = '0.1';

const SufficiencySchema = z.enum(['sufficient', 'low', 'insufficient']);

export const RuleResultSchema = z.object({
  rule_id: z.string(),
  title: z.string(),
  status: z.enum(['scored', 'not_observed', 'not_applicable', 'informational', 'disabled']),
  score: z.number().nullable(),
  max_score: z.literal(10),
  declared_weight: z.number(),
  profile_weight: z.number(),
  effective_weight: z.number(),
  contribution: z.number().nullable(),
  group: z.string().nullable(),
  inputs: z.array(
    z.object({
      evidence_id: z.string(),
      value: z.union([z.boolean(), z.number(), z.string(), z.array(z.string())]),
      confidence: z.number(),
      source: z.string(),
      kind: z.string(),
    }),
  ),
  evidence_ids: z.array(z.string()),
  confidence: z.number().nullable(),
  missing_reason: z.enum(['unavailable', 'not_collected', 'not_reported']).nullable(),
  explanation: z.string(),
});

export const DimensionResultSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  label: z.string(),
  score: z.number().nullable(),
  score_range: z.tuple([z.number(), z.number()]).nullable(),
  grade: z.string(),
  confidence: z.number(),
  coverage: z.number(),
  evidence_quality: z.number(),
  sufficiency: SufficiencySchema,
  scored_rules: z.number(),
  applicable_rules: z.number(),
  rules: z.array(RuleResultSchema),
});

export const ReportSchema = z.object({
  tool: z.object({ name: z.literal('repo-radar'), version: z.string() }),
  schema_version: z.literal(REPORT_SCHEMA_VERSION),
  methodology: z.object({
    version: z.string(),
    rules_digest: z.string(),
    rule_count: z.number(),
    classifier: z.string(),
  }),
  profile: z.object({ id: z.string(), version: z.string(), title: z.string() }),
  generated_at: z.string(),
  subject: z.object({
    owner: z.string(),
    repo: z.string(),
    url: z.string(),
    default_branch: z.string(),
    /** Commit the repository content was read at (when known). */
    ref: z.string().nullable(),
  }),
  identity: SemanticIdentitySchema,
  overall: z.object({
    score: z.number().nullable(),
    grade: z.string(),
    confidence: z.number(),
    sufficiency: SufficiencySchema,
    weight_covered: z.number(),
    dimension_weights: z.record(z.string(), z.number()),
  }),
  dimensions: z.array(DimensionResultSchema),
  warnings: z.array(
    z.object({
      rule_id: z.string().nullable(),
      dimension: z.enum(DIMENSIONS).nullable(),
      message: z.string(),
      evidence_ids: z.array(z.string()),
    }),
  ),
  policy: z.object({
    source: z.enum(['none', 'profile', 'cli']),
    enforced: z.boolean(),
    minimums: z.record(z.string(), z.number()),
    violations: z.array(
      z.object({
        key: z.string(),
        minimum: z.number(),
        actual: z.number().nullable(),
        reason: z.enum(['below_minimum', 'insufficient_evidence']),
      }),
    ),
  }),
  diagnostics: z.array(
    z.object({
      source: z.string(),
      level: z.enum(['info', 'warn', 'error']),
      code: z.string(),
      message: z.string(),
      affects: z.array(z.string()).optional(),
    }),
  ),
  stats: z.object({
    evidence_count: z.number(),
    http_requests: z.number(),
    authenticated: z.boolean(),
  }),
  evidence: z.array(EvidenceSchema),
});
export type Report = z.infer<typeof ReportSchema>;
