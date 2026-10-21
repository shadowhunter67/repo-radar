import {
  INDICATOR_STATEMENT,
  type Correlation,
  type TemporalPattern,
  type TimelineEvent,
} from './model.js';

/**
 * Generic temporal correlation. A pattern is DATA (ordered steps of event types, a window); nothing here knows about any
 * particular attack narrative. For each pattern the engine finds the match with the smallest span: events sorted by time, a
 * step may take an event at the same time as the previous step (ties allowed), and the first-to-last distance must be within
 * the window. At most one correlation per pattern is reported (the tightest), so a noisy history cannot flood the report.
 */
export const BUILTIN_PATTERNS: TemporalPattern[] = [
  {
    id: 'new-publisher-then-release',
    description: 'A new registry publisher appears and a release or publication follows closely',
    steps: [
      { any_of: ['new_publisher', 'publisher_change'] },
      { any_of: ['release', 'registry_publish'] },
    ],
    within_days: 7,
  },
  {
    id: 'dormancy-new-actor-release',
    description: 'A dormant project resumes with a new account and a release follows',
    steps: [
      { any_of: ['dormancy_end'] },
      {
        any_of: [
          'new_committer',
          'new_publisher',
          'new_release_author',
          'publisher_change',
          'maintainer_change',
          'ownership_change',
        ],
      },
      { any_of: ['release', 'registry_publish'] },
    ],
    within_days: 45,
  },
  {
    id: 'actor-change-then-install-hook',
    description:
      'A change of committer, publisher or ownership is followed by a new install-time hook',
    steps: [
      {
        any_of: [
          'new_committer',
          'new_publisher',
          'new_release_author',
          'publisher_change',
          'maintainer_change',
          'ownership_change',
          'dormancy_end',
        ],
      },
      { any_of: ['install_hook_introduced'] },
    ],
    within_days: 60,
  },
  {
    id: 'release-with-new-capability-or-domain',
    description: 'A release closely follows a new risky capability or a new external domain',
    steps: [
      {
        any_of: ['capability_introduced', 'external_domain_introduced', 'install_hook_introduced'],
      },
      { any_of: ['release', 'registry_publish'] },
    ],
    within_days: 14,
  },
  {
    id: 'dependency-takeover-indicators',
    description:
      'A dependency resumes after a long gap or changes publisher/maintainer, then gains an install-time script, a different source repository or loses its provenance',
    steps: [
      {
        any_of: [
          'dependency_dormancy_ended',
          'dependency_publisher_changed',
          'dependency_maintainer_changed',
        ],
      },
      {
        any_of: [
          'dependency_install_hook_introduced',
          'dependency_repository_changed',
          'dependency_provenance_removed',
        ],
      },
    ],
    within_days: 90,
    same_entity: true,
    superseded_by: 'dependency-control-change-then-install-capability',
  },
  {
    id: 'dependency-control-change-then-install-capability',
    description:
      'A dependency publisher or maintainer change is followed by a verified install-time capability or external domain change',
    steps: [
      { any_of: ['dependency_publisher_changed', 'dependency_maintainer_changed'] },
      {
        any_of: [
          'dependency_install_hook_introduced',
          'dependency_behavior_introduced',
          'dependency_external_domain_introduced',
        ],
      },
    ],
    within_days: 90,
    same_entity: true,
  },
  {
    id: 'dependency-introduced-with-risky-behavior',
    description:
      'A newly introduced dependency has verified install-time behavior or an external domain',
    steps: [
      { any_of: ['dependency_introduced'] },
      {
        any_of: [
          'dependency_behavior_introduced',
          'dependency_install_hook_introduced',
          'dependency_external_domain_introduced',
        ],
      },
    ],
    within_days: 90,
    same_entity: true,
  },
  {
    id: 'dependency-dormancy-publisher-hook',
    description:
      'A dependency resumes after a long gap, a different account publishes, and an install-time script appears',
    steps: [
      { any_of: ['dependency_dormancy_ended'] },
      { any_of: ['dependency_publisher_changed', 'dependency_maintainer_changed'] },
      { any_of: ['dependency_install_hook_introduced'] },
    ],
    within_days: 120,
    same_entity: true,
  },
  {
    id: 'dependency-publisher-change-then-new-domain',
    description:
      'A dependency changes publisher or maintainers and, shortly after, the analyzed repository introduces a new external domain',
    steps: [
      { any_of: ['dependency_publisher_changed', 'dependency_maintainer_changed'] },
      { any_of: ['external_domain_introduced'] },
    ],
    within_days: 30,
  },
  {
    id: 'dependency-publisher-provenance-domain',
    description:
      'A dependency publisher change or provenance loss is followed by a new install-time domain',
    steps: [
      { any_of: ['dependency_publisher_changed'] },
      { any_of: ['dependency_provenance_removed'] },
      { any_of: ['dependency_external_domain_introduced'] },
    ],
    within_days: 90,
    same_entity: true,
  },
  {
    id: 'dependency-artifact-hook-after-publisher-change',
    description: 'A dependency publisher change is followed by an artifact install hook',
    steps: [
      { any_of: ['dependency_publisher_changed'] },
      { any_of: ['dependency_install_hook_introduced'] },
    ],
    within_days: 90,
    same_entity: true,
  },
  {
    id: 'dependency-name-confusion-new-dependency',
    description:
      'A possible package-name confusion indicator is observed on a newly introduced dependency',
    steps: [{ any_of: ['dependency_change'] }, { any_of: ['dependency_name_confusion'] }],
    within_days: 90,
    same_entity: true,
  },
  {
    id: 'provenance-loss-then-release',
    description:
      'Verified provenance or source binding is lost or changes, and a release or publication follows closely',
    steps: [
      {
        any_of: [
          'provenance_removed',
          'provenance_verification_changed',
          'source_binding_changed',
          'dependency_provenance_removed',
        ],
      },
      { any_of: ['release', 'registry_publish'] },
    ],
    within_days: 14,
  },
];

const DAY = 86_400_000;
const time = (e: TimelineEvent): number => (e.at ? Date.parse(e.at) : NaN);

export function correlate(
  events: TimelineEvent[],
  patterns: TemporalPattern[] = BUILTIN_PATTERNS,
): Correlation[] {
  const timed = events
    .filter((e) => Number.isFinite(time(e)))
    .sort((a, b) => time(a) - time(b) || (a.id < b.id ? -1 : 1));
  const firstAt = timed.map((e, i) => {
    let j = i;
    while (j > 0 && time(timed[j - 1] as TimelineEvent) === time(e)) j--;
    return j;
  });
  const out: Correlation[] = [];
  for (const p of patterns) {
    let best: { ids: string[]; start: number; end: number; entity?: string } | undefined;
    let budget = 200_000; // hard bound on the search, whatever the input
    const search = (stepIdx: number, from: number, chain: TimelineEvent[]): void => {
      if (--budget < 0) return;
      if (stepIdx === p.steps.length) {
        const start = time(chain[0]!);
        const end = time(chain[chain.length - 1]!);
        if (end - start <= p.within_days * DAY && (!best || end - start < best.end - best.start))
          best = {
            ids: chain.map((c) => c.id),
            start,
            end,
            ...(p.same_entity && chain[0]?.entity ? { entity: chain[0].entity } : {}),
          };
        return;
      }
      const step = p.steps[stepIdx]!;
      for (let i = from; i < timed.length; i++) {
        const e = timed[i]!;
        if (chain.length > 0 && time(e) - time(chain[0]!) > p.within_days * DAY) break;
        if (!step.any_of.includes(e.type)) continue;
        if (chain.some((c) => c.id === e.id)) continue;
        if (p.same_entity && chain.length > 0 && (e.entity ?? '') !== (chain[0]?.entity ?? ''))
          continue;
        if (p.same_entity && chain.length === 0 && !e.entity) continue;
        // events at the SAME instant may satisfy the following steps in any order, so the next step restarts at the first
        // event of this instant rather than after this one
        search(stepIdx + 1, firstAt[i] as number, [...chain, e]);
      }
    };
    search(0, 0, []);
    if (best)
      out.push({
        pattern_id: p.id,
        description: p.description,
        event_ids: best.ids,
        start: new Date(best.start).toISOString(),
        end: new Date(best.end).toISOString(),
        span_days: Math.round(((best.end - best.start) / DAY) * 10) / 10,
        ...(best.entity ? { entity: best.entity } : {}),
        statement: INDICATOR_STATEMENT,
        category:
          p.id.includes('control-change') || p.id.includes('takeover')
            ? 'governance_anomaly'
            : p.id.includes('risky-behavior')
              ? 'behavioral_risk_change'
              : undefined,
      });
  }
  return out;
}
