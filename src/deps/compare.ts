import {
  type Dependency,
  type DepEcosystem,
  type SbomComparison,
  type SbomComponent,
  type SbomDocument,
  normalizeName,
  packageKey,
} from './model.js';
import { satisfies } from './semver.js';

/**
 * Compare an SBOM with what the repository itself shows (manifests + lockfiles).
 *
 * Deliberately NOT a "completeness percentage": extra SBOM components are normal (transitive packages, build tools,
 * OS packages), so the result is transparent counts plus explainable findings and an honest confidence.
 * States: consistent | partial | mismatch | unable_to_compare.
 */

const LIST_CAP = 20;
const cap = <T>(a: T[]): T[] => a.slice(0, LIST_CAP);
const vNorm = (v: string): string => v.trim().replace(/^v(?=\d)/, '');

export function compareSbom(doc: SbomDocument, deps: Dependency[]): SbomComparison {
  const base: SbomComparison = {
    sbom_path: doc.path,
    state: 'unable_to_compare',
    confidence: 0,
    confidence_reasons: [],
    direct_runtime_dependencies: 0,
    matched: 0,
    missing_from_sbom: [],
    version_mismatches: [],
    unverifiable_versions: 0,
    additional_sbom_components: 0,
    duplicate_components: [],
    invalid_versions: [],
    library_components_without_purl: 0,
    ecosystem_mismatch: [],
    notes: [],
  };
  if (doc.status !== 'parsed') {
    base.notes.push(doc.detail ?? `SBOM could not be processed (${doc.status})`);
    return base;
  }

  const libs = doc.components.filter((c) => c.category === 'library' || c.category === 'framework');
  if (libs.length === 0) {
    base.notes.push('the SBOM lists no library components to compare');
    return base;
  }

  // Component hygiene (independent of the repository).
  const seen = new Map<string, number>();
  for (const c of libs) {
    const key = c.purl ?? `${c.name}@${c.version ?? ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!c.purl) base.library_components_without_purl++;
    if (
      c.version === undefined ||
      /\s/.test(c.version) ||
      c.version.includes(String.fromCharCode(0)) ||
      c.version.length > 100
    )
      base.invalid_versions.push(c.name);
  }
  base.duplicate_components = cap([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  base.invalid_versions = cap(base.invalid_versions);

  // Index SBOM libraries by identity; components without a purl can only be matched by bare name (weaker).
  const byKey = new Map<string, SbomComponent[]>();
  const byName = new Map<string, SbomComponent[]>();
  for (const c of libs) {
    if (c.package) {
      const k = packageKey(c.package.ecosystem, c.package.name);
      byKey.set(k, [...(byKey.get(k) ?? []), c]);
    } else {
      const k = c.name.toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), c]);
    }
  }

  // Direct runtime dependencies of registry origin, one per package.
  const expectedMap = new Map<string, Dependency>();
  for (const d of deps) {
    if (d.direct !== true || d.relationship !== 'runtime' || d.resolution === 'not_registry')
      continue;
    const k = packageKey(d.package.ecosystem, d.package.name);
    const prev = expectedMap.get(k);
    if (!prev || (!prev.resolved && d.resolved)) expectedMap.set(k, d);
  }
  const expected = [...expectedMap.values()];
  base.direct_runtime_dependencies = expected.length;
  if (expected.length === 0) {
    base.notes.push(
      'no direct registry runtime dependencies were found in the manifests, so there is nothing to compare against',
    );
    return base;
  }

  let nameOnly = 0;
  const matchedKeys = new Set<string>();
  for (const d of expected) {
    const eco = d.package.ecosystem;
    const k = packageKey(eco, d.package.name);
    let comps = byKey.get(k);
    let weak = false;
    if (!comps) {
      comps =
        byName.get(d.package.name.toLowerCase()) ?? byName.get(normalizeName(eco, d.package.name));
      weak = !!comps;
    }
    if (!comps || comps.length === 0) {
      base.missing_from_sbom.push(`${eco}:${d.package.name}`);
      continue;
    }
    base.matched++;
    matchedKeys.add(k);
    if (weak) nameOnly++;
    const versions = comps.map((c) => c.version).filter((v): v is string => !!v);
    if (versions.length === 0) {
      base.unverifiable_versions++;
      continue;
    }
    const exact = d.resolved && d.resolved.source !== 'sbom' ? d.resolved : undefined;
    if (exact) {
      if (!versions.some((v) => vNorm(v) === vNorm(exact.version)))
        base.version_mismatches.push({
          package: `${eco}:${d.package.name}`,
          sbom_version: versions.slice(0, 3).join(', '),
          expected: exact.version,
          basis:
            exact.source === 'lockfile' ? `locked in ${exact.file}` : `pinned in ${exact.file}`,
        });
      continue;
    }
    const range = d.requested?.kind === 'range' ? d.requested.spec : undefined;
    const flavor = eco === 'npm' ? 'npm' : eco === 'crates.io' ? 'cargo' : undefined;
    const verdicts = range && flavor ? versions.map((v) => satisfies(range, vNorm(v), flavor)) : [];
    if (verdicts.length > 0 && verdicts.every((v) => v === false))
      base.version_mismatches.push({
        package: `${eco}:${d.package.name}`,
        sbom_version: versions.slice(0, 3).join(', '),
        expected: range as string,
        basis: `outside the range requested in ${d.manifest_path ?? 'the manifest'}`,
      });
    else if (!verdicts.some((v) => v === true)) base.unverifiable_versions++;
  }
  base.missing_from_sbom = cap(base.missing_from_sbom);
  base.version_mismatches = cap(base.version_mismatches);

  // Everything in the SBOM that no direct dependency accounts for: counted, never called an error.
  base.additional_sbom_components = libs.filter(
    (c) => !(c.package && matchedKeys.has(packageKey(c.package.ecosystem, c.package.name))),
  ).length;

  // Ecosystems the repository uses but the SBOM does not mention at all.
  const sbomEcos = new Set<DepEcosystem>(
    libs.flatMap((c) => (c.package ? [c.package.ecosystem] : [])),
  );
  const repoEcos = new Map<DepEcosystem, number>();
  for (const d of expected)
    repoEcos.set(d.package.ecosystem, (repoEcos.get(d.package.ecosystem) ?? 0) + 1);
  if (sbomEcos.size > 0)
    for (const [eco, n] of repoEcos)
      if (!sbomEcos.has(eco))
        base.ecosystem_mismatch.push(
          `${eco}: ${n} direct dependencies in the repository, none in the SBOM`,
        );

  const resolvedExact =
    expected.filter((d) => d.resolved && d.resolved.source !== 'sbom').length / expected.length;
  let conf = 0.45 + 0.4 * resolvedExact;
  base.confidence_reasons.push(
    `${Math.round(resolvedExact * 100)}% of direct dependencies have an exact version from the repository`,
  );
  if (nameOnly > 0) {
    conf -= 0.15;
    base.confidence_reasons.push(`${nameOnly} component(s) matched by name only (no purl)`);
  }
  if (doc.truncated) {
    conf -= 0.1;
    base.confidence_reasons.push('the SBOM was truncated by analysis limits');
  }
  if (base.invalid_versions.length > 0 || base.duplicate_components.length > 0) {
    conf -= 0.05;
    base.confidence_reasons.push('the SBOM has duplicate or invalid component entries');
  }
  base.confidence = Math.round(Math.max(0.1, Math.min(0.95, conf)) * 100) / 100;

  if (base.version_mismatches.length > 0) base.state = 'mismatch';
  else if (
    base.missing_from_sbom.length > 0 ||
    base.unverifiable_versions > 0 ||
    doc.truncated ||
    base.matched === 0
  )
    base.state = 'partial';
  else base.state = 'consistent';
  return base;
}
