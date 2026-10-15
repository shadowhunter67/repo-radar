import type { GraphEdge, GraphNode, TrustGraph } from './trust.js';

/**
 * Deterministic in-memory queries over a Trust Graph projection. No graph database, no inference: each helper follows a
 * fixed path of edges and returns plain, sorted rows, so the same graph always gives the same answer.
 *
 * Every row says which edges it came from (`evidence`), because an answer without its evidence would be a claim.
 */
export class GraphIndex {
  readonly nodes = new Map<string, GraphNode>();
  private readonly out = new Map<string, GraphEdge[]>();
  private readonly into = new Map<string, GraphEdge[]>();

  constructor(readonly graph: TrustGraph) {
    for (const n of graph.nodes) this.nodes.set(n.id, n);
    for (const e of graph.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.into.get(e.to) ?? this.into.set(e.to, []).get(e.to)!).push(e);
    }
  }
  outgoing(id: string, type?: GraphEdge['type']): GraphEdge[] {
    return (this.out.get(id) ?? []).filter((e) => !type || e.type === type);
  }
  incoming(id: string, type?: GraphEdge['type']): GraphEdge[] {
    return (this.into.get(id) ?? []).filter((e) => !type || e.type === type);
  }
  ofKind(kind: GraphNode['kind']): GraphNode[] {
    return this.graph.nodes.filter((n) => n.kind === kind);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface PublishedRow {
  dependency: string;
  ecosystem: string;
  package_id: string;
  versions: { version: string; at: string | null }[];
  evidence: string[];
}

/** Dependencies with at least one sampled version published by the named account (case-insensitive). */
export function dependenciesPublishedBy(
  idx: GraphIndex,
  publisher: string,
  registry?: string,
): PublishedRow[] {
  const want = publisher.toLowerCase();
  const rows = new Map<string, PublishedRow>();
  for (const pub of idx.ofKind('Publisher')) {
    if (pub.name.toLowerCase() !== want) continue;
    if (registry && !pub.id.startsWith(`publisher:${registry}:`)) continue;
    for (const pe of idx.incoming(pub.id, 'PUBLISHED_BY')) {
      const ver = idx.nodes.get(pe.from);
      if (ver?.kind !== 'PackageVersion' || ver.attrs['dependency'] !== true) continue;
      for (const re of idx.incoming(ver.id, 'RELEASES')) {
        const pkg = idx.nodes.get(re.from);
        if (pkg?.kind !== 'Package') continue;
        for (const ce of idx.incoming(pkg.id, 'CORRESPONDS_TO')) {
          const dep = idx.nodes.get(ce.from);
          if (dep?.kind !== 'Dependency') continue;
          const row = rows.get(dep.id) ?? {
            dependency: dep.name,
            ecosystem: String(dep.attrs['ecosystem'] ?? ''),
            package_id: pkg.id,
            versions: [],
            evidence: [],
          };
          row.versions.push({ version: ver.name, at: pe.at });
          row.evidence.push(...pe.evidence_ids.slice(0, 2));
          rows.set(dep.id, row);
        }
      }
    }
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      versions: r.versions.sort((a, b) => cmp(a.version, b.version)),
      evidence: [...new Set(r.evidence)].sort().slice(0, 6),
    }))
    .sort((a, b) => cmp(a.dependency, b.dependency));
}

export interface BoundAssetRow {
  release: string;
  asset: string;
  /** `tag`: the release tag points at the commit. `attestation`: an attestation names the commit as its source. */
  via: 'tag' | 'attestation';
  verified: boolean;
  evidence: string[];
}

/** Release assets tied to a commit (full sha or an unambiguous prefix of at least 7 characters). */
export function assetsBoundToCommit(idx: GraphIndex, commit: string): BoundAssetRow[] {
  const want = commit.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(want)) return [];
  const rows = new Map<string, BoundAssetRow>();
  for (const c of idx.ofKind('Commit')) {
    if (!c.id.slice('commit:'.length).startsWith(want)) continue;
    for (const be of idx.incoming(c.id, 'BUILT_FROM')) {
      const src = idx.nodes.get(be.from);
      const releases =
        src?.kind === 'Release'
          ? [{ rel: src, via: 'tag' as const, verified: false }]
          : src?.kind === 'Attestation'
            ? idx
                .incoming(src.id, 'ATTESTED_BY')
                .flatMap((ae) => {
                  const r = idx.nodes.get(ae.from);
                  return r?.kind === 'Release' ? [r] : [];
                })
                .map((rel) => ({
                  rel,
                  via: 'attestation' as const,
                  verified: src.attrs['verification'] === 'verified',
                }))
            : [];
      for (const { rel, via, verified } of releases)
        for (const he of idx.outgoing(rel.id, 'HAS_ASSET')) {
          const a = idx.nodes.get(he.to);
          if (a?.kind !== 'ReleaseAsset') continue;
          const key = `${rel.id}|${a.id}|${via}`;
          rows.set(key, {
            release: rel.name,
            asset: a.name,
            via,
            verified,
            evidence: [...be.evidence_ids.slice(0, 2), ...he.evidence_ids.slice(0, 1)],
          });
        }
    }
  }
  return [...rows.values()].sort(
    (a, b) => cmp(a.release, b.release) || cmp(a.asset, b.asset) || cmp(a.via, b.via),
  );
}

export interface DomainRow {
  domain: string;
  category: string;
  context: string;
  introduced_at: string | null;
  evidence: string[];
}

/**
 * External domains whose introduction is dated after `after` (ISO time), optionally within `withinDays` of it. Only edges that
 * carry an `introduced_at` can answer; a domain with no known introduction time is never "after" anything.
 */
export function domainsIntroducedAfter(
  idx: GraphIndex,
  after: string,
  withinDays?: number,
): DomainRow[] {
  const t0 = Date.parse(after);
  if (!Number.isFinite(t0)) return [];
  const rows: DomainRow[] = [];
  for (const e of idx.graph.edges) {
    if (e.type !== 'CONNECTS_TO' || !e.introduced_at) continue;
    const t = Date.parse(e.introduced_at);
    if (!Number.isFinite(t) || t < t0) continue;
    if (withinDays !== undefined && t - t0 > withinDays * 86_400_000) continue;
    const d = idx.nodes.get(e.to);
    if (d?.kind !== 'ExternalDomain') continue;
    rows.push({
      domain: d.name,
      category: String(d.attrs['category'] ?? ''),
      context: String(d.attrs['strongest_context'] ?? ''),
      introduced_at: e.introduced_at,
      evidence: e.evidence_ids.slice(0, 3),
    });
  }
  return rows.sort(
    (a, b) => cmp(a.introduced_at ?? '', b.introduced_at ?? '') || cmp(a.domain, b.domain),
  );
}

export interface VersionRow {
  package: string;
  version: string;
  provenance_reported: boolean;
  evidence: string[];
}

/**
 * Package versions with no VERIFIED attestation in the graph. For registry versions this is every sampled version:
 * registries only REPORT provenance, and this tool does not verify dependency attestations.
 */
export function versionsWithoutVerifiedProvenance(idx: GraphIndex): VersionRow[] {
  const rows: VersionRow[] = [];
  for (const v of idx.ofKind('PackageVersion')) {
    const verified =
      idx
        .outgoing(v.id, 'ATTESTED_BY')
        .some((e) => idx.nodes.get(e.to)?.attrs['verification'] === 'verified') ||
      // an accepted verification of a registry package version (dependency attestations)
      idx.outgoing(v.id, 'VERIFIED_BY').length > 0;
    if (verified) continue;
    const pkg = idx
      .incoming(v.id, 'RELEASES')
      .map((e) => idx.nodes.get(e.from))
      .find((n) => n?.kind === 'Package');
    rows.push({
      package: pkg?.name ?? '',
      version: v.name,
      provenance_reported: v.attrs['has_provenance'] === true,
      evidence: idx
        .incoming(v.id, 'RELEASES')
        .flatMap((e) => e.evidence_ids.slice(0, 1))
        .slice(0, 2),
    });
  }
  return rows.sort((a, b) => cmp(a.package, b.package) || cmp(a.version, b.version));
}

export const dependenciesWithUnverifiedProvenance = versionsWithoutVerifiedProvenance;

export interface PublishEdgeRow {
  package: string;
  version: string;
  at: string | null;
  evidence: string[];
}

/** When an account published sampled versions (the dated PUBLISHED_BY edges), to anchor "after publisher change Z". */
export function publishTimes(
  idx: GraphIndex,
  publisher: string,
  registry?: string,
): PublishEdgeRow[] {
  const want = publisher.toLowerCase();
  const rows: PublishEdgeRow[] = [];
  for (const pub of idx.ofKind('Publisher')) {
    if (pub.name.toLowerCase() !== want) continue;
    if (registry && !pub.id.startsWith(`publisher:${registry}:`)) continue;
    for (const e of idx.incoming(pub.id, 'PUBLISHED_BY')) {
      const v = idx.nodes.get(e.from);
      if (v?.kind !== 'PackageVersion') continue;
      const pkg = idx
        .incoming(v.id, 'RELEASES')
        .map((x) => idx.nodes.get(x.from))
        .find((n) => n?.kind === 'Package');
      rows.push({
        package: pkg?.name ?? '',
        version: v.name,
        at: e.at,
        evidence: e.evidence_ids.slice(0, 3),
      });
    }
  }
  return rows.sort((a, b) => cmp(a.at ?? '', b.at ?? '') || cmp(a.package, b.package));
}
