import { z } from 'zod';

/**
 * Unified temporal events. Everything that happened at a known time - from git history, GitHub releases, registry publish
 * history and the difference between two analyzed revisions - is one event with a timestamp, a subject, a source, evidence
 * ids and a confidence. Events are observations; correlating them (src/events/correlate.ts) reports patterns of events in
 * a time window and never says anything about intent.
 *
 * An event WITHOUT a timestamp is kept in the list but can never take part in a correlation: unknown time is not "close in
 * time".
 */
export const EVENT_TYPES = [
  'commit',
  'dormancy_end',
  'new_committer',
  'release',
  'new_release_author',
  'tag',
  'registry_publish',
  'new_publisher',
  'publisher_change',
  'maintainer_change',
  'ownership_change',
  'dependency_change',
  'install_hook_introduced',
  'capability_introduced',
  'external_domain_introduced',
  'provenance_change',
  'signature_change',
  // dependency registry history (schema 0.7)
  'dependency_publisher_changed',
  'dependency_maintainer_changed',
  'dependency_repository_changed',
  'dependency_dormancy_ended',
  'dependency_release_cadence_changed',
  'dependency_provenance_added',
  'dependency_provenance_removed',
  'dependency_install_hook_introduced',
  'dependency_external_domain_introduced',
  'dependency_external_domain_removed',
  'dependency_external_domain_context_changed',
  'dependency_name_confusion',
  // revision-to-revision changes of the analyzed repository (schema 0.7)
  'external_domain_removed',
  'external_domain_context_changed',
  'provenance_added',
  'provenance_removed',
  'provenance_verification_changed',
  'source_binding_changed',
  'signature_state_changed',
  'registry_repository_correspondence_changed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SOURCES = [
  'git',
  'github_release',
  'registry',
  'dependency_registry',
  'analysis_diff',
] as const;

export const TimelineEventSchema = z.object({
  id: z.string().max(80),
  type: z.enum(EVENT_TYPES),
  /** ISO timestamp, or null when the time is unknown (such events are never correlated). */
  at: z.string().nullable(),
  /** What the event is about: a tag, a package, a capability, an account. Sanitized. */
  subject: z.string().max(200),
  source: z.enum(EVENT_SOURCES),
  detail: z.string().max(300),
  confidence: z.number().min(0).max(1),
  /** Ids in the report (governance signals, registry signals, hooks, releases) this event is derived from. */
  evidence: z.array(z.string().max(120)).max(8),
  /**
   * What the event is about, as one key (`npm:left-pad`, `repository`). Patterns with `same_entity` only match events that
   * share it, so a publisher change of one dependency never combines with an install hook of another. Absent = the repository.
   */
  entity: z.string().max(240).optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

/** A step is satisfied by any event of one of the listed types. */
export const PatternStepSchema = z
  .object({ any_of: z.array(z.enum(EVENT_TYPES)).min(1).max(8) })
  .strict();
export const TemporalPatternSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,60}$/),
    description: z.string().min(5).max(300),
    steps: z.array(PatternStepSchema).min(2).max(6),
    /** First to last event must fall inside this many days. Steps must occur in the listed order (ties allowed). */
    within_days: z.number().min(0).max(3650),
    /** All matched events must be about the same entity (see `TimelineEvent.entity`). */
    same_entity: z.boolean().optional(),
  })
  .strict();
export type TemporalPattern = z.infer<typeof TemporalPatternSchema>;

export const CorrelationSchema = z.object({
  pattern_id: z.string().max(60),
  description: z.string().max(300),
  event_ids: z.array(z.string().max(80)).max(6),
  start: z.string(),
  end: z.string(),
  span_days: z.number().min(0),
  /** The shared entity when the pattern requires `same_entity`. */
  entity: z.string().max(240).optional(),
  /** Always the same: a pattern of events, not a verdict. */
  statement: z.string().max(300),
});
export type Correlation = z.infer<typeof CorrelationSchema>;

export const TimelineSchema = z.object({
  version: z.literal('1'),
  events: z.array(TimelineEventSchema).max(200),
  events_total: z.number().int().min(0),
  correlations: z.array(CorrelationSchema).max(20),
  /** Event types the model knows but this analysis could not produce (stated, not hidden). */
  not_available: z.array(z.string().max(120)).max(10),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export const EMPTY_TIMELINE: Timeline = {
  version: '1',
  events: [],
  events_total: 0,
  correlations: [],
  not_available: [],
};

export const INDICATOR_STATEMENT =
  'Pattern of events observed within the time window; supply-chain risk indicator only. Intent is undetermined.';
