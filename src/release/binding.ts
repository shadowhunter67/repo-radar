import type { SlsaProperties, Verification } from '../trust/model.js';
import type { Provenance, Release, Signature } from './model.js';

/**
 * Source <-> artifact binding. Pure functions over already-collected facts. The strongest class requires a VERIFIED
 * attestation (a verifier accepted it against a stated trust root), a subject digest equal to a published asset digest, a
 * signer identity that is a CI workflow of the analyzed repository, AND a source revision equal to the commit the release tag
 * points to. Anything weaker keeps a weaker name; none of these says the artifact is reproducible.
 */
export interface TagInfoLite {
  kind: 'lightweight' | 'annotated' | 'unresolved';
  verification?: { verified?: unknown; reason?: unknown } | null;
  /** repo-radar's own check of the tag signature against the user's trusted keys, when one was run. */
  local?: Verification | undefined;
}

export function signatureBasis(s: {
  state: Signature['state'];
  verified_by: Signature['verified_by'];
  local_state: Signature['local_state'];
}): NonNullable<Signature['basis']> {
  if (s.local_state === 'verified') return 'local_crypto_verified';
  if (s.state === 'verified' && s.verified_by === 'github') return 'github_api_verified';
  if (s.state === 'present_unverified' && s.local_state === 'present_unverified')
    return 'present_unverified';
  return 'not_verified';
}

const BAD_REASONS = new Set([
  'invalid',
  'malformed_signature',
  'bad_email',
  'expired_key',
  'not_signing_key',
  'unverified_email',
]);

/**
 * GitHub's verification of an annotated tag signature, kept as GitHub's ASSERTION (`trust_root: github_api_assertion`).
 * It is never presented as a local check: `local_state` is `verification_unavailable` unless the user configured a trusted
 * key and repo-radar verified the signature itself (`local`), in which case the local result is reported beside it.
 */
export function tagSignature(tag: TagInfoLite | undefined): Signature | undefined {
  if (tag?.kind !== 'annotated') return undefined;
  const v = tag.verification;
  if (!v || typeof v !== 'object') return undefined;
  const reason = (typeof v.reason === 'string' ? v.reason : 'unknown')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 60);
  if (reason === 'unsigned') return undefined;
  const state: Signature['state'] =
    v.verified === true
      ? 'verified'
      : BAD_REASONS.has(reason)
        ? 'invalid'
        : 'verification_unavailable';
  const local = tag.local;
  const sig = {
    subject: 'tag',
    kind: 'gpg' as const,
    state,
    trust_root: 'github_api_assertion' as const,
    verified_by: 'github' as const,
    local_state: local?.state ?? ('verification_unavailable' as const),
    ...(local ? { local_detail: local } : {}),
    reason,
  };
  return { ...sig, basis: signatureBasis(sig) };
}

export interface BindingInput {
  repository: string; // owner/repo, any case
  tagCommit: string | null;
  assetDigests: Set<string>; // "algorithm:hex" of non-weak digests
  provenance: Provenance[];
  attestationsListed: number;
  checksumListed: boolean;
  digestVerified: boolean;
}

const sameRepo = (a: string | null | undefined, repo: string): boolean =>
  !!a && a.toLowerCase() === repo.toLowerCase();

export function evaluateBinding(i: BindingInput): {
  correspondence: Release['correspondence'];
  reasons: string[];
  slsa: SlsaProperties;
} {
  const reasons: string[] = [];
  const matching = i.provenance.filter((p) =>
    p.subject.some((s) => i.assetDigests.has(`${s.algorithm}:${s.digest}`)),
  );
  const verified = matching.filter((p) => p.verification === 'verified');
  const invalid = i.provenance.filter((p) => p.verification === 'invalid');
  const failed = i.provenance.filter((p) => p.verification === 'verification_failed');

  let correspondence: Release['correspondence'] = 'unlinked';
  const sourceBound = (p: Provenance): boolean =>
    !!p.source_revision && !!i.tagCommit && p.source_revision === i.tagCommit;
  const ciIdentity = (p: Provenance): boolean =>
    sameRepo(p.verification_detail?.identity?.source_repository, i.repository);

  if (verified.some((p) => ciIdentity(p) && sourceBound(p))) {
    correspondence = 'verified_source_binding';
    reasons.push(
      "a verified attestation binds an asset digest to this repository's CI workflow and to the tag commit",
    );
  } else if (
    verified.some(
      (p) =>
        !ciIdentity(p) || (p.source_revision && i.tagCommit && p.source_revision !== i.tagCommit),
    )
  ) {
    correspondence = 'source_binding_conflict';
    reasons.push(
      'a verified attestation names another signer repository or a source revision that is not the tag commit',
    );
  } else if (verified.some((p) => ciIdentity(p))) {
    correspondence = 'verified_build_provenance';
    reasons.push(
      "a verified attestation binds an asset digest to this repository's CI workflow; it names no comparable source revision",
    );
  } else if (matching.length > 0) {
    const withRev = matching.filter((p) => p.source_revision);
    if (i.tagCommit && withRev.some((p) => sourceBound(p))) {
      correspondence = 'attested_to_tag_commit';
      reasons.push(
        'an UNVERIFIED attestation for an asset digest names the tag commit as its source revision',
      );
    } else if (i.tagCommit && withRev.length > 0) {
      correspondence = 'attestation_inconsistent';
      reasons.push(
        'an attestation exists for an asset but its source revision differs from the tag commit',
      );
    } else {
      correspondence = i.tagCommit ? 'tag_only' : 'unlinked';
      reasons.push('an attestation exists but does not name a source revision');
    }
    if (failed.length > 0) reasons.push('verification of an attestation could not be completed');
  } else if (i.digestVerified) {
    correspondence = 'digest_verified_only';
    reasons.push(
      'downloaded asset bytes matched a published digest; this proves the download matches, not its origin',
    );
  } else if (i.checksumListed) {
    correspondence = 'checksum_listed';
    reasons.push(
      'assets are listed in a published checksum file; this proves integrity of the download, not origin',
    );
  } else if (i.tagCommit) {
    correspondence = 'tag_only';
    reasons.push('only the release tag and its commit are known');
  } else reasons.push('the tag could not be resolved to a commit');
  if (invalid.length > 0)
    reasons.push('an attestation was REJECTED by the verifier (signature or identity invalid)');
  if (i.attestationsListed > i.provenance.length)
    reasons.push('more attestations are listed than could be read here');

  const slsa: SlsaProperties = {
    provenance_present: i.provenance.length > 0 || i.attestationsListed > 0,
    provenance_verified: verified.length > 0,
    builder_identified:
      i.provenance.some((p) => !!p.builder_id) ||
      verified.some((p) => !!p.verification_detail?.identity?.workflow_ref),
    source_revision_bound: matching.some(sourceBound),
    subject_digest_bound: matching.length > 0,
    build_service_identified: verified.some(
      (p) => ciIdentity(p) && !!p.verification_detail?.identity?.workflow_ref,
    ),
    mapped_level: null,
  };
  return { correspondence, reasons, slsa };
}
