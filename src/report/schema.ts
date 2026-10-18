import { z } from 'zod';
import { CodeAnalysisSchema } from '../analysis/index.js';
import { RegulatorySchema } from '../compliance/packs.js';
import { DependencyIntelSchema } from '../deps/model.js';
import { FindingSchema } from '../analysis/findings.js';
import { EvidenceSchema } from '../evidence/types.js';
import { FactSchema } from '../facts/index.js';
import { SemanticIdentitySchema } from '../identity/types.js';
import { IdentityV2Schema } from '../identity/v2.js';
import { ExternalDomainsSchema } from '../domains/model.js';
import { TimelineSchema } from '../events/model.js';
import { DependencyRegistryIntelSchema } from '../registry/dependency-model.js';
import { RegistryIntelSchema } from '../registry/model.js';
import { GovernanceSchema } from '../governance/temporal.js';
import { ReleaseIntelSchema } from '../release/model.js';
import { CoverageMapSchema, TreeRetrievalSchema } from './coverage.js';
import { DIMENSIONS } from '../scoring/types.js';
import { DependencyArtifactsSchema } from '../registry/artifacts/model.js';
import { NameIntelligenceSchema } from '../registry/name-model.js';
import { BuildSourcesSchema } from '../collectors/build-systems/model.js';
import { YOUNG_PACKAGE_DAYS } from '../deps/introductions.js';

const DependencyIntroductionSchema = z.object({
  dependency_id: z.string(),
  ecosystem: z.string(),
  package: z.string(),
  resolved_version: z.string().nullable(),
  direct: z.union([z.boolean(), z.literal('unknown')]),
  parent_chain: z.array(z.string()).max(8),
  parent_chain_capped: z.boolean(),
  introduction: z.enum(['known', 'unknown']),
  introduced_in_revision: z.string().nullable(),
  introduced_with_count: z.number().int().nullable(),
  parent_provenance: z.enum(['verified', 'reported', 'none', 'unknown']),
  package_first_published_at: z.string().nullable(),
  resolved_version_published_at: z.string().nullable(),
  introduced_before_first_publish_days: z.number().nullable(),
  versions_published_after_introduction: z.number().int().nullable(),
  young_package_present: z.boolean().nullable(),
  release_age_days_min: z.number().int().nullable(),
  evidence_ids: z.array(z.string()),
});

export const REPORT_SCHEMA_VERSION = '0.11';

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
  missing_reason: z
    .enum(['unavailable', 'not_collected', 'insufficient_coverage', 'not_reported'])
    .nullable(),
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
    taxonomy_version: z.string(),
    detector_pack_version: z.string(),
    facts_version: z.string(),
    /** sha256 of the profile, flags and limits that shaped this analysis. */
    config_digest: z.string(),
  }),
  profile: z.object({ id: z.string(), version: z.string(), title: z.string() }),
  generated_at: z.string(),
  analysis_manifest: z.object({
    repository: z.string(),
    commit: z.string().nullable(),
    revision_kind: z.enum(['immutable', 'moving']),
    tool_version: z.string(),
    schema_version: z.string(),
    feature_flags: z.record(z.string(), z.boolean()),
    collector_versions: z.record(z.string(), z.string()),
    external_sources: z
      .array(
        z.object({
          source: z.string(),
          classification: z.enum([
            'revision_bound',
            'historical_event',
            'current_state',
            'retrieved_snapshot',
          ]),
          retrieved_at: z.string(),
        }),
      )
      .max(30),
    trust_roots: z.array(z.string()).max(20),
    budgets: z.record(z.string(), z.number()),
    coverage: z.record(z.string(), z.number()),
  }),
  subject: z.object({
    owner: z.string(),
    repo: z.string(),
    url: z.string(),
    default_branch: z.string(),
    /** Commit the repository content was read at (when known). */
    ref: z.string().nullable(),
    revision_kind: z.enum(['immutable', 'moving']).default('moving'),
  }),
  identity: SemanticIdentitySchema,
  /** Multi-axis identity (primary artifact, secondary roles, packaging, interfaces, deployment). The flat `identity` is kept for compatibility. */
  identity_v2: IdentityV2Schema,
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
    /** Policy-as-code blocks of the profile that were evaluated, and the ones that fired. */
    blocks_evaluated: z.number(),
    block_violations: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        reason: z.enum(['condition_true', 'undecidable']),
        evidence: z.array(z.string()),
        missing: z.array(z.string()),
      }),
    ),
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
  /** Raw evidence from collectors and identity. Derived facts are listed separately in `facts`. */
  evidence: z.array(EvidenceSchema),
  /** Normalized facts that rules consume; `derived_from` ids resolve to evidence, detections, chains, hooks or secrets. */
  facts: z.array(FactSchema),
  /** Static capability, execution-graph, persistence and secret analysis (never executes repository code). */
  code_analysis: CodeAnalysisSchema,
  findings: z.array(FindingSchema),
  /** Dependency model, resolution state, vulnerability coverage, deps.dev status and SBOM comparison (schema 0.3). */
  /** How the repository tree was obtained (full recursive tree, or a bounded targeted walk) and what was left unread. */
  retrieval: TreeRetrievalSchema,
  /** Release assets, checksums, signature states and provenance; never a claim of reproducibility. */
  release_intel: ReleaseIntelSchema,
  /** Registry package intelligence (npm, PyPI, crates.io) for the packages this repository publishes. */
  registry_intel: RegistryIntelSchema,
  /** Registry history of the DEPENDENCIES (priority, budget, coverage, publisher / maintainer / repository events). Schema 0.7. */
  dependency_registry_intel: DependencyRegistryIntelSchema,
  dependency_artifacts: DependencyArtifactsSchema,
  name_intelligence: NameIntelligenceSchema,
  build_sources: BuildSourcesSchema,
  /** Hostnames the repository's own files refer to, by context (install, build, CI, runtime, docs...). Static; nothing is resolved or contacted. Schema 0.7. */
  external_domains: ExternalDomainsSchema,
  /** Unified temporal events (git, releases, registry) and the patterns they form. Indicators only. */
  timeline: TimelineSchema,
  /** Temporal governance signals (committer / release-author changes, dormancy). Descriptive; intent undetermined. */
  governance: GovernanceSchema,
  /** Coverage by evidence class instead of one generic percentage. */
  coverage_map: CoverageMapSchema,
  dependency_intel: DependencyIntelSchema,
  dependency_introductions: z.object({
    version: z.literal('1'),
    coverage: z.object({
      considered: z.number().int(),
      with_known_introduction: z.number().int(),
      unknown: z.number().int(),
      capped: z.number().int(),
    }),
    entries: z.array(DependencyIntroductionSchema).max(300),
    limits_hit: z.array(z.string()),
    young_package_threshold_days: z.literal(YOUNG_PACKAGE_DAYS).optional(),
  }),
  /** Regulatory readiness packs and the technical indicators they read. Never a legal determination. */
  regulatory: RegulatorySchema,
  /** Tamper evidence: sha256 of the canonical JSON of this report without this field. Not a signature. */
  integrity: z.object({ report_sha256: z.string() }),
});
export type Report = z.infer<typeof ReportSchema>;
