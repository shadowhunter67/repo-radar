import { z } from 'zod';

/**
 * Cryptographic trust vocabulary. A verification result ALWAYS names the trust root it relied on and who performed the
 * check. Presence is never verification: a signature file, an attestation bundle or a checksum line proves nothing until a
 * verifier with a stated trust root accepted it.
 */
export const TRUST_ROOTS = [
  /** GitHub told us (API `verification` object). Preserved as GitHub's assertion, never presented as a local check. */
  'github_api_assertion',
  /** Sigstore public-good instance: Fulcio CA + Rekor key material fetched through the Sigstore TUF root. */
  'sigstore_public_good',
  /** A public key the user supplied for this run. */
  'user_supplied_key',
  /** A key pinned by the project (for example committed in the repository) and accepted by policy. */
  'project_pinned_key',
  /** The operating system trust store (X.509 chains). */
  'system_trust_store',
  /** No trust material was available or applicable. */
  'none',
  'unknown',
] as const;
export type TrustRoot = (typeof TRUST_ROOTS)[number];

export const VERIFICATION_STATES = [
  /** There is nothing to verify (no signature / attestation exists). */
  'not_present',
  /** Something exists but no verifier ran (or none was allowed to run). */
  'present_unverified',
  /** A verifier accepted it against the stated trust root. */
  'verified',
  /** A verifier rejected it: bad signature, untrusted chain, wrong identity. */
  'invalid',
  /** The verifier could not reach a decision (timeout, network, malformed or oversized input). Not a rejection, not a pass. */
  'verification_failed',
  /** The needed verifier or trust material is not available here. */
  'verification_unavailable',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const SignerIdentitySchema = z.object({
  issuer: z.string().max(200).nullable(),
  subject_alternative_name: z.string().max(400).nullable(),
  /** `owner/repo` parsed from a GitHub Actions workflow identity, lowercase. */
  source_repository: z.string().max(200).nullable(),
  /** `.github/workflows/x.yml@refs/tags/v1` part of the identity. */
  workflow_ref: z.string().max(300).nullable(),
});
export type SignerIdentity = z.infer<typeof SignerIdentitySchema>;

export const VerificationSchema = z.object({
  state: z.enum(VERIFICATION_STATES),
  trust_root: z.enum(TRUST_ROOTS),
  verified_by: z.enum(['none', 'github', 'local']),
  detail: z.string().max(240),
  identity: SignerIdentitySchema.nullable(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const unverified = (
  detail: string,
  state: VerificationState = 'present_unverified',
): Verification => ({
  state,
  trust_root: 'none',
  verified_by: 'none',
  detail: detail.slice(0, 240),
  identity: null,
});

/**
 * SLSA-related PROPERTIES observed for a release. These are individual yes/no observations, deliberately not a level:
 * a level needs requirements (isolated build, hermetic, non-falsifiable provenance...) that metadata cannot establish.
 */
export const SlsaPropertiesSchema = z.object({
  provenance_present: z.boolean(),
  provenance_verified: z.boolean(),
  builder_identified: z.boolean(),
  /** The statement names a source revision that equals the commit the release tag points to. */
  source_revision_bound: z.boolean(),
  /** A (verified) statement subject digest equals an asset digest. */
  subject_digest_bound: z.boolean(),
  /** The signing identity is a hosted CI workflow of the analyzed repository. */
  build_service_identified: z.boolean(),
  /** Always null: repo-radar does not map observations to SLSA levels. */
  mapped_level: z.null(),
});
export type SlsaProperties = z.infer<typeof SlsaPropertiesSchema>;
