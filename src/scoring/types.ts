import { z } from 'zod';
import { EvidenceIdSchema } from '../evidence/types.js';

export const METHODOLOGY_VERSION = '0.2';

export const DIMENSIONS = [
  'security',
  'maintenance',
  'code-quality',
  'supply-chain',
  'community',
  'documentation',
  'semantic-clarity',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  security: 'Security',
  maintenance: 'Maintenance',
  'code-quality': 'Engineering Hygiene',
  'supply-chain': 'Supply Chain',
  community: 'Community',
  documentation: 'Documentation',
  'semantic-clarity': 'Semantic Clarity',
};

const Score10 = z.number().min(0).max(10);

export const ScoringSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('map'),
    /** Keys are String(value): "true", "false", "none", "3"... */
    values: z.record(z.string(), Score10),
    default: Score10.optional(),
  }),
  z.object({
    type: z.literal('thresholds'),
    /** Evaluated top to bottom after sorting by `gte` descending; first match wins. */
    steps: z.array(z.object({ gte: z.number(), score: Score10 })).min(1),
    otherwise: Score10,
  }),
  z.object({
    type: z.literal('linear'),
    min: z.number(),
    max: z.number(),
    invert: z.boolean().default(false),
  }),
]);
export type Scoring = z.infer<typeof ScoringSchema>;

export const ConditionSchema = z
  .object({
    evidence: EvidenceIdSchema,
    equals: z.union([z.boolean(), z.number(), z.string()]).optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
  })
  .refine((c) => [c.equals, c.gt, c.gte, c.lt, c.lte].filter((x) => x !== undefined).length === 1, {
    message: 'condition needs exactly one of equals/gt/gte/lt/lte',
  });
export type Condition = z.infer<typeof ConditionSchema>;

export const RuleSchema = z
  .object({
    id: z.string().regex(/^[a-z-]+\.[a-z0-9-]+$/),
    dimension: z.enum(DIMENSIONS),
    title: z.string().min(3),
    rationale: z.string().min(10),
    /** Evidence ids read by this rule, in preference order. */
    evidence: z.array(EvidenceIdSchema).min(1),
    /** How several observed evidence items combine: first observed / lowest / highest / mean rule score. */
    combine: z.enum(['first', 'min', 'max', 'mean']).default('first'),
    weight: z.number().min(0).max(100),
    /** Shown in the report but never part of any score. */
    informational: z.boolean().default(false),
    /** Rules in one group share the weight budget of their heaviest member (correlated signals). */
    group: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    applies_when: ConditionSchema.optional(),
    scoring: ScoringSchema,
    warn: z.object({ below: Score10, message: z.string().min(3) }).optional(),
    limitations: z.string().optional(),
  })
  .refine((r) => r.id.startsWith(`${r.dimension}.`), {
    message: 'rule id must start with "<dimension>."',
  });
export type Rule = z.infer<typeof RuleSchema>;

export const RuleFileSchema = z.object({
  methodology: z.string(),
  rules: z.array(RuleSchema).min(1),
});

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  /** Relative weight of each dimension in the overall score. Missing dimensions get weight 1. */
  dimension_weights: z.partialRecord(z.enum(DIMENSIONS), z.number().min(0).max(100)).default({}),
  /** Replace a rule's declared weight. 0 disables the rule for this profile. */
  rule_weights: z.record(z.string(), z.number().min(0).max(100)).default({}),
  /** Advisory floors (0-100) per dimension or "overall"; enforced only with --enforce-profile. */
  minimums: z.record(z.string(), z.number().min(0).max(100)).default({}),
});
export type Profile = z.infer<typeof ProfileSchema>;
