import { z } from 'zod';

/**
 * Registry package intelligence. Registry metadata is ATTACKER-CONTROLLED text about a package; it describes the registry's
 * CURRENT state (owners, maintainers, latest tags) plus a per-version publish history. The two are kept apart:
 * `maintainers` have temporal scope `current_state` and are never presented as the maintainers of an old revision, while
 * `versions[].publisher` is a publish-time fact where the registry exposes it (npm `_npmUser`, crates.io `published_by`).
 *
 * Roles are never merged: a registry owner/maintainer, a version publisher, a GitHub contributor, a GitHub committer and a
 * release author are different people or accounts until evidence says otherwise.
 */
export const REGISTRIES = ['npm', 'pypi', 'crates.io'] as const;
export type RegistryId = (typeof REGISTRIES)[number];

export const LOOKUP_STATUSES = [
  'ok',
  'partial',
  'not_found',
  'rate_limited',
  'timeout',
  'server_error',
  'malformed',
  'too_large',
  'unavailable',
] as const;

export const REPO_MATCH = ['confirmed', 'likely', 'conflicting', 'missing', 'unknown'] as const;
export type RepoMatch = (typeof REPO_MATCH)[number];

export const PublisherSchema = z.object({
  /** Account name as the registry shows it (sanitized, length-capped). */
  name: z.string().max(100),
  /** The name contains non-ASCII or control characters (possible look-alike). */
  suspicious: z.boolean(),
});

export const RegistryVersionSchema = z.object({
  version: z.string().max(100),
  published_at: z.string().nullable(),
  /** Who published THIS version, when the registry exposes it. */
  publisher: PublisherSchema.nullable(),
  yanked_or_deprecated: z.boolean(),
  /** Registry-side integrity metadata exists for the artifact (npm dist.integrity, crates checksum, PyPI digests). */
  has_integrity: z.boolean(),
  integrity: z.string().max(200).nullable().optional(),
  /** The registry reports a provenance attestation for this version (npm dist.attestations). Not verified here. */
  has_provenance: z.boolean(),
  /** Source repository this VERSION declares (normalized owner/repo for GitHub, else a capped lowercase URL). npm only. */
  repository: z.string().max(120).nullable().optional(),
  /** The version declares an install-time script (npm `hasInstallScript` / preinstall, install, postinstall). npm only. */
  has_install_script: z.boolean().optional(),
  /** Maintainers the registry recorded WITH this version at publish time (npm). Historical, unlike the package-level set. */
  maintainers: z.array(z.string().max(100)).max(12).optional(),
});
export type RegistryVersion = z.infer<typeof RegistryVersionSchema>;

export const RegistryPackageSchema = z.object({
  registry: z.enum(REGISTRIES),
  name: z.string().max(214),
  /** The manifest of the analyzed repository that declares this package. */
  declared_by: z.string().max(300),
  status: z.enum(LOOKUP_STATUSES),
  status_detail: z.string().max(200),
  /** What the registry says about the source repository, normalized to owner/repo when it is a GitHub URL. */
  repository: z.object({
    declared_url: z.string().max(300).nullable(),
    normalized: z.string().max(200).nullable(),
    homepage_match: z.boolean(),
    /** The homepage / bug-tracker URL normalized to owner/repo when it is a GitHub URL. */
    homepage_normalized: z.string().max(200).nullable().optional(),
    match: z.enum(REPO_MATCH),
    reason: z.string().max(200),
  }),
  latest_version: z.string().max(100).nullable(),
  versions_total: z.number().int().min(0),
  /** Newest first, capped. */
  versions: z.array(RegistryVersionSchema).max(40),
  /** Registry maintainers/owners NOW. Temporal scope is the lookup time, not any repository revision. */
  maintainers: z.object({
    scope: z.literal('current_state'),
    names: z.array(PublisherSchema).max(30),
    duplicates: z.number().int().min(0),
  }),
  provenance: z.object({
    reported: z.enum(['yes', 'no', 'unknown']),
    versions_with: z.number().int().min(0),
  }),
  observed_at: z.string(),
  /**
   * Publish times of the versions the analyzed revision resolved to, read from the registry's FULL history (the sample above
   * keeps only the newest versions). Dependencies only; null when the registry does not list that version.
   */
  resolved_times: z.record(z.string().max(100), z.string().nullable()).optional(),
  limits: z.array(z.string().max(200)).max(6),
});
export type RegistryPackage = z.infer<typeof RegistryPackageSchema>;

export const REGISTRY_SIGNAL_KINDS = [
  'new_publisher',
  'publisher_set_changed',
  'dormancy_then_publish',
  'cadence_change',
  'repository_mismatch',
  'provenance_missing',
  'provenance_present',
  'integrity_missing',
  'suspicious_publisher_name',
  'duplicate_maintainer_identity',
] as const;

export const RegistrySignalSchema = z.object({
  id: z.string(),
  kind: z.enum(REGISTRY_SIGNAL_KINDS),
  package: z.string().max(214),
  registry: z.enum(REGISTRIES),
  /** When the described event happened (publish time), or null for a state observation. */
  at: z.string().nullable(),
  detail: z.string().max(300),
  confidence: z.number().min(0).max(1),
  /** `publish_history` events are historical facts; `current_state` signals describe the registry now. */
  scope: z.enum(['publish_history', 'current_state']),
});
export type RegistrySignal = z.infer<typeof RegistrySignalSchema>;

export const RegistryIntelSchema = z.object({
  version: z.literal('1'),
  status: z.enum(['analyzed', 'no_packages', 'disabled']),
  packages: z.array(RegistryPackageSchema).max(6),
  signals: z.array(RegistrySignalSchema).max(60),
  requests: z.number().int().min(0),
  limits_hit: z.array(z.string().max(200)).max(10),
});
export type RegistryIntel = z.infer<typeof RegistryIntelSchema>;

export const EMPTY_REGISTRY_INTEL: RegistryIntel = {
  version: '1',
  status: 'disabled',
  packages: [],
  signals: [],
  requests: 0,
  limits_hit: [],
};
