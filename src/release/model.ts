import { z } from 'zod';

/**
 * Release and provenance entities. Everything here describes what was OBSERVED about published artifacts; it never claims a
 * binary was built from a source revision unless that is evidenced, and it never claims a signature is valid unless
 * somebody who can verify it said so (GitHub's own tag verification) - repo-radar does not verify signatures itself.
 */
export const DIGEST_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'] as const;
export const ASSET_KINDS = [
  'binary',
  'archive',
  'checksum',
  'signature',
  'attestation',
  'sbom',
  'package',
  'other',
] as const;

export const SIGNATURE_STATES = [
  'signature_present',
  'signature_verified',
  'signature_invalid',
  'verification_unavailable',
] as const;
export const SIGNATURE_KINDS = [
  'gpg',
  'sigstore',
  'cosign',
  'minisign',
  'ssh',
  'x509',
  'unknown',
] as const;

export const ArtifactDigestSchema = z.object({
  algorithm: z.enum(DIGEST_ALGORITHMS),
  value: z.string().regex(/^[0-9a-f]+$/),
  asset: z.string().max(300),
  /** Where the digest came from. `github_api` is GitHub's own digest of the stored asset. */
  source: z.enum(['checksum_file', 'github_api', 'attestation_subject']),
  evidence: z.string().max(300),
  /** md5 and sha1 are collision-prone; they are recorded but never counted as integrity evidence. */
  weak: z.boolean(),
});
export type ArtifactDigest = z.infer<typeof ArtifactDigestSchema>;

export const ReleaseAssetSchema = z.object({
  name: z.string().max(300),
  size: z.number().int().min(0).nullable(),
  content_type: z.string().max(100).nullable(),
  kind: z.enum(ASSET_KINDS),
  digest: ArtifactDigestSchema.nullable(),
  /** The name contains control characters, path separators, traversal or non-ASCII look-alikes. */
  suspicious_name: z.boolean(),
  /** More than one asset of this release has this name. */
  duplicate: z.boolean(),
  downloads: z.number().int().min(0).nullable(),
});
export type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;

export const SignatureSchema = z.object({
  /** `tag` (git tag signature), or the name of the signature asset. */
  subject: z.string().max(300),
  kind: z.enum(SIGNATURE_KINDS),
  state: z.enum(SIGNATURE_STATES),
  /** Who established the state: nobody verified it (`none`), or GitHub did. */
  verified_by: z.enum(['none', 'github']),
  reason: z.string().max(100),
});
export type Signature = z.infer<typeof SignatureSchema>;

export const ProvenanceSchema = z.object({
  /** Artifact digest the statement is about. */
  subject: z
    .array(
      z.object({
        name: z.string().max(300),
        algorithm: z.string().max(20),
        digest: z.string().max(200),
      }),
    )
    .max(20),
  predicate_type: z.string().max(200),
  /** True for SLSA provenance predicates (slsa.dev/provenance). */
  slsa: z.boolean(),
  builder_id: z.string().max(300).nullable(),
  build_type: z.string().max(300).nullable(),
  source_repository: z.string().max(300).nullable(),
  source_revision: z.string().max(100).nullable(),
  invocation: z.string().max(300).nullable(),
  /**
   * `verification_unavailable`: the statement was parsed, its signature was NOT checked. Existence of provenance is not
   * a SLSA level and not proof that the artifact was built as stated.
   */
  verification: z.enum(['verification_unavailable', 'verified_by_github']),
  /** The bundle came from GitHub's attestation API for the asset digest. */
  origin: z.enum(['github_attestation_api', 'release_asset']),
  problems: z.array(z.string().max(200)).max(10),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const CORRESPONDENCE = [
  /** Provenance names this repository and the tag's commit, and its subject digest equals the asset digest. */
  'attested_to_tag_commit',
  /** An attestation exists for the asset but its source revision is not the tag's commit. */
  'attestation_inconsistent',
  /** The asset has a digest and a checksum file lists it; nothing ties it to source beyond the tag. */
  'checksum_listed',
  /** Only the tag (and its commit) is known. */
  'tag_only',
  /** Nothing ties this release's assets to the source. */
  'unlinked',
] as const;

export const ReleaseSchema = z.object({
  tag: z.string().max(200),
  name: z.string().max(200).nullable(),
  published_at: z.string().nullable(),
  prerelease: z.boolean(),
  /** Login of the account that published the release (not necessarily a maintainer or committer). */
  published_by: z.string().max(100).nullable(),
  /** Commit the tag points to, when it could be resolved. */
  tag_commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  tag_kind: z.enum(['lightweight', 'annotated', 'unresolved']),
  assets: z.array(ReleaseAssetSchema).max(200),
  assets_total: z.number().int().min(0),
  signatures: z.array(SignatureSchema).max(50),
  provenance: z.array(ProvenanceSchema).max(20),
  correspondence: z.enum(CORRESPONDENCE),
  /** Short, factual reasons for the correspondence class. */
  correspondence_reasons: z.array(z.string().max(200)).max(10),
  checksum_files: z
    .array(
      z.object({
        asset: z.string().max(300),
        entries: z.number().int(),
        malformed_lines: z.number().int(),
        weak_only: z.boolean(),
        conflicts: z.number().int(),
        covers_assets: z.number().int(),
      }),
    )
    .max(10),
});
export type Release = z.infer<typeof ReleaseSchema>;

export const ReleaseIntelSchema = z.object({
  version: z.literal('1'),
  /** What could and could not be looked at. */
  status: z.enum(['analyzed', 'no_releases', 'unavailable', 'disabled']),
  releases: z.array(ReleaseSchema).max(10),
  releases_total: z.number().int().min(0),
  requests: z.number().int().min(0),
  limits_hit: z.array(z.string().max(200)).max(10),
});
export type ReleaseIntel = z.infer<typeof ReleaseIntelSchema>;

export const EMPTY_RELEASE_INTEL: ReleaseIntel = {
  version: '1',
  status: 'disabled',
  releases: [],
  releases_total: 0,
  requests: 0,
  limits_hit: [],
};
