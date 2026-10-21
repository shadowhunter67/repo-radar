import { analyzeRepository, type AnalyzeOptions } from '../analyze.js';
import { BlobCache } from '../collectors/github/blobcache.js';
import type { Report } from '../report/schema.js';
import { sanitizeForTerminal } from '../util/text.js';
import { compareSnapshots, type HistoricalDiff } from './delta.js';
import {
  compareDependencyArtifacts,
  type DependencyArtifactDelta,
} from '../registry/artifacts/delta.js';

export * from './delta.js';

/** What is known about one analyzed revision (the comparison always names exact revisions). */
export interface SnapshotInfo {
  repository: string;
  requested_ref: string | null;
  commit: string | null;
  /** Commit timestamp when the analysis could read it. */
  commit_date: string | null;
  tool_version: string;
  schema_version: string;
  methodology: string;
  rules_digest: string;
  config_digest: string;
  http_requests: number;
  blob_reused: number;
  ms: number;
}

export function snapshotInfo(
  r: Report,
  requestedRef: string | null,
  ms: number,
  reused: number,
): SnapshotInfo {
  const head = r.evidence.find((e) => e.id === 'github.commits.head_date')?.value;
  return {
    repository: `${r.subject.owner}/${r.subject.repo}`,
    requested_ref: requestedRef,
    commit: r.subject.ref,
    commit_date: typeof head === 'string' ? head : null,
    tool_version: r.tool.version,
    schema_version: r.schema_version,
    methodology: r.methodology.version,
    rules_digest: r.methodology.rules_digest,
    config_digest: r.methodology.config_digest,
    http_requests: r.stats.http_requests,
    blob_reused: reused,
    ms,
  };
}

export interface RevisionComparison {
  from: SnapshotInfo;
  to: SnapshotInfo;
  diff: HistoricalDiff;
  behavior_delta: DependencyArtifactDelta[];
  /** Cost of the comparison: the second revision reuses blobs the first one already fetched. */
  cost: { total_requests: number; total_ms: number; blobs_reused: number };
}

/**
 * Analyze two exact revisions of one repository one after the other (never in parallel) with the same options and a shared
 * blob cache, then compare them. `to` omitted means the default branch head.
 */
export async function compareRevisions(
  repo: string,
  from: string,
  to: string | null,
  options: AnalyzeOptions = {},
  onReports?: (from: Report, to: Report) => void,
): Promise<RevisionComparison> {
  const cache = new BlobCache();
  const t0 = Date.now();
  const a = await analyzeRepository(repo, { ...options, ref: from, blobCache: cache });
  const msA = Date.now() - t0;
  const reusedA = cache.hits;
  const t1 = Date.now();
  const b = await analyzeRepository(repo, {
    ...options,
    ...(to ? { ref: to } : {}),
    blobCache: cache,
  });
  const msB = Date.now() - t1;
  onReports?.(a, b);
  const behaviorDelta: DependencyArtifactDelta[] = [];
  for (const after of b.dependency_artifacts.artifacts) {
    const before = a.dependency_artifacts.artifacts.find(
      (x) =>
        x.registry === after.registry && x.package === after.package && x.version !== after.version,
    );
    if (before) behaviorDelta.push(compareDependencyArtifacts(before, after));
  }
  const fromInfo = snapshotInfo(a, from, msA, reusedA);
  const toInfo = snapshotInfo(b, to, msB, cache.hits - reusedA);
  return {
    from: fromInfo,
    to: toInfo,
    diff: compareSnapshots(a, b),
    behavior_delta: behaviorDelta,
    cost: {
      total_requests: fromInfo.http_requests + toInfo.http_requests,
      total_ms: msA + msB,
      blobs_reused: cache.hits,
    },
  };
}

const clip = (s: string, n = 110): string => sanitizeForTerminal(s, n);

export function renderHistoricalText(d: HistoricalDiff, info?: RevisionComparison): string {
  const L: string[] = [];
  const short = (c: string | null): string => (c ? c.slice(0, 10) : 'unpinned');
  L.push(
    `repo-radar historical comparison: ${clip(d.from.repository)} ${short(d.from.commit)} -> ${short(d.to.commit)}`,
  );
  if (info)
    L.push(
      `from ${clip(info.from.commit_date ?? 'date unknown', 30)}  to ${clip(info.to.commit_date ?? 'date unknown', 30)}   (${info.cost.total_requests} requests, ${info.cost.blobs_reused} files reused, ${Math.round(info.cost.total_ms / 1000)} s)`,
    );
  L.push(
    `comparability: ${d.comparability.level}${d.comparability.score_deltas_meaningful ? '' : ' (score differences are not meaningful)'}`,
  );
  for (const c of d.caveats) L.push(`  caveat: ${clip(c, 200)}`);
  if (info?.behavior_delta.length) {
    L.push('', `behavior and trust-boundary deltas (${info.behavior_delta.length})`);
    for (const delta of info.behavior_delta.slice(0, 20)) {
      for (const event of [...delta.behavior, ...delta.trust_boundary])
        L.push(
          `  ${event.package} ${event.before_version} -> ${event.after_version}: ${clip(event.detail, 180)}`,
        );
      for (const reason of delta.not_available) L.push(`  unavailable: ${clip(reason, 180)}`);
    }
  }
  const section = (title: string, rows: string[]): void => {
    if (rows.length === 0) return;
    L.push('', `${title} (${rows.length})`, ...rows.slice(0, 40).map((r) => `  ${r}`));
    if (rows.length > 40) L.push(`  ... ${rows.length - 40} more`);
  };
  section(
    'IDENTITY',
    d.identity.map((c) => `${c.field}: ${clip(c.before, 50)} -> ${clip(c.after, 50)}`),
  );
  section(
    'CAPABILITIES',
    d.capabilities
      .filter((c) => c.change !== 'unchanged')
      .map(
        (c) =>
          `${c.capability.padEnd(20)} ${c.change.toUpperCase()}${c.certainty === 'inconclusive' ? ' (inconclusive: coverage incomplete)' : ''}${c.after ? `  risk ${c.after.risk}, ${c.after.contexts.join('/') || 'no context'}` : ''}`,
      ),
  );
  section(
    'EXECUTION PATHS',
    d.execution.map(
      (e) =>
        `${e.change.toUpperCase()}${e.for_dependents ? ' [runs for dependents]' : ''} ${clip(e.path, 150)}${e.certainty === 'inconclusive' ? ' (inconclusive)' : ''}`,
    ),
  );
  section(
    'EXTERNAL DOMAINS',
    d.domains.map(
      (x) =>
        `${x.kind.replace('_', ' ').toUpperCase()}${x.significance === 'passive' ? ' [passive: docs/tests/metadata]' : ''} ${clip(x.hostname, 70)} (${x.category}${x.after ? ', ' + x.after.strongest_context : ''}${x.before && x.after ? ', was ' + x.before.strongest_context : ''})${x.certainty === 'inconclusive' ? ' (inconclusive)' : ''}`,
    ),
  );
  section(
    'PROVENANCE, SIGNATURES, SOURCE BINDING',
    d.provenance.map(
      (x) =>
        `${x.kind.replace(/_/g, ' ')}: ${clip(x.subject, 60)} ${clip(x.before, 40)} -> ${clip(x.after, 40)}`,
    ),
  );
  section(
    'DEPENDENCIES',

    d.dependencies.map(
      (x) =>
        `${x.kind.replace(/_/g, ' ')}: ${clip(x.package, 60)}${x.before?.version || x.after?.version ? `  ${x.before?.version ?? x.before?.spec ?? ''} -> ${x.after?.version ?? x.after?.spec ?? ''}` : ''}${x.advisory_ids ? `  ${x.advisory_ids.join(',')}` : ''}${x.certainty === 'inconclusive' ? ' (inconclusive)' : ''}`,
    ),
  );
  section(
    'FINDINGS',
    d.findings.map((f) => `${f.change.toUpperCase()} [${f.severity}] ${clip(f.title, 100)}`),
  );
  section('POLICY', [
    ...d.policy.block_violations_added.map((v) => `block now violated: ${clip(v, 60)}`),
    ...d.policy.block_violations_removed.map((v) => `block no longer violated: ${clip(v, 60)}`),
    ...d.policy.violations_added.map((v) => `minimum now violated: ${clip(v, 60)}`),
    ...d.policy.violations_removed.map((v) => `minimum no longer violated: ${clip(v, 60)}`),
  ]);
  section(
    'COMPLIANCE INDICATORS',
    d.compliance.map((c) => `${clip(c.subject, 60)}: ${c.before} -> ${c.after}`),
  );
  section(
    'OTHER CHANGES',
    d.changes
      .filter((c) =>
        ['sbom_changed', 'governance_changed', 'persistence_added', 'persistence_removed'].includes(
          c.category,
        ),
      )
      .map(
        (c) =>
          `${c.category}: ${clip(c.subject, 50)} ${clip(c.before ?? '', 40)} -> ${clip(c.after ?? '', 40)}`,
      ),
  );
  L.push('', 'RISK DELTA');
  const fmt = (x: number | null): string => (x === null ? 'n/a' : String(x));
  if (d.risk.comparable)
    L.push(
      `  overall ${fmt(d.risk.overall.before)} -> ${fmt(d.risk.overall.after)}` +
        d.risk.dimensions
          .filter((x) => x.delta !== null && x.delta !== 0)
          .map((x) => `; ${x.dimension} ${fmt(x.before)} -> ${fmt(x.after)}`)
          .join(''),
    );
  else
    L.push(
      '  scores are not directly comparable between these analyses; interpretable reasons below still hold.',
    );
  for (const r of d.risk.reasons.slice(0, 30))
    L.push(`  ${r.direction === 'increase' ? '+' : '-'} ${clip(r.text, 140)}`);
  if (d.risk.reasons.length === 0) L.push('  no interpretable risk-relevant change found');
  L.push(
    '',
    'This is a description of differences between two analyses, not a verdict; intent is undetermined.',
  );
  return L.join('\n') + '\n';
}
