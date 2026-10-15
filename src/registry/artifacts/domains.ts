import { extractDomains } from '../../domains/extract.js';
import type { ExternalDomains } from '../../domains/model.js';
import type { DependencyArtifact } from './model.js';

export interface DependencyDomainEvent {
  type:
    | 'dependency_external_domain_introduced'
    | 'dependency_external_domain_removed'
    | 'dependency_external_domain_context_changed';
  at: string | null;
  entity: string;
  package: string;
  version: string;
  hostname: string;
  detail: string;
  evidence: string[];
  confidence: number;
}
export function artifactDomains(a: DependencyArtifact): ExternalDomains {
  const scripts = a.hooks.map((h) => ({
    path: `${a.registry}:${a.package}@${a.version}:${h.name}`,
    content: h.text,
    role: 'script' as const,
  }));
  const d = extractDomains({
    files: scripts as never,
    hooks: a.hooks.map((h) => ({ context: 'install', script: h.text, files: [h.name] }) as never),
    detections: [],
  });
  return {
    ...d,
    domains: d.domains.map((x) => ({
      ...x,
      strongest_context:
        x.strongest_context === 'install'
          ? 'dependency_install'
          : x.strongest_context === 'build'
            ? 'dependency_build'
            : 'dependency_runtime',
      contexts: x.contexts.map((c) =>
        c === 'install'
          ? 'dependency_install'
          : c === 'build'
            ? 'dependency_build'
            : c === 'runtime'
              ? 'dependency_runtime'
              : c,
      ),
    })),
  };
}
export function dependencyDomainEvents(
  before: DependencyArtifact,
  after: DependencyArtifact,
  at: string | null,
): DependencyDomainEvent[] {
  if (before.registry !== after.registry || before.package !== after.package) return [];
  const a = artifactDomains(before),
    b = artifactDomains(after),
    am = new Map(a.domains.map((d) => [d.hostname, d])),
    bm = new Map(b.domains.map((d) => [d.hostname, d])),
    out: DependencyDomainEvent[] = [],
    entity = `${after.registry}:${after.package}`;
  for (const [hostname, d] of bm) {
    const old = am.get(hostname);
    if (!old)
      out.push({
        type: 'dependency_external_domain_introduced',
        at,
        entity,
        package: after.package,
        version: after.version,
        hostname,
        detail: `${hostname} introduced by ${after.package}@${after.version}`,
        evidence: after.evidence,
        confidence: d.confidence,
      });
    else if (old.strongest_context !== d.strongest_context)
      out.push({
        type: 'dependency_external_domain_context_changed',
        at,
        entity,
        package: after.package,
        version: after.version,
        hostname,
        detail: `${hostname} changed context from ${old.strongest_context} to ${d.strongest_context}`,
        evidence: after.evidence,
        confidence: d.confidence,
      });
  }
  for (const [hostname] of am)
    if (!bm.has(hostname))
      out.push({
        type: 'dependency_external_domain_removed',
        at,
        entity,
        package: after.package,
        version: after.version,
        hostname,
        detail: `${hostname} removed in ${after.package}@${after.version}`,
        evidence: before.evidence,
        confidence: 0.7,
      });
  return out;
}
