import type { RepoSnapshot } from '../collectors/types.js';
import { EvidenceBuilder, type Clock } from '../evidence/builder.js';
import type { Evidence } from '../evidence/types.js';
import { normalizeName } from './normalize.js';
import type { SemanticIdentity } from './types.js';

export { HeuristicClassifier } from './heuristic.js';
export { loadDefaultTaxonomy, parseTaxonomy } from './taxonomy.js';
export { normalizeName } from './normalize.js';
export type { IdentityClassifier, SemanticIdentity } from './types.js';

/** Turn an identity into evidence so scoring rules can reference it like any other signal. */
export function identityEvidence(
  id: SemanticIdentity,
  snapshot: RepoSnapshot,
  clock: Clock,
): Evidence[] {
  const b = new EvidenceBuilder('identity', clock);
  const common = { kind: 'heuristic' as const, metadata: { classifier: id.classifier } };
  b.add('identity.canonical_type', id.canonical_type, common);
  b.add('identity.confidence', id.confidence, { ...common, confidence: 1 });
  b.add('identity.interfaces', id.interfaces, common);
  if (id.name_purpose_divergence !== null) {
    b.add('identity.name_purpose_divergence', id.name_purpose_divergence, {
      ...common,
      confidence: id.confidence,
    });
  }
  b.add('identity.name_normalization_lossy', normalizeName(snapshot.displayName).lossy, {
    kind: 'fact',
  });
  return b.evidence;
}
