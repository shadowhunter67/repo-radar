import {
  ACTIVE_CONTEXTS,
  contextRank,
  type DomainCategory,
  type DomainContext,
  type ExternalDomain,
  type ExternalDomains,
} from './model.js';

/**
 * Difference between the external domains of two revisions of one repository. Pure.
 *
 * - `introduced`: a host appears that the earlier revision did not refer to.
 * - `removed`: a host no longer appears (only an observation when both scans were complete: unread code is not removed code).
 * - `context_changed`: the same host now sits in a different strongest context (for example runtime -> install).
 *
 * `significance` separates references that can run (install, build, CI, container, release, runtime) from text a human reads
 * (docs, tests, metadata, comments): only `active` changes become timeline events.
 */
export interface DomainDelta {
  kind: 'introduced' | 'removed' | 'context_changed';
  hostname: string;
  category: DomainCategory;
  before: { strongest_context: DomainContext; contexts: DomainContext[] } | null;
  after: { strongest_context: DomainContext; contexts: DomainContext[] } | null;
  significance: 'active' | 'passive';
  /** Confidence of the strongest reference of the revision that carries the new state. */
  confidence: number;
  certainty: 'observed' | 'inconclusive';
  evidence_ids: string[];
}

export function domainDeltas(
  a: ExternalDomains | undefined,
  b: ExternalDomains | undefined,
  removalInconclusive: boolean,
): DomainDelta[] {
  if (!a || !b || a.status !== 'analyzed' || b.status !== 'analyzed') return [];
  const ia = new Map(a.domains.map((d) => [d.hostname, d]));
  const ib = new Map(b.domains.map((d) => [d.hostname, d]));
  const state = (d: ExternalDomain) => ({
    strongest_context: d.strongest_context,
    contexts: d.contexts,
  });
  const evid = (d: ExternalDomain): string[] => [`domain:${d.hostname}`];
  const out: DomainDelta[] = [];
  for (const [host, d] of ib) {
    const o = ia.get(host);
    const active = ACTIVE_CONTEXTS.has(d.strongest_context);
    if (!o) {
      out.push({
        kind: 'introduced',
        hostname: host,
        category: d.category,
        before: null,
        after: state(d),
        significance: active ? 'active' : 'passive',
        confidence: d.confidence,
        certainty: 'observed',
        evidence_ids: evid(d),
      });
    } else if (o.strongest_context !== d.strongest_context) {
      const wasActive = ACTIVE_CONTEXTS.has(o.strongest_context);
      out.push({
        kind: 'context_changed',
        hostname: host,
        category: d.category,
        before: state(o),
        after: state(d),
        // a move between an active and a passive context, or a move to a stronger active context, matters
        significance:
          active &&
          (!wasActive || contextRank(d.strongest_context) < contextRank(o.strongest_context))
            ? 'active'
            : 'passive',
        confidence: d.confidence,
        certainty: 'observed',
        evidence_ids: evid(d),
      });
    }
  }
  for (const [host, o] of ia) {
    if (ib.has(host)) continue;
    out.push({
      kind: 'removed',
      hostname: host,
      category: o.category,
      before: state(o),
      after: null,
      significance: ACTIVE_CONTEXTS.has(o.strongest_context) ? 'active' : 'passive',
      confidence: o.confidence,
      certainty: removalInconclusive ? 'inconclusive' : 'observed',
      evidence_ids: evid(o),
    });
  }
  const order = { introduced: 0, context_changed: 1, removed: 2 } as const;
  return out.sort(
    (x, y) =>
      order[x.kind] - order[y.kind] ||
      Number(y.significance === 'active') - Number(x.significance === 'active') ||
      (x.hostname < y.hostname ? -1 : 1),
  );
}
