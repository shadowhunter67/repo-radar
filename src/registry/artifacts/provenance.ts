import { createHash } from 'node:crypto';

export const ARTIFACT_PROVENANCE_CLASSES = [
  'live_registry',
  'official_registry_archive',
  'official_release_archive',
  'security_research_archive',
  'third_party_mirror',
  'reproducible_fixture',
  'synthetic_fixture',
  'unverified_historical_artifact',
  'unavailable',
] as const;
export type ArtifactProvenanceClass = (typeof ARTIFACT_PROVENANCE_CLASSES)[number];
export interface ArtifactProvenance {
  source: string;
  source_identifier: string;
  retrieved_at: string | null;
  expected_digest: string | null;
  digest_verification: 'verified' | 'mismatch' | 'missing';
  provenance_class: ArtifactProvenanceClass;
  source_confidence: number;
  unavailable_reason?: 'artifact_unavailable_from_live_registry' | 'not_found' | 'unsupported';
}
export function classifyArtifactProvenance(input: {
  source: string;
  identifier: string;
  bytes?: Uint8Array;
  expectedDigest?: string;
  retrievedAt?: string;
  kind: ArtifactProvenanceClass;
}): ArtifactProvenance {
  const actual = input.bytes && createHash('sha512').update(input.bytes).digest('base64');
  const verified =
    !!actual && !!input.expectedDigest && input.expectedDigest.replace(/^sha512-/, '') === actual;
  const missing = !input.bytes || !input.expectedDigest;
  const kind = input.kind;
  const confidence =
    kind === 'synthetic_fixture'
      ? 0
      : kind === 'unverified_historical_artifact'
        ? 0.2
        : verified &&
            [
              'live_registry',
              'official_registry_archive',
              'official_release_archive',
              'reproducible_fixture',
            ].includes(kind)
          ? 1
          : kind === 'third_party_mirror' && verified
            ? 0.6
            : 0.1;
  return {
    source: input.source,
    source_identifier: input.identifier,
    retrieved_at: input.retrievedAt ?? null,
    expected_digest: input.expectedDigest ?? null,
    digest_verification: missing ? 'missing' : verified ? 'verified' : 'mismatch',
    provenance_class: kind,
    source_confidence: confidence,
    ...(kind === 'unavailable'
      ? { unavailable_reason: 'artifact_unavailable_from_live_registry' as const }
      : {}),
  };
}
