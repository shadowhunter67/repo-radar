import { z } from 'zod';
import { REGISTRIES, RegistryPackageSchema } from './model.js';

/**
 * Registry intelligence for the DEPENDENCIES of the analyzed repository (schema 0.7). The own-package intelligence in
 * `registry_intel` answers "who publishes what this repository ships"; this answers "who publishes what this repository
 * relies on".
 *
 * Rules that shape the model:
 *  - a dependency that was not queried is UNKNOWN, never clean: the budget, the ecosystem and the name are recorded for every
 *    eligible dependency that was skipped;
 *  - registry state is CURRENT state; version-level publish history is the only historical part, and each event says which;
 *  - package <-> repository correspondence needs an independent second source: the registry's own claim is `likely` at best;
 *  - events describe observed registry history and never intent.
 */
export const DEP_REGISTRY_BUDGET_DEFAULTS = {
  /** Distinct registry packages looked up. */
  maxDependencies: 25,
  /** HTTP requests to registries (crates.io needs two per crate). */
  maxRequests: 60,
  /** Wall-clock budget by the injected clock. */
  maxElapsedMs: 45_000,
  /** Versions kept per package (newest first). */
  maxVersions: 20,
  /** Sum of response bodies. */
  maxBytes: 48 * 1024 * 1024,
  /** Parallel lookups. */
  concurrency: 4,
} as const;
export type DepRegistryBudget = {
  -readonly [K in keyof typeof DEP_REGISTRY_BUDGET_DEFAULTS]: number;
};

export const SKIP_REASONS = [
  'budget_dependencies',
  'budget_requests',
  'budget_time',
  'budget_bytes',
  'unsupported_ecosystem',
  'not_registry_source',
  'invalid_name',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const DEP_EVENT_TYPES = [
  'dependency_publisher_changed',
  'dependency_maintainer_changed',
  'dependency_repository_changed',
  'dependency_dormancy_ended',
  'dependency_release_cadence_changed',
  'dependency_provenance_added',
  'dependency_provenance_removed',
  'dependency_install_hook_introduced',
] as const;
export type DepEventType = (typeof DEP_EVENT_TYPES)[number];

export const PrioritySchema = z.object({
  score: z.number().int(),
  /** Every factor that contributed, in a stable order, so the ranking is explainable. */
  reasons: z.array(z.string().max(80)).max(12),
});
export type Priority = z.infer<typeof PrioritySchema>;

export const DependencyRegistryPackageSchema = RegistryPackageSchema.extend({
  /** Dependency ids (dependency_intel) this package serves; one package can be requested from several manifests. */
  dependency_ids: z.array(z.string().max(160)).max(10),
  /** Exact versions the analyzed revision resolved for it (lockfile / SBOM / pin). May be empty. */
  resolved_versions: z.array(z.string().max(100)).max(5),
  priority: PrioritySchema,
  /**
   * Second source used to corroborate the registry's repository claim. The registry's own claim alone caps the
   * correspondence at `likely`.
   */
  corroboration: z.object({
    source: z.enum(['deps.dev', 'none']),
    repositories: z.array(z.string().max(120)).max(5),
  }),
});
export type DependencyRegistryPackage = z.infer<typeof DependencyRegistryPackageSchema>;

export const DependencyRegistryEventSchema = z.object({
  id: z.string().max(100),
  type: z.enum(DEP_EVENT_TYPES),
  /** Publish time of the version the event happened at. Events without a usable timestamp are never created. */
  at: z.string(),
  registry: z.enum(REGISTRIES),
  package: z.string().max(214),
  version: z.string().max(100),
  detail: z.string().max(300),
  confidence: z.number().min(0).max(1),
  /** Always `publish_history`: current-state registry data (today's maintainers) never becomes a dated event. */
  scope: z.literal('publish_history'),
  /**
   * Whether the event happened before, at or after the version the analyzed revision resolved for this package.
   * `unknown` when no exact resolved version is known or it is not in the sampled history.
   */
  relative_to_resolved: z.enum(['before', 'at', 'after', 'unknown']),
  /** Days from the resolved version's publish time to the event (negative = before it); null when unknown. */
  days_from_resolved: z.number().nullable().optional(),
  evidence: z.array(z.string().max(160)).max(4),
  intent: z.literal('undetermined'),
});
export type DependencyRegistryEvent = z.infer<typeof DependencyRegistryEventSchema>;

export const SkippedDependencySchema = z.object({
  registry: z.enum(REGISTRIES).nullable(),
  ecosystem: z.string().max(20),
  name: z.string().max(214),
  reason: z.enum(SKIP_REASONS),
  priority: PrioritySchema,
  direct: z.union([z.boolean(), z.literal('unknown')]),
});

export const DependencyRegistryIntelSchema = z.object({
  version: z.literal('1'),
  status: z.enum(['analyzed', 'no_dependencies', 'disabled']),
  budget: z.object({
    max_dependencies: z.number().int(),
    max_requests: z.number().int(),
    max_elapsed_ms: z.number().int(),
    max_versions: z.number().int(),
    max_bytes: z.number().int(),
  }),
  coverage: z.object({
    /** Distinct (registry, package) pairs that could be looked up at all. */
    eligible: z.number().int().min(0),
    queried: z.number().int().min(0),
    ok: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    /** Of the eligible packages that are direct dependencies of the primary context. */
    direct_eligible: z.number().int().min(0),
    direct_queried: z.number().int().min(0),
    /** queried / eligible; null when nothing was eligible. Never "100%" for an unchecked package. */
    ratio: z.number().min(0).max(1).nullable(),
  }),
  /** Skipped dependencies by reason (all of them, counted). */
  skipped_counts: z.record(z.string(), z.number().int().min(0)),
  /** The highest-priority skipped dependencies, so a reader sees what the budget cost. */
  skipped: z.array(SkippedDependencySchema).max(40),
  packages: z.array(DependencyRegistryPackageSchema).max(100),
  events: z.array(DependencyRegistryEventSchema).max(120),
  events_total: z.number().int().min(0),
  requests: z.number().int().min(0),
  bytes: z.number().int().min(0),
  elapsed_ms: z.number().int().min(0),
  limits_hit: z.array(z.string().max(200)).max(10),
  /** What this analysis cannot say (stated, not hidden). */
  not_available: z.array(z.string().max(200)).max(8),
});
export type DependencyRegistryIntel = z.infer<typeof DependencyRegistryIntelSchema>;

export const EMPTY_DEP_REGISTRY_INTEL: DependencyRegistryIntel = {
  version: '1',
  status: 'disabled',
  budget: {
    max_dependencies: 0,
    max_requests: 0,
    max_elapsed_ms: 0,
    max_versions: 0,
    max_bytes: 0,
  },
  coverage: {
    eligible: 0,
    queried: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    direct_eligible: 0,
    direct_queried: 0,
    ratio: null,
  },
  skipped_counts: {},
  skipped: [],
  packages: [],
  events: [],
  events_total: 0,
  requests: 0,
  bytes: 0,
  elapsed_ms: 0,
  limits_hit: [],
  not_available: [],
};
