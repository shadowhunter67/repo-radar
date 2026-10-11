import { z } from 'zod';
import { ConflictSchema } from '../evidence/conflict.js';

/**
 * Normalized dependency model (Phase 4).
 *
 * Everything that talks about dependencies - manifests, lockfiles, SBOMs, registries - is first mapped into these
 * shapes. Core rules, in the order they matter:
 *  - a requested specification and a resolved version are different facts and are stored separately;
 *  - "unresolved" is a first-class state, never silently treated as "fine";
 *  - every conclusion keeps the source that produced it (provenance).
 */

export const ECOSYSTEMS = ['npm', 'PyPI', 'crates.io', 'Go', 'Maven', 'unknown'] as const;
export type DepEcosystem = (typeof ECOSYSTEMS)[number];

/** Structured package identity. `purl` is a Package URL (https://github.com/package-url/purl-spec) when derivable. */
export const PackageIdSchema = z.object({
  ecosystem: z.enum(ECOSYSTEMS),
  name: z.string(),
  purl: z.string().optional(),
});
export type PackageId = z.infer<typeof PackageIdSchema>;

export const SPEC_KINDS = [
  'exact',
  'range',
  'tag',
  'branch',
  'commit',
  'git',
  'url',
  'workspace',
  'path',
  'unknown',
] as const;
export type SpecKind = (typeof SPEC_KINDS)[number];

export const RELATIONSHIPS = [
  'runtime',
  'development',
  'build',
  'optional',
  'peer',
  'test',
  'unknown',
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** What the manifest literally asked for. */
export const RequestedSchema = z.object({
  /** The specification exactly as written (bounded; control characters removed). */
  spec: z.string(),
  kind: z.enum(SPEC_KINDS),
  /** For `exact` kinds, the version the spec pins. */
  exact_version: z.string().optional(),
  /** npm `npm:real@range` aliases and similar: the package really fetched. */
  alias_of: z.string().optional(),
});
export type Requested = z.infer<typeof RequestedSchema>;

export const RESOLUTION_SOURCES = ['lockfile', 'sbom', 'manifest_pin'] as const;
export type ResolutionSource = (typeof RESOLUTION_SOURCES)[number];

/** A version that is backed by evidence from the analyzed revision. */
export const ResolvedSchema = z.object({
  version: z.string(),
  source: z.enum(RESOLUTION_SOURCES),
  /** File (or SBOM document) the version came from. */
  file: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Resolved = z.infer<typeof ResolvedSchema>;

/**
 * - `resolved`:      an exact version backed by evidence from the analyzed revision (see `resolved.source`).
 * - `ambiguous`:     several locked versions exist and the spec does not single one out.
 * - `unresolved`:    only a range/tag/branch was seen; no evidence says which version is installed.
 * - `not_registry`:  workspace/path/git/url dependencies; there is no registry version to look up.
 */
export const RESOLUTION_STATES = ['resolved', 'ambiguous', 'unresolved', 'not_registry'] as const;
export type ResolutionState = (typeof RESOLUTION_STATES)[number];

export const VULN_STATES = [
  'checked',
  'not_checked',
  'unresolved_version',
  'source_unavailable',
  'unsupported_ecosystem',
  'lookup_failed',
  'partial',
] as const;
export type VulnState = (typeof VULN_STATES)[number];

export const AdvisorySchema = z.object({
  id: z.string(),
  /** Database that reported it. */
  source: z.enum(['osv', 'deps.dev']),
  package: z.string(),
  version: z.string(),
  lookup_url: z.string(),
  looked_up_at: z.string(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

export const VulnerabilitySchema = z.object({
  state: z.enum(VULN_STATES),
  /** Why the state is what it is (always set unless `checked`). */
  reason: z.string().optional(),
  advisory_ids: z.array(z.string()),
});
export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

export const DependencySchema = z.object({
  id: z.string(),
  package: PackageIdSchema,
  relationship: z.enum(RELATIONSHIPS),
  direct: z.union([z.boolean(), z.literal('unknown')]),
  requested: RequestedSchema.optional(),
  resolution: z.enum(RESOLUTION_STATES),
  resolved: ResolvedSchema.optional(),
  /** Other exact versions seen for the same package that did not win (conflicts are never silent). */
  other_versions: z.array(
    z.object({ version: z.string(), source: z.enum(RESOLUTION_SOURCES), file: z.string() }),
  ),
  /**
   * What the registry offers TODAY for an unresolved range. Never a statement about what the analyzed revision used,
   * and never an input to a vulnerability conclusion.
   */
  registry_candidate: z
    .object({
      version: z.string(),
      source: z.literal('deps.dev'),
      observed_at: z.string(),
      note: z.string(),
    })
    .optional(),
  /** Registry metadata for the resolved version (deps.dev). Descriptive only; never a verdict. */
  package_info: z
    .object({
      source: z.literal('deps.dev'),
      licenses: z.array(z.string()),
      published_at: z.string().optional(),
      deprecated: z.boolean().optional(),
      source_repositories: z.array(z.string()),
      /** Whether deps.dev lists SLSA provenance for this version. Absence of a listing is not absence of provenance. */
      slsa_provenance_listed: z.boolean(),
    })
    .optional(),
  /**
   * `auxiliary`: declared by a manifest under examples/, docs/, tests/, tools/, website/ ... - an independent project that
   * is not what dependents install. Auxiliary dependencies are still looked up but never dilute the coverage numbers.
   */
  context: z.enum(['primary', 'auxiliary']),
  manifest_path: z.string().optional(),
  lockfile_path: z.string().optional(),
  vulnerability: VulnerabilitySchema,
  /** Where each statement above came from, e.g. `manifest:package.json`, `lockfile:package-lock.json`. */
  derived_from: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type Dependency = z.infer<typeof DependencySchema>;

/** ---- SBOM ---------------------------------------------------------------------------------------------------- */

export const SBOM_COMPONENT_CATEGORIES = [
  'library',
  'application',
  'framework',
  'container',
  'operating-system',
  'file',
  'device',
  'data',
  'other',
] as const;

export const SbomComponentSchema = z.object({
  ref: z.string(),
  category: z.enum(SBOM_COMPONENT_CATEGORIES),
  name: z.string(),
  version: z.string().optional(),
  purl: z.string().optional(),
  package: PackageIdSchema.optional(),
  scope: z.string().optional(),
  licenses: z.array(z.string()),
  hash_count: z.number(),
  supplier: z.string().optional(),
  author: z.string().optional(),
});
export type SbomComponent = z.infer<typeof SbomComponentSchema>;

export const SbomDocumentSchema = z.object({
  path: z.string(),
  format: z.enum(['CycloneDX', 'SPDX', 'unknown']),
  spec_version: z.string().optional(),
  /** `supported`, or why the document was not processed. */
  status: z.enum(['parsed', 'malformed', 'unsupported', 'too_large', 'not_an_sbom']),
  detail: z.string().optional(),
  component_count: z.number(),
  relationship_count: z.number(),
  truncated: z.boolean(),
  /** Comparison input; capped for the report. */
  components: z.array(SbomComponentSchema),
});
export type SbomDocument = z.infer<typeof SbomDocumentSchema>;

export const SBOM_COMPARISON_STATES = [
  'consistent',
  'partial',
  'mismatch',
  'unable_to_compare',
] as const;

export const SbomComparisonSchema = z.object({
  sbom_path: z.string(),
  state: z.enum(SBOM_COMPARISON_STATES),
  /** Why the comparison is only as strong as it is. */
  confidence: z.number().min(0).max(1),
  confidence_reasons: z.array(z.string()),
  direct_runtime_dependencies: z.number(),
  matched: z.number(),
  missing_from_sbom: z.array(z.string()),
  version_mismatches: z.array(
    z.object({
      package: z.string(),
      sbom_version: z.string(),
      expected: z.string(),
      basis: z.string(),
    }),
  ),
  unverifiable_versions: z.number(),
  additional_sbom_components: z.number(),
  duplicate_components: z.array(z.string()),
  invalid_versions: z.array(z.string()),
  library_components_without_purl: z.number(),
  ecosystem_mismatch: z.array(z.string()),
  notes: z.array(z.string()),
});
export type SbomComparison = z.infer<typeof SbomComparisonSchema>;

/** ---- Report section ------------------------------------------------------------------------------------------ */

export const DependencyIntelSchema = z.object({
  version: z.string(),
  /** Counts that must always be read together: a low `vulnerability_checked` makes "0 vulnerable" meaningless. */
  summary: z.object({
    discovered: z.number(),
    direct: z.number(),
    transitive: z.number(),
    /** Direct dependencies that are not looked up in a registry (workspace/path/git/url). */
    /** Dependencies declared by auxiliary manifests (examples, tests, tools...); excluded from the direct_* numbers. */
    auxiliary: z.number(),
    direct_non_registry: z.number(),
    direct_registry: z.number(),
    direct_resolved_exact: z.number(),
    direct_unresolved: z.number(),
    direct_ambiguous: z.number(),
    direct_vulnerability_checked: z.number(),
    vulnerability_checked_total: z.number(),
    vulnerable_total: z.number(),
    unsupported_ecosystem: z.number(),
    by_ecosystem: z.record(z.string(), z.number()),
    by_spec_kind: z.record(z.string(), z.number()),
  }),
  vulnerability_lookup: z.object({
    source: z.literal('osv'),
    performed: z.boolean(),
    state: z.enum(VULN_STATES),
    detail: z.string().optional(),
  }),
  deps_dev: z.object({
    enabled: z.boolean(),
    state: z.enum(['ok', 'partial', 'unavailable', 'disabled', 'not_needed']),
    requests: z.number(),
    enriched: z.number(),
    registry_candidates: z.number(),
    detail: z.string().optional(),
  }),
  lockfiles: z.array(
    z.object({
      path: z.string(),
      format: z.string(),
      packages: z.number(),
      truncated: z.boolean(),
    }),
  ),
  /** Direct dependencies first, then findings-relevant ones, capped; the rest are counted in `omitted`. */
  dependencies: z.array(DependencySchema),
  omitted: z.number(),
  advisories: z.array(AdvisorySchema),
  sboms: z.array(SbomDocumentSchema),
  sbom_comparisons: z.array(SbomComparisonSchema),
  /** Disagreeing sources for the same fact; every observation is kept (see src/evidence/conflict.ts). */
  conflicts: z.array(ConflictSchema),
  limits_hit: z.array(z.string()),
});
export type DependencyIntel = z.infer<typeof DependencyIntelSchema>;
export const DEPENDENCY_INTEL_VERSION = '0.2';

/** ---- helpers -------------------------------------------------------------------------------------------------- */

const PURL_TYPE: Record<string, DepEcosystem> = {
  npm: 'npm',
  pypi: 'PyPI',
  cargo: 'crates.io',
  golang: 'Go',
  maven: 'Maven',
};
const ECOSYSTEM_PURL: Record<DepEcosystem, string | undefined> = {
  npm: 'npm',
  PyPI: 'pypi',
  'crates.io': 'cargo',
  Go: 'golang',
  Maven: 'maven',
  unknown: undefined,
};

/** PEP 503 normalization for PyPI; other ecosystems are compared as written (npm names are already lower case). */
export function normalizeName(ecosystem: DepEcosystem, name: string): string {
  return ecosystem === 'PyPI' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;
}

export const packageKey = (ecosystem: DepEcosystem, name: string): string =>
  `${ecosystem}:${normalizeName(ecosystem, name)}`;

/** Build a purl. Returns undefined for ecosystems without a purl type. */
export function makePurl(
  ecosystem: DepEcosystem,
  name: string,
  version?: string,
): string | undefined {
  const type = ECOSYSTEM_PURL[ecosystem];
  if (!type) return undefined;
  const enc = (s: string): string =>
    encodeURIComponent(s).replace(/%2F/gi, '/').replace(/%40/g, '%40');
  let path: string;
  if (ecosystem === 'npm') {
    // @scope/name -> namespace %40scope
    path = name.startsWith('@') ? `%40${enc(name.slice(1))}` : enc(name);
  } else if (ecosystem === 'PyPI') path = enc(normalizeName('PyPI', name));
  else if (ecosystem === 'Maven') path = name.split(':').map(enc).join('/');
  else path = enc(name);
  return `pkg:${type}/${path}${version ? `@${encodeURIComponent(version)}` : ''}`;
}

export function packageId(ecosystem: DepEcosystem, name: string, version?: string): PackageId {
  const purl = makePurl(ecosystem, name, version);
  return { ecosystem, name, ...(purl ? { purl } : {}) };
}

/** Parse a purl string just far enough to recover ecosystem, name and version. Never throws. */
export function parsePurl(
  purl: string,
): { ecosystem: DepEcosystem; name: string; version?: string } | undefined {
  if (purl.length > 500 || !purl.startsWith('pkg:')) return undefined;
  const body = purl.slice(4).split('#')[0]?.split('?')[0] ?? '';
  const slash = body.indexOf('/');
  if (slash < 0) return undefined;
  const type = body.slice(0, slash).toLowerCase();
  let rest = body.slice(slash + 1);
  let version: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    version = safeDecode(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }
  const ecosystem = PURL_TYPE[type] ?? 'unknown';
  const parts = rest.split('/').map(safeDecode);
  if (parts.some((p) => p === undefined || p === '')) return undefined;
  const segs = parts as string[];
  let name: string;
  if (ecosystem === 'Maven') name = segs.join(':');
  else if (ecosystem === 'Go') name = segs.join('/');
  else name = segs.join('/');
  if (!name) return undefined;
  return { ecosystem, name, ...(version ? { version } : {}) };
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}
