import { z } from 'zod';
import type { HistoricalDiff } from '../history/delta.js';
import type { Report } from '../report/schema.js';

/**
 * Software Trust Graph projection. A VIEW derived from a report (and optionally a revision diff) with plain TypeScript
 * structures: no graph database, no inference. Its purpose is semantic normalization - repository, commit, release, asset,
 * package, publisher, maintainer, dependency, attestation, signature, capability and finding as one vocabulary - so that
 * questions about how they connect do not need yet another bespoke structure.
 *
 * Rules the builder enforces:
 *  - an edge without at least one evidence id is NEVER created (it is counted in `dropped_without_evidence`);
 *  - every edge carries a confidence, a temporal scope and the source subsystem it came from;
 *  - roles are never merged: a registry publisher, a registry maintainer, a release author and a git committer are different
 *    node kinds/ids even when the account name is the same string.
 */
export const GRAPH_NODE_KINDS = [
  'Repository',
  'Commit',
  'Release',
  'ReleaseAsset',
  'Package',
  'PackageVersion',
  'Publisher',
  'Maintainer',
  'Actor',
  'Dependency',
  'Attestation',
  'Signature',
  'ExternalDomain',
  'Capability',
  'Finding',
] as const;
export const GRAPH_EDGE_TYPES = [
  'DEPENDS_ON',
  'PUBLISHED_BY',
  'MAINTAINED_BY',
  'RELEASES',
  'HAS_ASSET',
  'BUILT_FROM',
  'ATTESTED_BY',
  'SIGNED_BY',
  'SOURCED_FROM',
  'RELEASED_BY',
  'CONNECTS_TO',
  'HAS_CAPABILITY',
  'INTRODUCED_CAPABILITY',
  'HAS_FINDING',
] as const;
export const TEMPORAL_SCOPES = [
  'revision',
  'current_state',
  'publish_history',
  'release_time',
] as const;
export const GRAPH_SOURCES = [
  'dependency_intel',
  'registry',
  'release',
  'governance',
  'code_analysis',
  'findings',
  'diff',
] as const;

export const GraphNodeSchema = z.object({
  id: z.string().max(240),
  kind: z.enum(GRAPH_NODE_KINDS),
  name: z.string().max(200),
  attrs: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
});
export const GraphEdgeSchema = z.object({
  from: z.string().max(240),
  to: z.string().max(240),
  type: z.enum(GRAPH_EDGE_TYPES),
  evidence_ids: z.array(z.string().max(160)).min(1).max(8),
  confidence: z.number().min(0).max(1),
  temporal_scope: z.enum(TEMPORAL_SCOPES),
  source: z.enum(GRAPH_SOURCES),
  at: z.string().nullable(),
});
export const TrustGraphSchema = z.object({
  version: z.literal('1'),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  truncated: z.boolean(),
  dropped_without_evidence: z.number().int().min(0),
  /** What the graph cannot represent yet (stated, not guessed). */
  not_represented: z.array(z.string().max(160)),
});
export type TrustGraph = z.infer<typeof TrustGraphSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GRAPH_LIMITS = { nodes: 3000, edges: 9000, dependencies: 200 } as const;

const clean = (s: string, n = 120): string =>
  [...s]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)
    .join('')
    .slice(0, n);

export function buildTrustGraph(report: Report, diff?: HistoricalDiff): TrustGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let truncated = false;
  let dropped = 0;
  const node = (
    id: string,
    kind: GraphNode['kind'],
    name: string,
    attrs: GraphNode['attrs'] = {},
  ): string => {
    if (!nodes.has(id)) {
      if (nodes.size >= GRAPH_LIMITS.nodes) {
        truncated = true;
        return id;
      }
      nodes.set(id, { id: clean(id, 240), kind, name: clean(name, 200), attrs });
    }
    return id;
  };
  const edge = (
    from: string,
    to: string,
    type: GraphEdge['type'],
    evidence: string[],
    confidence: number,
    scope: GraphEdge['temporal_scope'],
    source: GraphEdge['source'],
    at: string | null = null,
  ): void => {
    const ev = evidence
      .map((e) => clean(e, 160))
      .filter(Boolean)
      .slice(0, 8);
    if (ev.length === 0) {
      dropped++; // no evidence, no edge
      return;
    }
    if (!nodes.has(from) || !nodes.has(to)) return;
    if (edges.length >= GRAPH_LIMITS.edges) {
      truncated = true;
      return;
    }
    edges.push({
      from,
      to,
      type,
      evidence_ids: ev,
      confidence: Math.max(0, Math.min(1, confidence)),
      temporal_scope: scope,
      source,
      at,
    });
  };

  const repoName = `${report.subject.owner}/${report.subject.repo}`.toLowerCase();
  const repo = node(`repo:${repoName}`, 'Repository', repoName, {
    default_branch: report.subject.default_branch,
  });
  const head = report.subject.ref;
  const headId = head
    ? node(`commit:${head}`, 'Commit', head.slice(0, 12), { analyzed: true })
    : undefined;

  // ---- dependencies (direct, capped) ------------------------------------------------------------------------------
  for (const d of report.dependency_intel.dependencies
    .filter((x) => x.direct)
    .slice(0, GRAPH_LIMITS.dependencies)) {
    const id = node(`dep:${d.package.ecosystem}:${d.package.name}`, 'Dependency', d.package.name, {
      ecosystem: d.package.ecosystem,
      version: d.resolved?.version ?? null,
      resolution: d.resolution,
    });
    edge(repo, id, 'DEPENDS_ON', [d.id], d.confidence, 'revision', 'dependency_intel');
  }

  // ---- releases, assets, signatures, attestations -----------------------------------------------------------------
  for (const r of report.release_intel.releases) {
    const rid = node(`release:${r.tag}`, 'Release', r.tag, {
      prerelease: r.prerelease,
      correspondence: r.correspondence,
    });
    const tagEv = `release:${clean(r.tag, 60)}`;
    edge(repo, rid, 'RELEASES', [tagEv], 0.9, 'release_time', 'release', r.published_at);
    if (r.tag_commit) {
      const c = node(`commit:${r.tag_commit}`, 'Commit', r.tag_commit.slice(0, 12), {});
      edge(
        rid,
        c,
        'BUILT_FROM',
        [tagEv],
        r.correspondence === 'verified_source_binding' ? 0.95 : 0.7,
        'release_time',
        'release',
        r.published_at,
      );
      void c;
    }
    if (r.published_by) {
      const a = node(`actor:release_author:${r.published_by}`, 'Actor', r.published_by, {
        role: 'release_author',
      });
      edge(rid, a, 'RELEASED_BY', [tagEv], 0.9, 'release_time', 'release', r.published_at);
    }
    for (const a of r.assets.slice(0, 40)) {
      const aid = node(`asset:${r.tag}/${a.name}`, 'ReleaseAsset', a.name, {
        kind: a.kind,
        digest: a.digest ? `${a.digest.algorithm}:${a.digest.value.slice(0, 16)}` : null,
      });
      edge(rid, aid, 'HAS_ASSET', [tagEv], 0.9, 'release_time', 'release', r.published_at);
    }
    r.signatures.forEach((s, i) => {
      const sid = node(`sig:${r.tag}/${i}`, 'Signature', `${s.kind} ${s.state}`, {
        state: s.state,
        trust_root: s.trust_root,
        verified_by: s.verified_by,
        local_state: s.local_state,
      });
      edge(
        rid,
        sid,
        'SIGNED_BY',
        [tagEv],
        s.state === 'verified' ? 0.8 : 0.4,
        'release_time',
        'release',
        r.published_at,
      );
    });
    r.provenance.forEach((p, i) => {
      const pid = node(`attestation:${r.tag}/${i}`, 'Attestation', p.predicate_type, {
        verification: p.verification,
        trust_root: p.verification_detail?.trust_root ?? 'none',
        builder: p.builder_id,
        signer_repository: p.verification_detail?.identity?.source_repository ?? null,
      });
      edge(
        rid,
        pid,
        'ATTESTED_BY',
        [tagEv],
        p.verification === 'verified' ? 0.95 : 0.4,
        'release_time',
        'release',
        r.published_at,
      );
      if (p.source_revision) {
        const c = node(`commit:${p.source_revision}`, 'Commit', p.source_revision.slice(0, 12), {});
        edge(
          pid,
          c,
          'BUILT_FROM',
          [tagEv],
          p.verification === 'verified' ? 0.95 : 0.3,
          'release_time',
          'release',
          r.published_at,
        );
      }
    });
  }

  // ---- registry packages, publishers, maintainers -----------------------------------------------------------------
  for (const p of report.registry_intel.packages) {
    const key = `${p.registry}:${p.name}`;
    const pkg = node(`package:${key}`, 'Package', p.name, {
      registry: p.registry,
      status: p.status,
      latest: p.latest_version,
    });
    const pev = `registry:${p.registry}:${clean(p.name, 80)}`;
    if (p.status !== 'ok' && p.status !== 'partial') continue;
    edge(
      pkg,
      repo,
      'SOURCED_FROM',
      [pev],
      p.repository.match === 'confirmed' ? 0.9 : p.repository.match === 'likely' ? 0.5 : 0.2,
      'current_state',
      'registry',
      p.observed_at,
    );
    const sigs = report.registry_intel.signals
      .filter((s) => s.package === p.name && s.registry === p.registry)
      .map((s) => s.id);
    const newest = p.versions[0];
    if (newest?.publisher) {
      const v = node(`version:${key}@${newest.version}`, 'PackageVersion', newest.version, {
        has_provenance: newest.has_provenance,
      });
      edge(pkg, v, 'RELEASES', [pev], 0.9, 'publish_history', 'registry', newest.published_at);
      const pub = node(
        `publisher:${p.registry}:${newest.publisher.name}`,
        'Publisher',
        newest.publisher.name,
        { suspicious: newest.publisher.suspicious },
      );
      edge(
        v,
        pub,
        'PUBLISHED_BY',
        [pev, ...sigs.slice(0, 2)],
        0.9,
        'publish_history',
        'registry',
        newest.published_at,
      );
    }
    for (const m of p.maintainers.names.slice(0, 10)) {
      const mid = node(`maintainer:${p.registry}:${m.name}`, 'Maintainer', m.name, {
        suspicious: m.suspicious,
        scope: 'current_state',
      });
      edge(pkg, mid, 'MAINTAINED_BY', [pev], 0.8, 'current_state', 'registry', p.observed_at);
    }
  }

  // ---- capabilities and findings ----------------------------------------------------------------------------------
  for (const c of report.code_analysis.capabilities.summary.filter(
    (x) => x.observed && x.mode !== 'POSSIBLE',
  )) {
    const cap = node(`capability:${c.capability}`, 'Capability', c.capability, { risk: c.risk });
    const ev = report.code_analysis.capabilities.detections
      .filter((d) => d.capability === c.capability)
      .map((d) => d.id)
      .slice(0, 3);
    edge(repo, cap, 'HAS_CAPABILITY', ev, c.confidence, 'revision', 'code_analysis');
  }
  for (const f of report.findings.slice(0, 200)) {
    const fid = node(`finding:${f.id}`, 'Finding', f.title, {
      severity: f.severity,
      category: f.category,
    });
    edge(
      repo,
      fid,
      'HAS_FINDING',
      f.evidence_ids.length > 0 ? f.evidence_ids : [f.id],
      f.confidence,
      'revision',
      'findings',
    );
  }

  // ---- what a revision diff adds ----------------------------------------------------------------------------------
  if (diff && headId) {
    for (const c of diff.capabilities.filter(
      (x) => x.change === 'new' && x.certainty === 'observed',
    )) {
      const cap = node(`capability:${c.capability}`, 'Capability', c.capability, {
        risk: c.after?.risk ?? 'none',
      });
      edge(
        headId,
        cap,
        'INTRODUCED_CAPABILITY',
        [`diff:capability:${c.capability}`],
        0.7,
        'revision',
        'diff',
        diff.to.generated_at,
      );
    }
  }

  return {
    version: '1',
    nodes: [...nodes.values()],
    edges,
    truncated,
    dropped_without_evidence: dropped,
    not_represented: [
      'ExternalDomain nodes and CONNECTS_TO edges: domains are not extracted yet',
      'PUBLISHED_BY for packages that are dependencies of this repository: registry lookups cover only the packages this repository publishes',
      'package ownership transfers: registries expose the current owner set only',
    ],
  };
}

/** Structural validation used by tests and by consumers of a serialized graph: no dangling edges, no evidence-free edges. */
export function validateGraph(g: TrustGraph): string[] {
  const problems: string[] = [];
  const ids = new Set(g.nodes.map((n) => n.id));
  if (ids.size !== g.nodes.length) problems.push('duplicate node ids');
  g.edges.forEach((e, i) => {
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`edge ${i} has a dangling endpoint`);
    if (e.evidence_ids.length === 0) problems.push(`edge ${i} has no evidence`);
  });
  return problems;
}

export function summarizeGraph(g: TrustGraph): string {
  const count = (xs: string[]): string =>
    Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {}))
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
  return `nodes: ${g.nodes.length} (${count(g.nodes.map((n) => n.kind))})\nedges: ${g.edges.length} (${count(g.edges.map((e) => e.type))})\nscopes: ${count(g.edges.map((e) => e.temporal_scope))}\n${g.dropped_without_evidence > 0 ? `${g.dropped_without_evidence} edge(s) dropped for lack of evidence\n` : ''}${g.truncated ? '(truncated by graph limits)\n' : ''}`;
}
