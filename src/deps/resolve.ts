import type { ParsedManifest, RawDependency } from '../collectors/manifests/parse.js';
import type { LockIndex } from './lock.js';
import {
  type Dependency,
  type DependencyIntel,
  type DepEcosystem,
  type Relationship,
  type Resolved,
  type SbomDocument,
  normalizeName,
  packageId,
  packageKey,
} from './model.js';
import { satisfies } from './semver.js';
import { classifySpec, NON_REGISTRY_KINDS } from './spec.js';

type Conflict = DependencyIntel['conflicts'][number];

export interface ResolveInput {
  manifests: ParsedManifest[];
  locks: LockIndex[];
  sboms: SbomDocument[];
  /** go.sum etc.: lockfiles that only confirm presence. */
}

export interface ResolveOutput {
  deps: Dependency[];
  conflicts: Conflict[];
  limitsHit: string[];
}

const MAX_CONFLICTS = 50;
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const ECO_FLAVOR = (e: DepEcosystem): 'npm' | 'cargo' | undefined =>
  e === 'npm' ? 'npm' : e === 'crates.io' ? 'cargo' : undefined;

/** Does this lockfile cover a manifest in `importerDir`? */
const covers = (lock: LockIndex, importerDir: string): boolean =>
  lock.dir === '' || importerDir === lock.dir || importerDir.startsWith(`${lock.dir}/`);

/**
 * Map manifests + lockfiles + SBOMs onto the normalized dependency model.
 *
 * Precedence for the exact version of a registry dependency (strongest first):
 *   lockfile  >  SBOM  >  manifest pin.
 * Disagreements between sources are recorded as conflicts; the stronger source still wins, the weaker value is kept
 * in `other_versions` so nothing is silently discarded. A range alone never produces a resolved version.
 */
export function resolveDependencies(input: ResolveInput): ResolveOutput {
  const deps: Dependency[] = [];
  const conflicts: Conflict[] = [];
  const limitsHit: string[] = [];
  let n = 0;
  const addConflict = (c: Conflict): void => {
    if (conflicts.length < MAX_CONFLICTS) conflicts.push(c);
  };

  // SBOM versions by package, for the second-strongest source.
  const sbomVersions = new Map<string, { versions: Set<string>; file: string }>();
  for (const doc of input.sboms) {
    if (doc.status !== 'parsed') continue;
    for (const c of doc.components) {
      if (c.category !== 'library' && c.category !== 'framework') continue;
      if (!c.package || !c.version || c.package.ecosystem === 'unknown') continue;
      const k = packageKey(c.package.ecosystem, c.package.name);
      const e = sbomVersions.get(k) ?? { versions: new Set<string>(), file: doc.path };
      e.versions.add(c.version);
      sbomVersions.set(k, e);
    }
  }

  const consumed = new Set<string>(); // `${lock.path}\0${name}@${version}` consumed by a direct dependency
  const locksDeepestFirst = [...input.locks].sort((a, b) => b.dir.length - a.dir.length);

  for (const m of input.manifests) {
    const raw: RawDependency[] =
      m.rawDeps ??
      m.dependencies.map((d) => ({
        name: d.name,
        spec: d.spec,
        relationship: 'runtime' as const,
        direct: true,
      }));
    if (m.rawDepsTruncated) limitsHit.push(`${m.file}: dependency list capped`);
    const importerDir = dirOf(m.file);
    const eco = m.ecosystem as DepEcosystem;
    const flavor = ECO_FLAVOR(eco);

    for (const r of raw) {
      const requested = classifySpec(eco, r.spec);
      const relationship: Relationship = r.relationship;
      const other: Dependency['other_versions'] = [];
      const derived = [`manifest:${m.file}`];
      let resolved: Resolved | undefined;
      let resolution: Dependency['resolution'] = 'unresolved';
      let lockfilePath: string | undefined;

      if (NON_REGISTRY_KINDS.has(requested.kind)) {
        resolution = 'not_registry';
      } else {
        for (const lock of locksDeepestFirst) {
          if (lock.ecosystem !== eco || !covers(lock, importerDir)) continue;
          const hit = lock.resolve(importerDir, r.name, r.spec);
          if (hit.versions.length === 0) continue;
          lockfilePath = lock.path;
          derived.push(`lockfile:${hit.via}`);
          if (hit.versions.length === 1) {
            const version = hit.versions[0] as string;
            resolved = { version, source: 'lockfile', file: lock.path, confidence: 0.95 };
            resolution = 'resolved';
            consumed.add(`${lock.path}\0${r.name}@${version}`);
            if (
              flavor &&
              requested.kind === 'range' &&
              satisfies(r.spec, version, flavor) === false
            )
              addConflict({
                package: `${eco}:${r.name}`,
                kind: 'manifest_vs_lockfile',
                detail: `${m.file} requests ${requested.spec} but ${lock.path} locks ${version} (outside the range; lockfile may be stale)`,
              });
          } else {
            resolution = 'ambiguous';
            for (const v of hit.versions)
              other.push({ version: v, source: 'lockfile', file: lock.path });
            addConflict({
              package: `${eco}:${r.name}`,
              kind: 'multiple_locked_versions',
              detail: `${lock.path} records ${hit.versions.length} versions (${hit.versions.slice(0, 4).join(', ')}) and the request does not single one out`,
            });
          }
          break;
        }

        const sb = sbomVersions.get(packageKey(eco, r.name));
        if (resolution === 'unresolved' && sb && sb.versions.size === 1) {
          const version = [...sb.versions][0] as string;
          resolved = { version, source: 'sbom', file: sb.file, confidence: 0.7 };
          resolution = 'resolved';
          derived.push(`sbom:${sb.file}`);
        } else if (resolution === 'unresolved' && sb && sb.versions.size > 1) {
          resolution = 'ambiguous';
          for (const v of sb.versions) other.push({ version: v, source: 'sbom', file: sb.file });
          derived.push(`sbom:${sb.file}`);
        } else if (resolved?.source === 'lockfile' && sb && !sb.versions.has(resolved.version)) {
          addConflict({
            package: `${eco}:${r.name}`,
            kind: 'lockfile_vs_sbom',
            detail: `${resolved.file} locks ${resolved.version} but ${sb.file} lists ${[...sb.versions].slice(0, 3).join(', ')}`,
          });
          for (const v of sb.versions) other.push({ version: v, source: 'sbom', file: sb.file });
        }

        if (requested.kind === 'exact' && requested.exact_version) {
          if (!resolved && resolution === 'unresolved') {
            const listed = input.locks
              .find((l) => l.ecosystem === eco && l.lists)
              ?.lists?.(r.name, requested.exact_version);
            resolved = {
              version: requested.exact_version,
              source: 'manifest_pin',
              file: m.file,
              confidence: eco === 'Go' && listed === false ? 0.6 : eco === 'Go' ? 0.9 : 0.85,
            };
            resolution = 'resolved';
          } else if (
            resolved &&
            resolved.version !== requested.exact_version &&
            resolved.source !== 'manifest_pin'
          ) {
            other.push({ version: requested.exact_version, source: 'manifest_pin', file: m.file });
            addConflict({
              package: `${eco}:${r.name}`,
              kind: 'manifest_vs_lockfile',
              detail: `${m.file} pins ${requested.exact_version} but ${resolved.file} resolves ${resolved.version}`,
            });
          }
        }
      }

      n++;
      deps.push({
        id: `DEP-${String(n).padStart(4, '0')}`,
        package: packageId(eco, r.name, resolved?.version),
        relationship,
        direct: r.direct,
        requested,
        resolution,
        ...(resolved ? { resolved } : {}),
        other_versions: other,
        manifest_path: m.file,
        ...(lockfilePath ? { lockfile_path: lockfilePath } : {}),
        vulnerability: { state: 'not_checked', reason: 'not looked up yet', advisory_ids: [] },
        derived_from: derived,
        confidence: resolved ? resolved.confidence : resolution === 'not_registry' ? 0.9 : 0.4,
      });
    }
  }

  // Lockfile packages no manifest asked for by name: transitive dependencies.
  const seenTransitive = new Set<string>();
  const directResolved = new Set(
    deps
      .filter((d) => d.direct === true && d.resolved)
      .map((d) => `${packageKey(d.package.ecosystem, d.package.name)}@${d.resolved?.version}`),
  );
  for (const lock of input.locks) {
    if (lock.format === 'go.sum') continue;
    if (lock.truncated)
      limitsHit.push(`${lock.path}: only the first ${lock.entries.length} packages were read`);
    for (const e of lock.entries) {
      if (e.local) continue;
      const k = `${lock.ecosystem}:${normalizeName(lock.ecosystem, e.name)}@${e.version}`;
      if (consumed.has(`${lock.path} ${e.name}@${e.version}`)) continue;
      if (seenTransitive.has(k)) continue;
      seenTransitive.add(k);
      // The same package locked at a version a direct dependency already uses is not a second dependency.
      if (directResolved.has(`${packageKey(lock.ecosystem, e.name)}@${e.version}`)) continue;
      n++;
      deps.push({
        id: `DEP-${String(n).padStart(4, '0')}`,
        package: packageId(lock.ecosystem, e.name, e.version),
        relationship: e.dev ? 'development' : e.optional ? 'optional' : 'runtime',
        direct: false,
        resolution: 'resolved',
        resolved: { version: e.version, source: 'lockfile', file: lock.path, confidence: 0.95 },
        other_versions: [],
        lockfile_path: lock.path,
        vulnerability: { state: 'not_checked', reason: 'not looked up yet', advisory_ids: [] },
        derived_from: [`lockfile:${lock.path}`],
        confidence: 0.95,
      });
    }
  }
  return { deps, conflicts, limitsHit };
}
