import { describe, expect, it } from 'vitest';
import {
  npmSubjectMatches,
  npmReportedState,
  unsupportedAttestation,
  verifyNpmPublishSignature,
} from '../../src/registry/attestation.js';

describe('dependency attestation binding', () => {
  it('requires the exact npm package/version subject and registry integrity', () => {
    const subject = { name: 'pkg:npm/sigstore@3.1.0', digest: { sha512: 'abc' } };
    expect(npmSubjectMatches('sigstore', '3.1.0', subject, 'sha512-abc')).toBe(true);
    expect(npmSubjectMatches('sigstore', '3.1.1', subject, 'sha512-abc')).toBe(false);
    expect(npmSubjectMatches('other', '3.1.0', subject, 'sha512-abc')).toBe(false);
    expect(npmSubjectMatches('sigstore', '3.1.0', subject, 'sha512-different')).toBe(false);
  });

  it('does not pretend unsupported ecosystems are verified', () => {
    expect(unsupportedAttestation('pypi').state).toBe('verification_unavailable');
    expect(unsupportedAttestation('crates.io').state).toBe('verification_unavailable');
  });

  it('preserves reported versus absent provenance', () => {
    expect(npmReportedState({ has_provenance: true } as never)).toBe('provenance_reported');
    expect(npmReportedState({ has_provenance: false } as never)).toBe('no_provenance');
  });

  it('does not accept an arbitrary key as an npm signature verifier', () => {
    expect(() =>
      verifyNpmPublishSignature({
        payloadType: 'x',
        payload: Buffer.from('y'),
        signature: Buffer.from('z'),
        publicKey: 'not-a-key',
      }),
    ).toThrow();
  });
});
