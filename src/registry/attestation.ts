import { createHash, verify as verifySignature } from 'node:crypto';
import type { RegistryVersion } from './model.js';

export const DEPENDENCY_ATTESTATION_STATES = [
  'no_provenance',
  'provenance_reported',
  'provenance_present_unverified',
  'provenance_verified',
  'source_binding_verified',
  'source_binding_conflict',
  'verification_failed',
  'verification_unavailable',
  'verification_skipped_resource_limit',
  'unknown',
] as const;
export type DependencyAttestationState = (typeof DEPENDENCY_ATTESTATION_STATES)[number];

export interface AttestationResult {
  state: DependencyAttestationState;
  detail: string;
  source: 'npm' | 'pypi' | 'crates.io';
  verifiedBy?: 'sigstore_public_good' | 'npm_registry_keys';
  subject?: { name: string; sha512: string };
  repository?: { value: string; binding: 'cryptographically_bound' | 'claimed' };
}

export function npmSubjectMatches(
  name: string,
  version: string,
  subject: { name?: unknown; digest?: Record<string, unknown> },
  integrity: string,
): boolean {
  const expected = `pkg:npm/${name}@${version}`;
  const sha512 = typeof subject.digest?.sha512 === 'string' ? subject.digest.sha512 : '';
  return subject.name === expected && `sha512-${sha512}` === integrity;
}

export function unsupportedAttestation(registry: 'pypi' | 'crates.io'): AttestationResult {
  return {
    source: registry,
    state: 'verification_unavailable',
    detail:
      registry === 'pypi'
        ? 'PyPI PEP 740 attestations are not implemented'
        : 'crates.io trusted publishing attestations are not implemented',
  };
}

export function npmReportedState(version: RegistryVersion): DependencyAttestationState {
  return version.has_provenance ? 'provenance_reported' : 'no_provenance';
}

/** Verify npm's detached publish signature over DSSE PAE using registry-supplied public keys only. */
export function verifyNpmPublishSignature(input: {
  payloadType: string;
  payload: Buffer;
  signature: Buffer;
  publicKey: string;
}): boolean {
  const pae = Buffer.from(
    `DSSEv1 ${input.payloadType.length} ${input.payloadType} ${input.payload.length} ${input.payload.toString('utf8')}`,
  );
  return verifySignature(null, pae, input.publicKey, input.signature);
}

export function sha512Integrity(data: Buffer): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}
