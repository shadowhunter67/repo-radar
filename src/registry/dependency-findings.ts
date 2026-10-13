import type { Finding } from '../analysis/findings.js';
import type { Correlation } from '../events/model.js';
import type { Fact } from '../facts/index.js';
import type { DependencyRegistryIntel, DepEventType } from './dependency-model.js';
import type { RepoMatch } from './model.js';

/**
 * Findings and facts from dependency registry intelligence. Findings are SIGNALS about observable registry history: a new
 * publisher is also what a legitimate hand-over looks like, and every finding says intent is undetermined. Facts follow the
 * asymmetry the project uses everywhere: the PRESENCE of an event is evidence at any coverage, its ABSENCE only counts when
 * every eligible dependency was actually queried and answered. Unknown never reads as stable.
 */
const safe = (s: string, n = 80): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, n);

const EVENT_TEXT: Record<
  DepEventType,
  { title: string; severity: Finding['severity']; remediation: string }
> = {
  dependency_publisher_changed: {
    title: 'A dependency version was published by an account new to its sampled history',
    severity: 'low',
    remediation:
      'Confirm the change of publisher with the dependency through an independent channel and review the diff between the last two versions before upgrading.',
  },
  dependency_maintainer_changed: {
    title: 'The maintainer set recorded with a dependency version changed',
    severity: 'low',
    remediation:
      'Check the maintainers announced by the project and review what changed in the version that carried the change.',
  },
  dependency_repository_changed: {
    title: 'A dependency now declares a different source repository',
    severity: 'medium',
    remediation:
      'Verify that the new repository is the legitimate home of the project (rename or transfer) before trusting its releases.',
  },
  dependency_dormancy_ended: {
    title: 'A dependency published a version after a long gap',
    severity: 'info',
    remediation: 'Review what changed in the version that ended the gap, and who published it.',
  },
  dependency_release_cadence_changed: {
    title: 'A dependency release cadence changed sharply',
    severity: 'info',
    remediation: 'Review the recent versions together and compare them with earlier ones.',
  },
  dependency_provenance_added: {
    title: 'A dependency version now reports a provenance attestation',
    severity: 'info',
    remediation: 'Verify the attestation (--verify-crypto covers this repository only).',
  },
  dependency_provenance_removed: {
    title: 'A dependency version no longer reports a provenance attestation',
    severity: 'low',
    remediation:
      'Find out why provenance stopped (a different publishing path?) and pin to a version that has it if you rely on it.',
  },
  dependency_install_hook_introduced: {
    title: 'A dependency version introduced an install-time script',
    severity: 'medium',
    remediation:
      'Read the install script of that version, or install with scripts disabled (for example npm --ignore-scripts) until reviewed.',
  },
};

export function buildDependencyRegistryFindings(
  intel: DependencyRegistryIntel,
  correlations: Correlation[] = [],
): Finding[] {
  if (intel.status !== 'analyzed') return [];
  const out: Finding[] = [];
  let n = 0;
  const id = (): string => `RR-DEPREG-${String(++n).padStart(3, '0')}`;
  const base = {
    dimension: 'supply-chain' as const,
    category: 'registry' as const,
    rule_ids: [] as string[],
    standards: [] as string[],
    intent: 'undetermined' as const,
  };
  const rank = { high: 3, medium: 2, low: 1, info: 0 } as const;
  // Repository correspondence first: a conflicting pointer is a state, not an event.
  for (const p of intel.packages) {
    if (p.repository.match !== 'conflicting') continue;
    out.push({
      ...base,
      id: id(),
      title: 'A dependency registry record points to conflicting source repositories',
      severity: 'medium',
      confidence: 0.7,
      evidence_ids: [`depregistry:${p.registry}:${safe(p.name)}`],
      summary: `${p.registry}:${safe(p.name)}: ${safe(p.repository.reason, 200)}. The same package name does not prove the same project.`,
      remediation:
        'Compare the package name, publisher and source URLs before relying on it; prefer a package whose registry and index metadata agree.',
    });
  }
  // Events: events that happened AFTER the resolved version cannot have affected the analyzed revision.
  const events = [...intel.events].sort(
    (a, b) =>
      rank[EVENT_TEXT[b.type].severity] - rank[EVENT_TEXT[a.type].severity] ||
      Date.parse(b.at) - Date.parse(a.at),
  );
  for (const e of events.slice(0, 24)) {
    const t = EVENT_TEXT[e.type];
    const after = e.relative_to_resolved === 'after';
    out.push({
      ...base,
      id: id(),
      title: t.title,
      severity: after && t.severity !== 'info' ? 'low' : t.severity,
      confidence: e.confidence,
      evidence_ids: [e.id, ...e.evidence].slice(0, 4),
      summary: `${e.registry}:${safe(e.package)}@${safe(e.version, 40)} (${e.at.slice(0, 10)}): ${safe(e.detail, 200)}.${
        after
          ? ' This happened after the version the analyzed revision resolves; it matters when upgrading.'
          : e.relative_to_resolved === 'unknown'
            ? ' The version the analyzed revision uses is not known, so this may or may not apply to it.'
            : ''
      } Intent is undetermined.`,
      remediation: t.remediation,
    });
  }
  for (const c of correlations.filter((x) => x.pattern_id.startsWith('dependency-'))) {
    out.push({
      ...base,
      id: id(),
      title: 'Dependency supply-chain takeover indicators observed',
      severity: 'medium',
      confidence: 0.5,
      evidence_ids: c.event_ids.slice(0, 6),
      summary: `${c.description} (${c.start.slice(0, 10)} to ${c.end.slice(0, 10)}${c.entity ? ', ' + safe(c.entity) : ''}). ${c.statement}`,
      remediation:
        'Treat the dependency as needing manual review: read the diff of the versions in the window and confirm the change of control with the project.',
    });
  }
  return out;
}

const RANK: Record<RepoMatch, number> = {
  conflicting: 4,
  unknown: 3,
  missing: 2,
  likely: 1,
  confirmed: 0,
};

export function deriveDependencyRegistryFacts(
  intel: DependencyRegistryIntel,
  correlations: Correlation[] = [],
): Fact[] {
  if (intel.status !== 'analyzed' || intel.coverage.queried === 0) return [];
  const facts: Fact[] = [];
  const from = intel.packages.map((p) => `depregistry:${p.registry}:${safe(p.name)}`).slice(0, 10);
  const f = (idv: string, value: number | boolean | string, conf = 0.8): void => {
    facts.push({
      id: idv,
      value,
      confidence: conf,
      scope: 'registry',
      derived_from: from,
      derived_by: 'dependency-registry@0.1',
    });
  };
  const ok = intel.packages.filter((p) => p.status === 'ok' || p.status === 'partial');
  const complete = intel.coverage.skipped === 0 && intel.coverage.failed === 0;
  f('registry.deps.queried', intel.coverage.queried, 0.95);
  if (intel.coverage.ratio !== null) f('registry.deps.coverage', intel.coverage.ratio, 0.95);
  f('registry.deps.lookup_complete', complete, 0.95);
  const types = new Set(intel.events.map((e) => e.type));
  const present = (t: DepEventType, id: string, confidence: number): void => {
    // presence is evidence at any coverage; absence only when every eligible package answered
    if (types.has(t)) f(id, true, confidence);
    else if (complete) f(id, false, Math.min(confidence, 0.7));
  };
  present('dependency_publisher_changed', 'registry.deps.publisher_changed', 0.6);
  present('dependency_maintainer_changed', 'registry.deps.maintainer_changed', 0.6);
  present('dependency_repository_changed', 'registry.deps.repository_changed', 0.7);
  present('dependency_install_hook_introduced', 'registry.deps.install_hook_introduced', 0.75);
  present('dependency_provenance_removed', 'registry.deps.provenance_removed', 0.7);
  const takeover = correlations.some((c) => c.pattern_id.startsWith('dependency-'));
  if (takeover) f('registry.deps.takeover_indicators', true, 0.5);
  else if (complete) f('registry.deps.takeover_indicators', false, 0.5);
  // worst correspondence among queried packages; failed lookups are `unknown`, not `confirmed`
  if (ok.length > 0 || intel.packages.length > 0) {
    const worst = intel.packages.reduce<RepoMatch>(
      (w, p) => (RANK[p.repository.match] > RANK[w] ? p.repository.match : w),
      'confirmed',
    );
    f('registry.deps.repository_match', worst, complete ? 0.8 : 0.5);
  }
  // npm provenance only: other registries do not report it per version
  const npm = ok.filter((p) => p.registry === 'npm');
  if (npm.length > 0)
    f(
      'registry.deps.provenance_reported',
      npm.every((p) => p.versions[0]?.has_provenance === true),
      0.7,
    );
  return facts;
}
