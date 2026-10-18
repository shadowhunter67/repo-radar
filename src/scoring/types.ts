import { z } from 'zod';
import { TemporalPatternSchema } from '../events/model.js';
import { EvidenceIdSchema } from '../evidence/types.js';
import { ConditionSchema as PolicyConditionSchema } from '../compliance/applicability.js';

export const METHODOLOGY_VERSION = '0.4';

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

/** Minimal deterministic requirements that compile into blocks. `strict` also blocks when the evidence is unknown. */
export const REQUIRE_KEYS = ['sbom', 'signed_release', 'provenance', 'checksums'] as const;
const RequireValue = z.union([z.boolean(), z.literal('strict')]);

export const HISTORY_RULE_KINDS = [
  'new_vulnerability',
  'new_install_hook',
  'new_install_time_remote_execution',
  'new_capability',
  'new_git_or_path_dependency',
  'takeover_indicators_with_new_install_hook',
  'new_install_time_domain',
  'provenance_verification_lost',
  'source_binding_conflict',
] as const;
/** Blocks over the temporal event correlations of one analysis or of a revision diff. */
export const TemporalBlockSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,60}$/),
    description: z.string().min(5).max(300),
    /** A built-in pattern id (see docs/governance.md) or a custom pattern (ordered steps within a window). */
    pattern: z.union([z.string().regex(/^[a-z0-9-]{3,60}$/), TemporalPatternSchema]),
  })
  .strict();

export const HistoryBlockSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,60}$/),
    description: z.string().min(5).max(300),
    kind: z.enum(HISTORY_RULE_KINDS),
    /** For `new_capability`: only this capability (default: any capability of medium or high risk). */
    capability: z.string().max(40).optional(),
  })
  .strict();

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
  /**
   * Policy-as-code: conditions over the report (facts, findings, capabilities, ...) that block adoption. Enforced only
   * with --enforce-profile. A condition that cannot be decided (`unknown`) blocks only when `on_unknown: block`.
   */
  block: z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9-]{3,60}$/),
          description: z.string().min(5).max(300),
          when: PolicyConditionSchema,
          on_unknown: z.enum(['ignore', 'block']).default('ignore'),
        })
        .strict(),
    )
    .default([]),
  /**
   * Requirements, e.g. `require: { sbom: true, signed_release: strict }`. `true` blocks when the evidence says the
   * requirement is not met; `strict` also blocks when it cannot be decided. Unknown never blocks by default.
   */
  require: z
    .object({
      sbom: RequireValue.optional(),
      signed_release: RequireValue.optional(),
      provenance: RequireValue.optional(),
      checksums: RequireValue.optional(),
      /** A release attestation was cryptographically verified (needs --verify-crypto; unknown otherwise). */
      verified_provenance: RequireValue.optional(),
      /** Verified attestation binds an asset digest, this repository's CI workflow and the tag commit. */
      verified_source_binding: RequireValue.optional(),
      /** The registry package points back to this repository (blocks on conflicting or missing). */
      registry_repository_match: RequireValue.optional(),
      /** No recent version was published by an account new to the sampled history. */
      publisher_stability: RequireValue.optional(),
      /** A release signature was verified by repo-radar against a key YOU configured (unknown without --trust-* keys). */
      locally_verified_signature: RequireValue.optional(),
      /** No looked-up dependency points to conflicting or missing source repositories. */
      dependency_registry_match: RequireValue.optional(),
      /** No looked-up dependency was published by an account new to its sampled history. Unknown never blocks unless `strict`. */
      dependency_publisher_stability: RequireValue.optional(),
      /** Every looked-up npm dependency reports provenance for its latest version (registry-reported, not verified). */
      dependency_provenance_reported: RequireValue.optional(),
      dependency_verified_provenance: RequireValue.optional(),
      dependency_verified_source_binding: RequireValue.optional(),
      /** No dependency shows takeover indicators (long gap / new publisher followed by an install script or lost provenance). */
      no_dependency_takeover_indicators: RequireValue.optional(),
      no_dependency_name_confusion: RequireValue.optional(),
      no_dependency_install_domains: RequireValue.optional(),
      dependency_artifacts_inspected: RequireValue.optional(),
      no_young_dependencies: RequireValue.optional(),
      dependency_introductions_known: RequireValue.optional(),
    })
    .strict()
    .default({}),
  /** Rules over the difference between two revisions (`repo-radar diff owner/repo --from A --to B --profile P --enforce-profile`). */
  history_block: z.array(HistoryBlockSchema).default([]),
  /** Event-pattern rules (for example a new publisher followed by a release within a week). Unknown never blocks. */
  temporal_block: z.array(TemporalBlockSchema).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;
