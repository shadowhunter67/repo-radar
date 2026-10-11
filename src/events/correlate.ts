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
  const out: Correlation[] = [];
  for (const p of patterns) {
    let best: { ids: string[]; start: number; end: number } | undefined;
    let budget = 200_000; // hard bound on the search, whatever the input
    const search = (stepIdx: number, from: number, chain: TimelineEvent[]): void => {
      if (--budget < 0) return;
      if (stepIdx === p.steps.length) {
        const start = time(chain[0]!);
        const end = time(chain[chain.length - 1]!);
        if (end - start <= p.within_days * DAY && (!best || end - start < best.end - best.start))
          best = { ids: chain.map((c) => c.id), start, end };
        return;
      }
      const step = p.steps[stepIdx]!;
      for (let i = from; i < timed.length; i++) {
        const e = timed[i]!;
        if (chain.length > 0 && time(e) - time(chain[0]!) > p.within_days * DAY) break;
        if (!step.any_of.includes(e.type)) continue;
        if (chain.some((c) => c.id === e.id)) continue;
        search(stepIdx + 1, i, [...chain, e]);
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
        statement: INDICATOR_STATEMENT,
      });
  }
  return out;
}
