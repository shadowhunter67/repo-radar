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
  'TrustRoot',
  'Registry',
  'Capability',
  'Finding',
  'DependencyArtifact',
  'PackageNameSignal',
  'BuildSource',
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
  'VERIFIED_BY',
  'USES_TRUST_ROOT',
  'PUBLISHED_IN',
  'CORRESPONDS_TO',
  'HAS_CAPABILITY',
  'INTRODUCED_CAPABILITY',
  'HAS_FINDING',
  'HAS_ARTIFACT',
  'FETCHES_FROM',
  'SIMILAR_TO_PACKAGE',
  'DECLARED_BY',
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
  'dependency_registry',
  'release',
  'trust',
  'domains',
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
  /** When the relation first held / stopped holding, when a source states it. Never invented: absent when unknown. */
  introduced_at: z.string().nullable().optional(),
  removed_at: z.string().nullable().optional(),
});
export const TrustGraphSchema = z.object({
  version: z.literal('1'),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  truncated: z.boolean(),
  dropped_without_evidence: z.number().int().min(0),
  limits: z.object({
    nodes_emitted: z.number().int().min(0),
    nodes_skipped: z.number().int().min(0),
    edges_emitted: z.number().int().min(0),
    edges_skipped: z.number().int().min(0),
    stopped_by: z.enum(['complete', 'node_budget', 'edge_budget']),
  }),
  /** What the graph cannot represent yet (stated, not guessed). */
  not_represented: z.array(z.string().max(160)),
});
export type TrustGraph = z.infer<typeof TrustGraphSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GRAPH_LIMITS = {
  nodes: 3000,
  edges: 9000,
  dependencies: 200,
  /** Dependency registry packages that get nodes, and how many of their newest versions are linked to publishers. */
  dependencyPackages: 100,
  versionsPerDependency: 3,
  maintainersPerPackage: 5,
  domains: 300,
} as const;

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
  let nodesSkipped = 0;
  let edgesSkipped = 0;
  let stoppedBy: 'complete' | 'node_budget' | 'edge_budget' = 'complete';
  const node = (
    id: string,
    kind: GraphNode['kind'],
    name: string,
    attrs: GraphNode['attrs'] = {},
  ): string => {
    if (!nodes.has(id)) {
      if (nodes.size >= GRAPH_LIMITS.nodes) {
        truncated = true;
        nodesSkipped++;
        stoppedBy = 'node_budget';
        return id;
      }
      nodes.set(id, { id: clean(id, 240), kind, name: clean(name, 200), attrs });
    }
    return id;
  };
  const trustRootNode = (root: string): string =>
    node(`trustroot:${root}`, 'TrustRoot', root, {
      origin: /^project_pinned/.test(root)
        ? 'project_pinned'
        : /^user_supplied/.test(root)
          ? 'user_supplied'
          : 'public_infrastructure',
    });
  const edge = (
    from: string,
    to: string,
    type: GraphEdge['type'],
    evidence: string[],
    confidence: number,
    scope: GraphEdge['temporal_scope'],
    source: GraphEdge['source'],
    at: string | null = null,
    when: { introduced_at?: string | null; removed_at?: string | null } = {},
  ): void => {
    const ev = evidence
      .map((e) => clean(e, 160))
      .filter(Boolean)
      .slice(0, 8);
    if (ev.length === 0) {
      dropped++; // no evidence, no edge
      return;
    }
    if (!nodes.has(from) || !nodes.has(to)) {
      edgesSkipped++;
      return;
    }
    if (edges.length >= GRAPH_LIMITS.edges) {
      truncated = true;
      edgesSkipped++;
      stoppedBy = 'edge_budget';
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
      ...(when.introduced_at !== undefined ? { introduced_at: when.introduced_at } : {}),
      ...(when.removed_at !== undefined ? { removed_at: when.removed_at } : {}),
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
        engine: s.local_detail?.engine ?? 'none',
        basis: s.basis ?? null,
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
      // the trust root a check relied on, preferring repo-radar's own check over GitHub's assertion
      const local = s.local_detail;
      const root = local && local.trust_root !== 'none' ? local.trust_root : s.trust_root;
      if (root !== 'none') {
        const tr = trustRootNode(root);
        const ok =
          local && local.trust_root !== 'none'
            ? local.state === 'verified'
            : s.state === 'verified';
        edge(
          sid,
          tr,
          ok ? 'VERIFIED_BY' : 'USES_TRUST_ROOT',
          [tagEv],
          ok ? 0.9 : 0.5,
          'release_time',
          'trust',
          r.published_at,
        );
      }
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
      const attRoot = p.verification_detail?.trust_root;
      if (attRoot && attRoot !== 'none') {
        edge(
          pid,
          trustRootNode(attRoot),
          p.verification === 'verified' ? 'VERIFIED_BY' : 'USES_TRUST_ROOT',
          [tagEv],
          p.verification === 'verified' ? 0.95 : 0.5,
          'release_time',
          'trust',
          r.published_at,
        );
      }
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

  // ---- dependency registry packages: who publishes what this repository relies on ----------------------------------------
  const ECO: Record<string, string> = { npm: 'npm', pypi: 'PyPI', 'crates.io': 'crates.io' };
  const depReg = report.dependency_registry_intel;
  for (const p of depReg.packages.slice(0, GRAPH_LIMITS.dependencyPackages)) {
    if (p.status !== 'ok' && p.status !== 'partial') continue;
    const key = `${p.registry}:${p.name}`;
    const pev = `depregistry:${p.registry}:${clean(p.name, 80)}`;
    const pkg = node(`package:${key}`, 'Package', p.name, {
      registry: p.registry,
      status: p.status,
      latest: p.latest_version,
      dependency: true,
      repository_match: p.repository.match,
    });
    const reg = node(`registry:${p.registry}`, 'Registry', p.registry);
    edge(
      pkg,
      reg,
      'PUBLISHED_IN',
      [pev],
      0.9,
      'current_state',
      'dependency_registry',
      p.observed_at,
    );
    const depId = node(`dep:${ECO[p.registry]}:${p.name}`, 'Dependency', p.name, {
      ecosystem: ECO[p.registry] ?? p.registry,
      version: p.resolved_versions[0] ?? null,
      resolution: p.resolved_versions.length > 0 ? 'resolved' : 'unresolved',
    });
    edge(
      depId,
      pkg,
      'CORRESPONDS_TO',
      [pev, ...p.dependency_ids.slice(0, 2)],
      p.resolved_versions.length > 0 ? 0.9 : 0.6,
      'revision',
      'dependency_registry',
    );
    if (p.repository.normalized) {
      const src = node(`repo:${p.repository.normalized}`, 'Repository', p.repository.normalized, {
        analyzed: false,
      });
      edge(
        pkg,
        src,
        'SOURCED_FROM',
        [pev],
        p.repository.match === 'confirmed' ? 0.8 : p.repository.match === 'likely' ? 0.5 : 0.2,
        'current_state',
        'dependency_registry',
        p.observed_at,
      );
    }
    for (const v of p.versions.slice(0, GRAPH_LIMITS.versionsPerDependency)) {
      const attestationState = p.attestation_states[v.version] ?? 'unknown';
      const vid = node(`version:${key}@${v.version}`, 'PackageVersion', v.version, {
        has_provenance: v.has_provenance,
        provenance_verified:
          attestationState === 'provenance_verified' ||
          attestationState === 'source_binding_verified',
        attestation_state: attestationState,
        dependency: true,
      });
      edge(
        pkg,
        vid,
        'RELEASES',
        [pev],
        0.9,
        'publish_history',
        'dependency_registry',
        v.published_at,
      );
      if (v.publisher) {
        const pub = node(
          `publisher:${p.registry}:${v.publisher.name}`,
          'Publisher',
          v.publisher.name,
          {
            suspicious: v.publisher.suspicious,
          },
        );
        const evIds = depReg.events
          .filter(
            (e) => e.package === p.name && e.registry === p.registry && e.version === v.version,
          )
          .map((e) => e.id);
        edge(
          vid,
          pub,
          'PUBLISHED_BY',
          [pev, ...evIds.slice(0, 3)],
          0.9,
          'publish_history',
          'dependency_registry',
          v.published_at,
        );
      }
      if (
        attestationState === 'provenance_verified' ||
        attestationState === 'source_binding_verified'
      ) {
        const root = trustRootNode('sigstore_public_good');
        edge(
          vid,
          root,
          'VERIFIED_BY',
          [`depregistry:${p.registry}:${p.name}`],
          0.9,
          'publish_history',
          'dependency_registry',
          v.published_at,
        );
      }
    }
    for (const m of p.maintainers.names.slice(0, GRAPH_LIMITS.maintainersPerPackage)) {
      const mid = node(`maintainer:${p.registry}:${m.name}`, 'Maintainer', m.name, {
        suspicious: m.suspicious,
        scope: 'current_state',
      });
      edge(
        pkg,
        mid,
        'MAINTAINED_BY',
        [pev],
        0.8,
        'current_state',
        'dependency_registry',
        p.observed_at,
      );
    }
  }

  // ---- dependency artifacts, package-name signals and build sources ----------------------------------------------
  for (const a of report.dependency_artifacts.artifacts) {
    const aid = node(
      `artifact:${a.registry}:${a.package}@${a.version}`,
      'DependencyArtifact',
      `${a.package}@${a.version}`,
      {
        registry: a.registry,
        state: a.state,
        url: a.url,
      },
    );
    const vid = node(
      `version:${a.registry}:${a.package}@${a.version}`,
      'PackageVersion',
      a.version,
      { dependency: true },
    );
    edge(
      vid,
      aid,
      'HAS_ARTIFACT',
      a.evidence,
      a.state === 'verified' ? 0.95 : 0.5,
      'current_state',
      'dependency_registry',
    );
    for (const domain of a.domains.slice(0, 20)) {
      const did = node(`domain:${domain}`, 'ExternalDomain', domain, {
        category: 'dependency_artifact',
        strongest_context: 'dependency_install',
        ambiguity: 'none',
        display: null,
      });
      edge(aid, did, 'FETCHES_FROM', a.evidence, 0.5, 'current_state', 'domains');
    }
  }
  for (const s of report.name_intelligence.signals.filter((x) => !x.suppressed).slice(0, 200)) {
    const sid = node(
      `name-signal:${s.ecosystem}:${s.target}:${s.candidate}`,
      'PackageNameSignal',
      `${s.target} ~ ${s.candidate}`,
      { ecosystem: s.ecosystem, signals: s.signals.join(',') },
    );
    const target = node(`package:${s.ecosystem}:${s.target}`, 'Package', s.target, {
      registry: s.ecosystem,
    });
    const candidate = node(`package:${s.ecosystem}:${s.candidate}`, 'Package', s.candidate, {
      registry: s.ecosystem,
    });
    edge(
      target,
      sid,
      'SIMILAR_TO_PACKAGE',
      s.evidence,
      0.6,
      'current_state',
      'dependency_registry',
    );
    edge(
      sid,
      candidate,
      'SIMILAR_TO_PACKAGE',
      s.evidence,
      0.6,
      'current_state',
      'dependency_registry',
    );
  }
  for (const f of report.build_sources.files) {
    const bid = node(`build:${f.path}`, 'BuildSource', f.path, {
      system: f.system,
      dynamic: f.unparsed_dynamic > 0,
    });
    for (const d of f.dependencies.filter((x) => x.source).slice(0, 100)) {
      const domain = (() => {
        try {
          return new URL(d.source as string).hostname;
        } catch {
          return null;
        }
      })();
      if (!domain) continue;
      const did = node(`domain:${domain}`, 'ExternalDomain', domain, {
        category: 'build',
        strongest_context: 'build',
        ambiguity: 'none',
        display: null,
      });
      edge(
        bid,
        did,
        'FETCHES_FROM',
        [`build:${f.path}`],
        d.pinned ? 0.8 : 0.5,
        'current_state',
        'domains',
      );
    }
  }

  // ---- external domains: the hosts the repository's files refer to ---------------------------------------------------------
  // CONNECTS_TO means "a file of this repository refers to this host in this context", never that a connection was observed.
  const headDate = (() => {
    const ev = report.evidence.find((e) => e.id === 'github.commits.head_date');
    return typeof ev?.value === 'string' ? ev.value : null;
  })();
  for (const d of report.external_domains.domains.slice(0, GRAPH_LIMITS.domains)) {
    const did = node(`domain:${d.hostname}`, 'ExternalDomain', d.hostname, {
      category: d.category,
      strongest_context: d.strongest_context,
      ambiguity: d.ambiguity,
      display: d.display === d.hostname ? null : d.display,
    });
    const first = d.observations[0];
    edge(
      repo,
      did,
      'CONNECTS_TO',
      [
        `domain:${clean(d.hostname, 100)}`,
        ...(first ? [`${clean(first.file, 120)}:${first.line}`] : []),
      ],
      d.confidence,
      'revision',
      'domains',
    );
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
  if (diff) {
    for (const d of diff.domains.filter(
      (x) => x.certainty === 'observed' && (x.kind === 'introduced' || x.kind === 'removed'),
    )) {
      const did = node(`domain:${d.hostname}`, 'ExternalDomain', d.hostname, {
        category: d.category,
        strongest_context: (d.after ?? d.before)?.strongest_context ?? 'unknown',
        ambiguity: 'none',
        display: null,
      });
      // The time of the change is the later revision's head commit date; the analysis time is never used as a commit time.
      const when = headDate;
      edge(
        repo,
        did,
        'CONNECTS_TO',
        [`diff:domain:${clean(d.hostname, 100)}`],
        d.confidence,
        'revision',
        'diff',
        null,
        d.kind === 'introduced' ? { introduced_at: when } : { removed_at: when },
      );
    }
  }
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
    limits: {
      nodes_emitted: nodes.size,
      nodes_skipped: nodesSkipped,
      edges_emitted: edges.length,
      edges_skipped: edgesSkipped,
      stopped_by: stoppedBy,
    },
    not_represented: [
      'dependencies beyond the registry lookup budget, and PyPI publishers (the API does not expose them)',
      'registry provenance of dependency versions is reported, not verified: PackageVersion nodes carry provenance_verified=false',
      'package ownership transfers: registries expose the current owner set only',
      'domains of dependencies: dependency tarballs are never fetched',
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
