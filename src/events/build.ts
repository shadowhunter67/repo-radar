import type { Governance } from '../governance/temporal.js';
import { isRelevantEvent } from '../registry/dependency-analysis.js';
import type { DependencyRegistryIntel } from '../registry/dependency-model.js';
import type { RegistryIntel } from '../registry/model.js';
import type { ReleaseIntel } from '../release/model.js';
import { correlate } from './correlate.js';
import { type Timeline, type TimelineEvent, type TemporalPattern } from './model.js';

const clean = (s: string, n = 120): string =>
  [...s]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)
    .join('')
    .slice(0, n);
const iso = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export interface TimelineInput {
  governance: Governance;
  registry: RegistryIntel;
  releases: ReleaseIntel;
  /** Registry history of the dependencies (schema 0.7). Each event keeps the package as its `entity`. */
  dependencyRegistry?: DependencyRegistryIntel;
  /** Events derived from the difference between two revisions (install hooks, capabilities...). */
  extra?: TimelineEvent[];
  patterns?: TemporalPattern[];
}

export const MAX_EVENTS = 200;

/** Events from the parts of a report. Pure. Every event keeps the ids of what it came from. */
export function buildTimeline(i: TimelineInput): Timeline {
  const events: TimelineEvent[] = [];
  let n = 0;
  const add = (e: Omit<TimelineEvent, 'id'>): void => {
    events.push({
      id: `EV-${++n}`,
      ...e,
      subject: clean(e.subject, 200),
      detail: clean(e.detail, 300),
    });
  };
  for (const s of i.governance.signals) {
    const at = iso(s.at);
    switch (s.kind) {
      case 'dormancy_gap':
        add({
          type: 'dormancy_end',
          at,
          subject: 'repository',
          source: 'git',
          detail: s.detail,
          confidence: s.confidence,
          evidence: [s.id],
        });
        break;
      case 'new_committer_after_dormancy':
        add({
          type: 'new_committer',
          at,
          subject: 'repository',
          source: 'git',
          detail: s.detail,
          confidence: s.confidence,
          evidence: [s.id],
        });
        break;
      case 'new_release_author':
        add({
          type: 'new_release_author',
          at,
          subject: 'release',
          source: 'github_release',
          detail: s.detail,
          confidence: s.confidence,
          evidence: [s.id],
        });
        break;
      default:
        break;
    }
  }
  for (const r of i.releases.releases.slice(0, 10)) {
    const at = iso(r.published_at);
    add({
      type: 'release',
      at,
      subject: `release ${r.tag}`,
      source: 'github_release',
      detail: `release ${clean(r.tag, 60)}${r.prerelease ? ' (pre-release)' : ''}`,
      confidence: 0.9,
      evidence: [`release:${clean(r.tag, 60)}`],
    });
    const bad = r.signatures.find((s) => s.subject === 'tag' && s.state === 'invalid');
    if (bad)
      add({
        type: 'signature_change',
        at,
        subject: `tag ${clean(r.tag, 60)}`,
        source: 'github_release',
        detail: 'the release tag signature is reported invalid',
        confidence: 0.7,
        evidence: [`release:${clean(r.tag, 60)}`],
      });
  }
  for (const p of i.registry.packages) {
    if (p.status !== 'ok' && p.status !== 'partial') continue;
    for (const v of p.versions.slice(0, 5))
      add({
        type: 'registry_publish',
        at: iso(v.published_at),
        subject: `${p.registry}:${clean(p.name, 80)}@${clean(v.version, 30)}`,
        source: 'registry',
        detail: `version ${clean(v.version, 40)} published${v.publisher ? ' by ' + v.publisher.name : ''}`,
        confidence: 0.9,
        evidence: [`registry:${p.registry}:${clean(p.name, 80)}`],
      });
  }
  for (const s of i.registry.signals) {
    const at = iso(s.at);
    if (s.kind === 'new_publisher')
      add({
        type: 'new_publisher',
        at,
        subject: `${s.registry}:${clean(s.package, 80)}`,
        source: 'registry',
        detail: s.detail,
        confidence: s.confidence,
        evidence: [s.id],
      });
    else if (s.kind === 'dormancy_then_publish')
      add({
        type: 'dormancy_end',
        at,
        subject: `${s.registry}:${clean(s.package, 80)}`,
        source: 'registry',
        detail: s.detail,
        confidence: s.confidence,
        evidence: [s.id],
      });
  }
  // Only events that matter to the analyzed revision enter the timeline: an ancient publisher change of a dependency pinned
  // long after it must not combine with another old event into a takeover pattern. The full list stays in the report.
  const depObserved = i.dependencyRegistry?.packages[0]?.observed_at ?? '';
  for (const e of (i.dependencyRegistry?.events ?? []).filter(
    (x) => !depObserved || isRelevantEvent(x, depObserved),
  )) {
    const entity = `${e.registry}:${clean(e.package, 80)}`;
    add({
      type: e.type,
      at: iso(e.at),
      subject: `${entity}@${clean(e.version, 30)}`,
      source: 'dependency_registry',
      detail: e.detail,
      confidence: e.confidence,
      evidence: [...e.evidence, e.id].slice(0, 8),
      entity,
    });
  }
  for (const e of i.extra ?? []) add({ ...e });
  events.sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));
  const kept = events.slice(-MAX_EVENTS);
  return {
    version: '1',
    events: kept,
    events_total: events.length,
    correlations: correlate(kept, i.patterns),
    not_available: [
      'external_domain_* events need a revision comparison (diff): one analysis has no introduction time',
      'maintainer_change / ownership_change: current-state only; per-version maintainers exist for npm dependencies',
      'dependency domains: dependency tarballs are never fetched, so they are not observed',
    ],
  };
}
