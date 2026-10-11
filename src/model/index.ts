import { z } from 'zod';
import type { Report } from '../report/schema.js';

/**
 * Unified repository model: one set of entities and relationships that every analysis subsystem (dependencies, execution
 * graph, capabilities, findings, ...) can be projected onto. It is a VIEW derived from a report, built with plain
 * TypeScript structures (no graph database): it exists so new questions ("which package is installed by which
 * script?") do not need yet another bespoke structure, and so future inputs (releases, binaries, provenance, maintainers)
 * have a place to attach.
 *
 * Release/binary and governance entities are part of the vocabulary already (Release, Artifact, Maintainer); the current
 * analysis fills only what it can observe (see docs/architecture.md, "Future inputs").
 */
export const ENTITY_KINDS = [
  'Repository',
  'Project',
  'Package',
  'Manifest',
  'Lockfile',
  'File',
  'Script',
  'ExecutionNode',
  'Entrypoint',
  'Capability',
  'Sbom',
  'Release',
  'Artifact',
  'Maintainer',
  'ExternalService',
  'Finding',
  'Evidence',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const RELATION_TYPES = [
  'DEPENDS_ON',
  'DECLARES',
  'RESOLVES_TO',
  'EXECUTES',
  'CALLS',
  'DOWNLOADS',
  'READS',
  'WRITES',
  'CONNECTS_TO',
  'BUILDS',
  'PUBLISHES',
  'INSTALLS',
  'STARTS',
  'GENERATES',
  'PERSISTS_AS',
  'DESCRIBES',
  'DERIVED_FROM',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

const Attr = z.union([z.string(), z.number(), z.boolean()]);
export const EntitySchema = z.object({
  id: z.string(),
  kind: z.enum(ENTITY_KINDS),
  name: z.string(),
  attrs: z.record(z.string(), Attr),
});
export const RelationshipSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(RELATION_TYPES),
  confidence: z.number().min(0).max(1).optional(),
  attrs: z.record(z.string(), Attr).optional(),
});
export const RepositoryModelSchema = z.object({
  version: z.literal('0.1'),
  entities: z.array(EntitySchema),
  relationships: z.array(RelationshipSchema),
  truncated: z.boolean(),
});
export type Entity = z.infer<typeof EntitySchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type RepositoryModel = z.infer<typeof RepositoryModelSchema>;

export const MODEL_LIMITS = { entities: 5000, relationships: 15_000 } as const;

const CAPABILITY_RELATION: Record<string, RelationType> = {
  PROCESS_EXEC: 'CALLS',
  NETWORK_CLIENT: 'CONNECTS_TO',
  NETWORK_SERVER: 'CONNECTS_TO',
  REMOTE_DOWNLOAD: 'DOWNLOADS',
  FILESYSTEM_WRITE: 'WRITES',
  FILESYSTEM_DELETE: 'WRITES',
  ENVIRONMENT_READ: 'READS',
  CREDENTIAL_ACCESS: 'READS',
  PERSISTENCE: 'PERSISTS_AS',
  BACKGROUND_PROCESS: 'STARTS',
};
const EDGE_RELATION: Record<string, RelationType> = {
  RUNS: 'EXECUTES',
  EXECUTES: 'EXECUTES',
  REFERENCES: 'CALLS',
  DOWNLOADS: 'DOWNLOADS',
  SELECTS_BACKEND: 'BUILDS',
  CONFIGURES: 'BUILDS',
  BUILDS: 'BUILDS',
  DEFINES: 'INSTALLS',
};

export function buildRepositoryModel(report: Report): RepositoryModel {
  const entities = new Map<string, Entity>();
  const rels: Relationship[] = [];
  let truncated = false;
  const ent = (id: string, kind: EntityKind, name: string, attrs: Entity['attrs'] = {}): string => {
    if (!entities.has(id)) {
      if (entities.size >= MODEL_LIMITS.entities) {
        truncated = true;
        return id;
      }
      entities.set(id, { id, kind, name: name.slice(0, 200), attrs });
    }
    return id;
  };
  const rel = (
    from: string,
    to: string,
    type: RelationType,
    confidence?: number,
    attrs?: Entity['attrs'],
  ): void => {
    if (rels.length >= MODEL_LIMITS.relationships) {
      truncated = true;
      return;
    }
    if (!entities.has(from) || !entities.has(to)) return;
    rels.push({
      from,
      to,
      type,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(attrs ? { attrs } : {}),
    });
  };

  const repoId = ent(
    `repo:${report.subject.owner}/${report.subject.repo}`,
    'Repository',
    `${report.subject.owner}/${report.subject.repo}`,
    { commit: report.subject.ref ?? 'unpinned', analyzed_at: report.generated_at },
  );

  // Dependencies: manifests, lockfiles and packages.
  const di = report.dependency_intel;
  for (const d of di.dependencies) {
    const pkgId = ent(
      `pkg:${d.package.ecosystem}:${d.package.name}@${d.resolved?.version ?? '?'}`,
      'Package',
      d.package.name,
      {
        ecosystem: d.package.ecosystem,
        ...(d.resolved ? { version: d.resolved.version, version_source: d.resolved.source } : {}),
        ...(d.package.purl ? { purl: d.package.purl } : {}),
      },
    );
    if (d.manifest_path) {
      const mId = ent(`file:${d.manifest_path}`, 'Manifest', d.manifest_path);
      rel(repoId, mId, 'DECLARES');
      rel(mId, pkgId, 'DEPENDS_ON', d.confidence, {
        relationship: d.relationship,
        requested: d.requested?.spec ?? '',
        context: d.context,
      });
    }
    if (d.lockfile_path) {
      const lId = ent(`file:${d.lockfile_path}`, 'Lockfile', d.lockfile_path);
      rel(repoId, lId, 'DECLARES');
      rel(lId, pkgId, 'RESOLVES_TO', d.resolved?.confidence);
    }
  }
  for (const s of di.sboms) {
    const sId = ent(`file:${s.path}`, 'Sbom', s.path, {
      format: s.format,
      status: s.status,
      components: s.component_count,
    });
    rel(repoId, sId, 'DECLARES');
    for (const c of s.components.slice(0, 100))
      if (c.package) {
        const target = [...entities.values()].find(
          (e) =>
            e.kind === 'Package' &&
            e.name === c.package?.name &&
            e.attrs['ecosystem'] === c.package.ecosystem,
        );
        if (target) rel(sId, target.id, 'DESCRIBES');
      }
  }
  if (di.vulnerability_lookup.performed) {
    const osv = ent('svc:osv', 'ExternalService', 'OSV', { role: 'advisory database' });
    for (const a of di.advisories.slice(0, 200)) {
      const target = [...entities.values()].find(
        (e) => e.kind === 'Package' && e.name === a.package && e.attrs['version'] === a.version,
      );
      const fId = ent(`adv:${a.source}:${a.id}`, 'Finding', a.id, { source: a.source });
      if (target) rel(fId, target.id, 'DERIVED_FROM');
      rel(fId, osv, 'CONNECTS_TO');
    }
  }
  if (di.deps_dev.state !== 'disabled' && di.deps_dev.requests > 0)
    ent('svc:deps.dev', 'ExternalService', 'deps.dev', { role: 'package metadata' });

  // Execution: projects, hooks, graph, entry points.
  const ex = report.code_analysis.execution;
  const nodeId = (n: string): string => `exec:${n}`;
  for (const n of ex.graph.nodes) {
    ent(nodeId(n.id), 'ExecutionNode', n.label, { kind: n.kind, analyzed: n.analyzed });
    if (n.file) {
      const f = ent(`file:${n.file}`, 'File', n.file);
      rel(nodeId(n.id), f, 'DERIVED_FROM');
    }
  }
  for (const e of ex.graph.edges)
    rel(nodeId(e.from), nodeId(e.to), EDGE_RELATION[e.relation] ?? 'CALLS', e.confidence, {
      ...(e.stage ? { stage: e.stage } : {}),
      ...(e.trigger_kind ? { trigger: e.trigger_kind } : {}),
    });
  for (const p of ex.projects) {
    const pId = ent(`proj:${p.id}`, 'Project', `${p.ecosystem}:${p.dir}`, {
      build_system: p.build_system ?? '',
      repository_code_runs: p.repository_code_runs,
      kind: p.kind,
    });
    rel(repoId, pId, 'DECLARES');
    for (const h of ex.hooks.filter((x) => p.hook_ids.includes(x.id))) {
      const sId = ent(`hook:${h.id}`, 'Script', `${h.ecosystem}:${h.name}`, {
        stage: h.stage ?? '',
        trigger: h.trigger_kind ?? '',
        risk: h.risk,
        runs_for_dependents: h.runs_for_dependents,
      });
      rel(pId, sId, 'BUILDS', h.confidence);
      for (const nid of h.node_ids) rel(sId, nodeId(nid), 'EXECUTES');
    }
  }
  for (const h of ex.hooks) {
    const sId = ent(`hook:${h.id}`, 'Script', `${h.ecosystem}:${h.name}`, {
      stage: h.stage ?? '',
      trigger: h.trigger_kind ?? '',
      risk: h.risk,
      runs_for_dependents: h.runs_for_dependents,
    });
    rel(repoId, sId, h.runs_for_dependents ? 'INSTALLS' : 'BUILDS', h.confidence);
  }
  for (const e of ex.entrypoints) {
    const eId = ent(`ep:${e.id}`, 'Entrypoint', `${e.ecosystem}:${e.name}`, {
      target: e.target,
      trigger: e.trigger_kind,
      automatic: false,
    });
    rel(repoId, eId, 'INSTALLS');
    if (e.file) rel(eId, ent(`file:${e.file}`, 'File', e.file), 'EXECUTES');
  }

  // Capabilities observed in files.
  for (const d of report.code_analysis.capabilities.detections.slice(0, 400)) {
    const cId = ent(`cap:${d.capability}`, 'Capability', d.capability);
    const fId = ent(`file:${d.file}`, 'File', d.file);
    rel(fId, cId, CAPABILITY_RELATION[d.capability] ?? 'CALLS', d.confidence, {
      mode: d.mode,
      contexts: d.contexts.join(','),
    });
  }

  // Findings and their evidence.
  for (const f of report.findings.slice(0, 300)) {
    const fId = ent(`finding:${f.id}`, 'Finding', f.title, {
      severity: f.severity,
      category: f.category,
    });
    for (const ev of f.evidence_ids.slice(0, 10))
      rel(fId, ent(`ev:${ev}`, 'Evidence', ev), 'DERIVED_FROM', f.confidence);
  }

  // Future inputs that already have a home: releases/artifacts (presence only), maintainers (counts only).
  const evv = (id: string): unknown => report.evidence.find((e) => e.id === id)?.value;
  if (evv('github.releases.has_any') === true) {
    const rId = ent('release:latest', 'Release', 'latest release', {
      age_days: Number(evv('github.releases.latest_age_days') ?? -1),
    });
    rel(repoId, rId, 'PUBLISHES');
    for (const [id, label] of [
      ['github.releases.signed_assets', 'signed assets'],
      ['github.releases.provenance_assets', 'provenance assets'],
      ['github.releases.sbom_assets', 'SBOM assets'],
    ] as const)
      if (evv(id) === true) rel(rId, ent(`artifact:${label}`, 'Artifact', label), 'PUBLISHES');
  }
  if (evv('github.contributors.count') !== undefined)
    rel(
      repoId,
      ent('maintainers', 'Maintainer', 'contributors', {
        count: Number(evv('github.contributors.count')),
        bus_factor: Number(evv('github.contributors.bus_factor') ?? -1),
      }),
      'DECLARES',
    );

  return { version: '0.1', entities: [...entities.values()], relationships: rels, truncated };
}

export function summarizeModel(m: RepositoryModel): string {
  const count = (xs: string[]): string =>
    Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {}))
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
  return `entities: ${m.entities.length} (${count(m.entities.map((e) => e.kind))})\nrelationships: ${m.relationships.length} (${count(m.relationships.map((r) => r.type))})${m.truncated ? '\n(truncated by model limits)' : ''}\n`;
}
