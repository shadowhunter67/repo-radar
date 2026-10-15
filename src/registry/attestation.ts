import { createHash, verify as verifySignature } from 'node:crypto';
import type { RegistryVersion } from './model.js';
import type { HttpClient } from '../util/http.js';
import type { TrustedRootDocument } from '../trust/github-root.js';
import { verifyBundleWithRoot } from '../trust/sigstore.js';

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

export async function fetchNpmAttestation(input: {
  http: HttpClient;
  name: string;
  version: string;
  versionDoc: RegistryVersion;
  publicGoodRoot?: TrustedRootDocument;
}): Promise<AttestationResult[]> {
  if (!input.versionDoc.has_provenance)
    return [
      {
        source: 'npm',
        state: 'no_provenance',
        detail: 'the registry did not report an attestation',
      },
    ];
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(input.name)}@${encodeURIComponent(input.version)}`;
  try {
    const response = await input.http.request(url, { maxBytes: 1024 * 1024 });
    if (response.status !== 200)
      return [
        {
          source: 'npm',
          state: 'verification_unavailable',
          detail: `attestation endpoint returned HTTP ${response.status}`,
        },
      ];
    let body: { attestations?: Array<{ predicateType?: string; bundle?: unknown }> };
    try {
      body = JSON.parse(response.body) as typeof body;
    } catch {
      return [
        {
          source: 'npm',
          state: 'verification_unavailable',
          detail: 'attestation response was malformed JSON',
        },
      ];
    }
    const out: AttestationResult[] = [];
    for (const a of body.attestations ?? []) {
      if (!a.bundle) {
        out.push({
          source: 'npm',
          state: 'verification_failed',
          detail: 'attestation had no bundle',
        });
        continue;
      }
      if (!input.publicGoodRoot) {
        out.push({
          source: 'npm',
          state: 'verification_unavailable',
          detail: 'public-good trusted root was not supplied',
        });
        continue;
      }
      const v = verifyBundleWithRoot(a.bundle, input.publicGoodRoot);
      if (v.state !== 'verified') {
        out.push({ source: 'npm', state: 'verification_failed', detail: v.detail });
        continue;
      }
      const payload = (a.bundle as { dsseEnvelope?: { payload?: string } }).dsseEnvelope?.payload;
      const statement = payload
        ? (JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
            subject?: Array<{ name?: string; digest?: Record<string, string> }>;
          })
        : {};
      const subject = statement.subject?.[0];
      if (
        !subject ||
        !npmSubjectMatches(input.name, input.version, subject, input.versionDoc.integrity ?? '')
      ) {
        out.push({
          source: 'npm',
          state: 'source_binding_conflict',
          detail:
            'attestation subject does not match the exact npm package, version and registry integrity',
        });
        continue;
      }
      const boundRepo = v.identity?.source_repository;
      if (
        input.versionDoc.repository &&
        boundRepo &&
        boundRepo.toLowerCase() !== input.versionDoc.repository.toLowerCase()
      ) {
        out.push({
          source: 'npm',
          state: 'source_binding_conflict',
          detail: 'certificate-bound repository differs from the registry-declared repository',
          verifiedBy: 'sigstore_public_good',
          subject: { name: subject.name ?? '', sha512: subject.digest?.sha512 ?? '' },
          repository: { value: boundRepo, binding: 'cryptographically_bound' },
        });
        continue;
      }
      out.push({
        source: 'npm',
        state:
          input.versionDoc.repository && boundRepo
            ? 'source_binding_verified'
            : 'provenance_verified',
        detail: 'SLSA provenance verified against the Sigstore public-good root',
        verifiedBy: 'sigstore_public_good',
        subject: { name: subject.name ?? '', sha512: subject.digest?.sha512 ?? '' },
        ...(boundRepo
          ? { repository: { value: boundRepo, binding: 'cryptographically_bound' as const } }
          : {}),
      });
    }
    return out.length > 0
      ? out
      : [
          {
            source: 'npm',
            state: 'verification_failed',
            detail: 'no usable attestations were returned',
          },
        ];
  } catch (e) {
    return [
      {
        source: 'npm',
        state: 'verification_unavailable',
        detail: e instanceof Error ? e.message.slice(0, 200) : 'attestation request failed',
      },
    ];
  }
}
