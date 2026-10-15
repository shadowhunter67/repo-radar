import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
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
  // in-toto subject digests are HEX; npm `dist.integrity` is `sha512-<base64>`: compare the decoded bytes, never the strings
  const hex = typeof subject.digest?.sha512 === 'string' ? subject.digest.sha512.toLowerCase() : '';
  const m = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity);
  const fromIntegrity = m ? Buffer.from(m[1] as string, 'base64').toString('hex') : '';
  return subject.name === expected && /^[0-9a-f]{128}$/.test(hex) && hex === fromIntegrity;
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

const ATTESTATION_RANK: Record<DependencyAttestationState, number> = {
  source_binding_conflict: 100,
  source_binding_verified: 90,
  provenance_verified: 80,
  provenance_reported: 30,
  provenance_present_unverified: 20,
  verification_failed: 10,
  verification_unavailable: 5,
  verification_skipped_resource_limit: 4,
  unknown: 1,
  no_provenance: 0,
};

export function aggregateAttestationResults(results: AttestationResult[]): AttestationResult {
  const best = [...results].sort(
    (a, b) => ATTESTATION_RANK[b.state] - ATTESTATION_RANK[a.state],
  )[0] ?? {
    source: 'npm' as const,
    state: 'verification_failed' as const,
    detail: 'no attestation result',
  };
  const failures = results.filter(
    (r) =>
      r !== best && (r.state === 'verification_failed' || r.state === 'verification_unavailable'),
  );
  return failures.length > 0
    ? {
        ...best,
        detail:
          `${best.detail}; other attestation results: ${failures.map((f) => f.detail).join(' | ')}`.slice(
            0,
            500,
          ),
      }
    : best;
}

/** Verify npm's detached publish signature over DSSE PAE using registry-supplied public keys only. */
export function verifyNpmPublishSignature(input: {
  payloadType: string;
  payload: Buffer;
  signature: Buffer;
  publicKey: string;
}): boolean {
  const type = Buffer.from(input.payloadType, 'utf8');
  const length = Buffer.from(String(input.payload.length), 'ascii');
  const pae = Buffer.concat([
    Buffer.from('DSSEv1 ', 'ascii'),
    Buffer.from(String(type.length), 'ascii'),
    Buffer.from(' ', 'ascii'),
    type,
    Buffer.from(' ', 'ascii'),
    length,
    Buffer.from(' ', 'ascii'),
    input.payload,
  ]);
  const key = createPublicKey({
    key: Buffer.from(input.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return verifySignature('sha256', pae, key, input.signature);
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
    let npmKeys: Array<{ keyid?: string; key?: string; expires?: string | null }> | undefined;
    for (const a of body.attestations ?? []) {
      if (!a.bundle) {
        out.push({
          source: 'npm',
          state: 'verification_failed',
          detail: 'attestation had no bundle',
        });
        continue;
      }
      const predicateType = a.predicateType ?? '';
      const envelope = (
        a.bundle as {
          dsseEnvelope?: {
            payload?: string;
            payloadType?: string;
            signatures?: Array<{ sig?: string; keyid?: string }>;
          };
        }
      ).dsseEnvelope;
      if (/github\.com\/npm\/attestation\/.*publish\/v0\.1/.test(predicateType)) {
        if (!npmKeys) {
          const keysResponse = await input.http.request(
            'https://registry.npmjs.org/-/npm/v1/keys',
            { maxBytes: 1024 * 1024 },
          );
          if (keysResponse.status !== 200) {
            out.push({
              source: 'npm',
              state: 'verification_unavailable',
              detail: `npm key endpoint returned HTTP ${keysResponse.status}`,
            });
            continue;
          }
          try {
            npmKeys =
              (
                JSON.parse(keysResponse.body) as {
                  keys?: Array<{ keyid?: string; key?: string; expires?: string | null }>;
                }
              ).keys ?? [];
          } catch {
            out.push({
              source: 'npm',
              state: 'verification_unavailable',
              detail: 'npm key response was malformed JSON',
            });
            continue;
          }
        }
        const signature = envelope?.signatures?.[0];
        const key = npmKeys.find((k) => k.keyid === signature?.keyid);
        const integrated = Number(
          (
            a.bundle as {
              verificationMaterial?: { tlogEntries?: Array<{ integratedTime?: string }> };
            }
          ).verificationMaterial?.tlogEntries?.[0]?.integratedTime,
        );
        if (!key || !signature?.sig || !envelope?.payload || !envelope.payloadType) {
          out.push({
            source: 'npm',
            state: 'verification_failed',
            detail: 'npm publish signature key was not found',
          });
          continue;
        }
        if (!Number.isFinite(integrated)) {
          out.push({
            source: 'npm',
            state: 'verification_unavailable',
            detail: 'npm publish attestation has no signed integration time',
          });
          continue;
        }
        if (key.expires && integrated * 1000 > Date.parse(key.expires)) {
          out.push({
            source: 'npm',
            state: 'verification_failed',
            detail: 'npm registry signing key was expired at the attestation time',
          });
          continue;
        }
        const payloadBytes = Buffer.from(envelope.payload, 'base64');
        if (
          !verifyNpmPublishSignature({
            payloadType: envelope.payloadType,
            payload: payloadBytes,
            signature: Buffer.from(signature.sig, 'base64'),
            publicKey: key.key ?? '',
          })
        ) {
          out.push({
            source: 'npm',
            state: 'verification_failed',
            detail: 'npm publish DSSE signature was not accepted by the registry key',
          });
          continue;
        }
        const statement = JSON.parse(payloadBytes.toString('utf8')) as {
          subject?: Array<{ name?: string; digest?: Record<string, string> }>;
        };
        const subject = statement.subject?.[0];
        if (
          !subject ||
          !npmSubjectMatches(input.name, input.version, subject, input.versionDoc.integrity ?? '')
        ) {
          out.push({
            source: 'npm',
            state: 'source_binding_conflict',
            detail:
              'npm publish attestation subject does not match the exact package version and integrity',
          });
          continue;
        }
        out.push({
          source: 'npm',
          state: 'provenance_verified',
          detail:
            'npm publish attestation verified with the registry-published signing key; no source repository is bound',
          verifiedBy: 'npm_registry_keys',
          subject: { name: subject.name ?? '', sha512: subject.digest?.sha512 ?? '' },
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
      ? [aggregateAttestationResults(out), ...out]
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
