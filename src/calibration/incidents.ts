import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCrates, parseNpm } from '../registry/parse.js';
import { BUILTIN_PATTERNS, correlate } from '../events/correlate.js';
import type { TemporalPattern, TimelineEvent } from '../events/model.js';
import { dependencyEvents } from '../registry/dependency-analysis.js';

export type IncidentLabel = 'true' | 'false' | 'unknown';
export type IncidentEvent = { type: string; version: string; date: string };
export type IncidentCase = {
  id: string;
  package: string;
  ecosystem: 'npm' | 'crates.io';
  raw_file: string;
  split: 'development' | 'validation' | 'holdout';
  kind: 'incident' | 'benign_handoff' | 'benign_control';
  incident_window: { from: string; to: string };
  known_good_window: { from: string; to: string };
  resolved_version_candidates: string[];
  labels: Record<string, IncidentLabel>;
  expected_events: IncidentEvent[];
  pattern_expectations: Record<string, { should_fire: boolean | null; justification: string }>;
  conclusion: string;
  incident_confidence: 'low' | 'medium' | 'high';
  sources: string[];
  notes: string;
};

export const INCIDENT_LABELS = [
  'publisher_change',
  'maintainer_change',
  'repository_change',
  'dormancy_end',
  'release_cadence_change',
  'install_script_introduced',
  'provenance_changed',
  'external_domain_introduced',
] as const;
/**
 * The split is decided by the PACKAGE (ecosystem + name), never by the case id: several cases may describe the same registry
 * history (different windows), and a history seen in development must not reappear in the holdout.
 */
export function assignIncidentSplit(ecosystem: string, pkg: string): IncidentCase['split'] {
  const n = createHash('sha256').update(`${ecosystem}:${pkg}`).digest()[0]! % 10;
  return n < 6 ? 'development' : n < 8 ? 'validation' : 'holdout';
}
export function loadIncidentCases(root: string): IncidentCase[] {
  return JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8')) as IncidentCase[];
}
export const PATTERN_IDS = [
  'dependency-takeover-indicators',
  'dependency-dormancy-publisher-hook',
] as const;

/** Run the REAL correlation engine over the case's events inside its window. `withinDays` overrides every pattern's window. */
export function firePatterns(
  events: { type: string; at: string; version: string; id: string }[],
  c: Pick<IncidentCase, 'incident_window' | 'package' | 'ecosystem'>,
  withinDays?: number,
): Record<string, boolean> {
  const from = Date.parse(c.incident_window.from);
  const to = Date.parse(c.incident_window.to);
  const tl: TimelineEvent[] = events
    .filter((e) => Date.parse(e.at) >= from && Date.parse(e.at) <= to)
    .map((e) => ({
      id: e.id,
      type: e.type as TimelineEvent['type'],
      at: e.at,
      subject: `${c.package}@${e.version}`,
      source: 'dependency_registry' as const,
      detail: e.type,
      confidence: 0.5,
      evidence: [],
      entity: `${c.ecosystem}:${c.package}`,
    }));
  const patterns: TemporalPattern[] = BUILTIN_PATTERNS.filter((p) =>
    (PATTERN_IDS as readonly string[]).includes(p.id),
  ).map((p) => (withinDays === undefined ? p : { ...p, within_days: withinDays }));
  const fired = new Set(correlate(tl, patterns).map((x) => x.pattern_id));
  return Object.fromEntries(PATTERN_IDS.map((id) => [id, fired.has(id)]));
}

export function evaluateIncidentCase(
  c: IncidentCase,
  root: string,
  withinDays?: number,
): {
  events: string[];
  expected_events: IncidentEvent[];
  observations: Record<string, boolean>;
  abstentions: string[];
  patterns: Record<string, boolean>;
} {
  const body = JSON.parse(readFileSync(join(root, c.raw_file), 'utf8')) as unknown;
  const pkg =
    c.ecosystem === 'npm'
      ? parseNpm(body, {
          name: c.package,
          declaredBy: 'calibration',
          observedAt: c.incident_window.to,
          resolvedVersions: c.resolved_version_candidates,
          capVersions: 40,
        })
      : parseCrates(
          body,
          {},
          {
            name: c.package,
            declaredBy: 'calibration',
            observedAt: c.incident_window.to,
            resolvedVersions: c.resolved_version_candidates,
            capVersions: 40,
          },
        );
  const events = dependencyEvents(pkg, c.resolved_version_candidates).events;
  const types = new Set(events.map((e) => e.type));
  const observations: Record<string, boolean> = {
    publisher_change: types.has('dependency_publisher_changed'),
    maintainer_change: types.has('dependency_maintainer_changed'),
    repository_change: types.has('dependency_repository_changed'),
    dormancy_end: types.has('dependency_dormancy_ended'),
    release_cadence_change: types.has('dependency_release_cadence_changed'),
    install_script_introduced: types.has('dependency_install_hook_introduced'),
    provenance_changed:
      types.has('dependency_provenance_added') || types.has('dependency_provenance_removed'),
    external_domain_introduced: false,
  };
  const abstentions = INCIDENT_LABELS.filter((x) => c.labels[x] === 'unknown');
  const patterns = firePatterns(events, c, withinDays);
  return {
    events: events.map((e) => e.type),
    expected_events: c.expected_events,
    observations,
    abstentions,
    patterns,
  };
}
