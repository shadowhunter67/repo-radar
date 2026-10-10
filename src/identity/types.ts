import { z } from 'zod';
import type { RepoSnapshot } from '../collectors/types.js';
import { ARTIFACT_TYPES } from './taxonomy.js';

export const SemanticIdentitySchema = z.object({
  repository_name: z.string(),
  normalized_name: z.string(),
  search_name: z.string(),
  /** Machine label from the taxonomy, or "unclassified". */
  canonical_type: z.string(),
  primary_function: z.string(),
  secondary_functions: z.array(z.string()),
  /** What the repository says about itself (description / manifest), sanitized, verbatim. */
  declared_summary: z.string().nullable(),
  ecosystem: z.array(z.string()),
  interfaces: z.array(z.string()),
  target_users: z.array(z.string()),
  search_aliases: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  /** Heuristic, never a verdict: how little the name overlaps with the detected purpose. */
  name_purpose_divergence: z.number().min(0).max(1).nullable(),
  /** Layer 1: kind of software artifact (library, cli, service, ...). */
  artifact_type: z.enum(ARTIFACT_TYPES),
  artifact_confidence: z.number().min(0).max(1),
  artifact_alternatives: z.array(z.enum(ARTIFACT_TYPES)),
  /** Layer 2: subject area (web, database, security, ...), "unknown" when unclassified. */
  domain: z.string(),
  /** Runner-up domain candidates with their share of the matched evidence (never forced into one label). */
  alternatives: z.array(z.object({ canonical_type: z.string(), share: z.number() })),
  /** Layer 3: capabilities observed by the static capability scan (filled after scanning; empty if not scanned). */
  capabilities: z.array(z.string()),
  /** Layer 4: deterministic evidence-based purpose sentence (not LLM generated). */
  purpose_summary: z.string(),
  taxonomy_version: z.string(),
  classifier: z.string(),
  /** Human-readable reasons that produced the classification. */
  evidence: z.array(z.string()),
});
export type SemanticIdentity = z.infer<typeof SemanticIdentitySchema>;

/**
 * Plug-in point. The default is a keyword/structure heuristic that needs no API key.
 * An LLM-backed classifier can implement this interface; scoring never depends on which one ran.
 */
export interface IdentityClassifier {
  readonly id: string;
  classify(snapshot: RepoSnapshot): SemanticIdentity | Promise<SemanticIdentity>;
}
