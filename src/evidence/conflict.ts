import { z } from 'zod';

/**
 * A reusable conflict model. Several subsystems can observe the SAME fact from different sources (manifest, lockfile,
 * SBOM, registry, later: build graph, release artifact, provenance). Instead of each subsystem overwriting one value with
 * another, every observation is kept, one is preferred FOR A NAMED QUESTION, and the reason is recorded.
 *
 * Source quality is described by facts a reader can reason about, not by a single trust number:
 *  - provenance: who produced it (the repository itself, a tool that derived it, a third-party service);
 *  - temporal:   whether it is bound to the analyzed revision or describes some other moment (today, history);
 *  - mutability: whether it could change independently of the analyzed revision.
 */
export const SOURCE_IDS = [
  'lockfile',
  'manifest_pin',
  'manifest_range',
  'sbom',
  'registry',
  'advisory_db',
  'build_graph',
  'release_artifact',
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SourceQualitySchema = z.object({
  provenance: z.enum(['first_party', 'derived', 'third_party']),
  temporal: z.enum(['revision_bound', 'current', 'historical']),
  mutability: z.enum(['immutable_for_revision', 'mutable']),
});
export type SourceQuality = z.infer<typeof SourceQualitySchema>;

/** Qualities are declared once, here, so every report explains them the same way. */
export const SOURCE_QUALITY: Record<SourceId, SourceQuality> = {
  lockfile: {
    provenance: 'derived',
    temporal: 'revision_bound',
    mutability: 'immutable_for_revision',
  },
  manifest_pin: {
    provenance: 'first_party',
    temporal: 'revision_bound',
    mutability: 'immutable_for_revision',
  },
  manifest_range: {
    provenance: 'first_party',
    temporal: 'revision_bound',
    mutability: 'immutable_for_revision',
  },
  sbom: { provenance: 'derived', temporal: 'revision_bound', mutability: 'immutable_for_revision' },
  registry: { provenance: 'third_party', temporal: 'current', mutability: 'mutable' },
  advisory_db: { provenance: 'third_party', temporal: 'current', mutability: 'mutable' },
  build_graph: {
    provenance: 'derived',
    temporal: 'revision_bound',
    mutability: 'immutable_for_revision',
  },
  release_artifact: { provenance: 'derived', temporal: 'revision_bound', mutability: 'mutable' },
};

export const ObservationSchema = z.object({
  source: z.enum(SOURCE_IDS),
  /** File, document or service the observation came from. */
  origin: z.string(),
  value: z.string(),
  quality: SourceQualitySchema,
});
export type Observation = z.infer<typeof ObservationSchema>;

export const ConflictSchema = z.object({
  id: z.string(),
  /** What the observations are about, e.g. `npm:qs`. */
  subject: z.string(),
  /** Which property differs, e.g. `exact_version`. */
  field: z.string(),
  observations: z.array(ObservationSchema).min(2),
  /** The source preferred for this question; absent when the policy has no opinion. */
  preferred: z.enum(SOURCE_IDS).optional(),
  resolution_reason: z.string().optional(),
  /** How sure we are that the observations genuinely disagree (a range check can be uncertain). */
  confidence: z.number().min(0).max(1),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  /** Ids (e.g. DEP-0001) of report items this conflict is about. */
  evidence_ids: z.array(z.string()),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/**
 * Preference order per question, strongest first. A question is a property such as the exact installed version of a
 * dependency; the same sources would be ordered differently for another question (e.g. "latest published version").
 */
export const PRECEDENCE: Record<string, readonly SourceId[]> = {
  exact_version: ['lockfile', 'sbom', 'manifest_pin'],
  requested_range: ['manifest_range'],
};

export function observation(source: SourceId, origin: string, value: string): Observation {
  return { source, origin, value, quality: SOURCE_QUALITY[source] };
}

function describe(q: SourceQuality): string {
  return `${q.temporal === 'revision_bound' ? 'bound to the analyzed revision' : `describes ${q.temporal === 'current' ? 'the present' : 'the past'}`}, ${q.provenance.replace('_', '-')}, ${q.mutability === 'mutable' ? 'can change independently' : 'cannot change for this revision'}`;
}

/** Builds a conflict and records WHY one source is preferred for `question`; never discards an observation. */
export function resolveConflict(input: {
  id: string;
  subject: string;
  field: string;
  question: keyof typeof PRECEDENCE | string;
  observations: Observation[];
  confidence: number;
  severity: Conflict['severity'];
  evidenceIds: string[];
}): Conflict {
  const order = PRECEDENCE[input.question] ?? [];
  const ranked = [...input.observations].sort((a, b) => {
    const ia = order.indexOf(a.source);
    const ib = order.indexOf(b.source);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const best = ranked[0];
  const second = ranked[1];
  const preferred = best && order.includes(best.source) ? best.source : undefined;
  const reason =
    preferred && best && second
      ? `For "${input.question}" the order is ${order.join(' > ')}. ${best.source} (${describe(best.quality)}) is preferred over ${second.source} (${describe(second.quality)}); the other value is kept, not discarded.`
      : undefined;
  return {
    id: input.id,
    subject: input.subject,
    field: input.field,
    observations: input.observations,
    ...(preferred ? { preferred } : {}),
    ...(reason ? { resolution_reason: reason } : {}),
    confidence: input.confidence,
    severity: input.severity,
    evidence_ids: input.evidenceIds,
  };
}
