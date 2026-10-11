import type { ParsedManifest } from '../collectors/manifests/parse.js';
import type { Diagnostic } from '../evidence/types.js';
import { sanitizeForTerminal } from '../util/text.js';
import { compareSbom } from './compare.js';
import type { DepsDevResult } from './depsdev.js';
import { type LockIndex, parseLock } from './lock.js';
import {
  DEPENDENCY_INTEL_VERSION,
  type Advisory,
  type Dependency,
  type DependencyIntel,
  type SbomComparison,
  type SbomDocument,
} from './model.js';
import { resolveDependencies } from './resolve.js';
import { parseSbom } from './sbom.js';
import type { VulnResult } from './vulns.js';

/** Report size bounds (the in-memory model is complete; the report carries a representative, bounded view). */
export const INTEL_REPORT_LIMITS = {
  dependencies: 300,
  advisories: 200,
  sbomComponents: 200,
} as const;

export interface DepsInput {
  manifests: ParsedManifest[];
  locks: { path: string; text: string }[];
  sboms: { path: string; text: string }[];
}

export interface DepsStatic {
  deps: Dependency[];
  conflicts: DependencyIntel['conflicts'];
  limitsHit: string[];
  locks: LockIndex[];
  sboms: SbomDocument[];
  comparisons: SbomComparison[];
  diagnostics: Diagnostic[];
}

const diag = (level: Diagnostic['level'], code: string, message: string): Diagnostic => ({
  source: 'dependencies',
  level,
  code,
  message,
});

/** Offline step: everything here works from repository files only. */
export function analyzeDependencies(input: DepsInput): DepsStatic {
  const diagnostics: Diagnostic[] = [];
  const locks: LockIndex[] = [];
  for (const l of input.locks) {
    const idx = parseLock(l.path, l.text);
    if (!idx)
      diagnostics.push(
        diag(
          'warn',
          'lockfile_unparsed',
          `${sanitizeForTerminal(l.path, 120)} could not be parsed as a lockfile. Effect: versions it would resolve stay unresolved; no vulnerability conclusion is made for them.`,
        ),
      );
    else locks.push(idx);
  }

  const sboms = input.sboms.map((s) => parseSbom(s.path, s.text));
  for (const d of sboms) {
    const p = sanitizeForTerminal(d.path, 120);
    if (d.status === 'malformed')
      diagnostics.push(
        diag(
          'warn',
          'sbom_malformed',
          `${p} looks like an SBOM by name but is malformed: ${d.detail}. Effect: it was ignored; no SBOM-based comparison was made.`,
        ),
      );
    else if (d.status === 'unsupported')
      diagnostics.push(
        diag('info', 'sbom_unsupported', `${p}: ${d.detail}. Effect: it was not ingested.`),
      );
    else if (d.status === 'too_large')
      diagnostics.push(diag('warn', 'sbom_too_large', `${p}: ${d.detail}.`));
    else if (d.status === 'not_an_sbom')
      diagnostics.push(
        diag(
          'info',
          'sbom_not_an_sbom',
          `${p} is named like an SBOM but is not a CycloneDX/SPDX document (${d.detail}). A file name alone is not treated as an SBOM.`,
        ),
      );
    else if (d.truncated) diagnostics.push(diag('info', 'sbom_truncated', `${p}: ${d.detail}`));
  }

  const { deps, conflicts, limitsHit } = resolveDependencies({
    manifests: input.manifests,
    locks,
    sboms,
  });
  const comparisons = sboms.filter((d) => d.status === 'parsed').map((d) => compareSbom(d, deps));
  for (const c of comparisons)
    diagnostics.push(
      diag(
        'info',
        'sbom_comparison',
        `${sanitizeForTerminal(c.sbom_path, 120)} vs repository: ${c.state} (${c.matched}/${c.direct_runtime_dependencies} direct runtime dependencies found, ${c.version_mismatches.length} version mismatch(es), ${c.additional_sbom_components} additional components; confidence ${Math.round(c.confidence * 100)}%).`,
      ),
    );
  for (const l of limitsHit) diagnostics.push(diag('info', 'deps_limit', l));
  return { deps, conflicts, limitsHit, locks, sboms, comparisons, diagnostics };
}

export interface IntelFlags {
  osvEnabled: boolean;
  depsDevEnabled: boolean;
}

export function finalizeIntel(
  st: DepsStatic,
  vuln: VulnResult | undefined,
  dd: DepsDevResult | undefined,
  flags: IntelFlags,
): DependencyIntel {
  const { deps } = st;
  const direct = deps.filter((d) => d.direct === true && d.context === 'primary');
  const registryDirect = direct.filter((d) => d.resolution !== 'not_registry');
  const checked = (d: Dependency): boolean =>
    d.vulnerability.state === 'checked' || d.vulnerability.state === 'partial';
  const uniq = new Set<string>();
  const vulnerable = new Set<string>();
  for (const d of deps) {
    if (!checked(d)) continue;
    const k = `${d.package.ecosystem}\0${d.package.name}\0${d.resolved?.version}`;
    uniq.add(k);
    if (d.vulnerability.advisory_ids.length > 0) vulnerable.add(k);
  }
  const count = <T>(a: T[], key: (x: T) => string): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const x of a) o[key(x)] = (o[key(x)] ?? 0) + 1;
    return o;
  };

  // Representative view: direct dependencies first, then vulnerable transitive ones.
  const listed = [
    ...direct,
    ...deps.filter((d) => d.context === 'auxiliary'),
    ...deps.filter((d) => d.direct !== true && d.vulnerability.advisory_ids.length > 0),
  ].slice(0, INTEL_REPORT_LIMITS.dependencies);
  const advisories: Advisory[] = [...(vuln?.advisories ?? []), ...(dd?.advisories ?? [])];

  const vulnState = vuln?.state ?? 'not_checked';
  return {
    version: DEPENDENCY_INTEL_VERSION,
    summary: {
      discovered: deps.length,
      direct: direct.length,
      transitive: deps.filter((d) => d.direct === false).length,
      auxiliary: deps.filter((d) => d.context === 'auxiliary').length,
      direct_non_registry: direct.length - registryDirect.length,
      direct_registry: registryDirect.length,
      direct_resolved_exact: registryDirect.filter((d) => d.resolution === 'resolved').length,
      direct_unresolved: registryDirect.filter((d) => d.resolution === 'unresolved').length,
      direct_ambiguous: registryDirect.filter((d) => d.resolution === 'ambiguous').length,
      direct_vulnerability_checked: registryDirect.filter(checked).length,
      vulnerability_checked_total: uniq.size,
      vulnerable_total: vulnerable.size,
      unsupported_ecosystem: deps.filter((d) => d.vulnerability.state === 'unsupported_ecosystem')
        .length,
      by_ecosystem: count(deps, (d) => d.package.ecosystem),
      by_spec_kind: count(direct, (d) => d.requested?.kind ?? 'unknown'),
    },
    vulnerability_lookup: {
      source: 'osv',
      performed: vuln?.performed ?? false,
      state: flags.osvEnabled ? vulnState : 'not_checked',
      ...(flags.osvEnabled
        ? vuln?.detail
          ? { detail: vuln.detail }
          : {}
        : { detail: 'disabled (--no-osv)' }),
    },
    deps_dev: {
      enabled: flags.depsDevEnabled,
      state: !flags.depsDevEnabled ? 'disabled' : (dd?.state ?? 'not_needed'),
      requests: dd?.requests ?? 0,
      enriched: dd?.enriched ?? 0,
      registry_candidates: dd?.candidates ?? 0,
      ...(dd?.detail ? { detail: dd.detail } : {}),
    },
    lockfiles: st.locks.map((l) => ({
      path: l.path,
      format: l.format,
      packages: l.entries.length,
      truncated: l.truncated,
    })),
    dependencies: listed,
    omitted: deps.length - listed.length,
    advisories: advisories.slice(0, INTEL_REPORT_LIMITS.advisories),
    sboms: st.sboms.map((d) => ({
      ...d,
      components: d.components.slice(0, INTEL_REPORT_LIMITS.sbomComponents),
    })),
    sbom_comparisons: st.comparisons,
    conflicts: st.conflicts,
    limits_hit: st.limitsHit,
  };
}

export function emptyIntel(): DependencyIntel {
  return finalizeIntel(
    {
      deps: [],
      conflicts: [],
      limitsHit: [],
      locks: [],
      sboms: [],
      comparisons: [],
      diagnostics: [],
    },
    undefined,
    undefined,
    { osvEnabled: true, depsDevEnabled: true },
  );
}
