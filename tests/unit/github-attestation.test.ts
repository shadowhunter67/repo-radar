import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTrustedRootLines } from '../../src/trust/github-root.js';
import { verifyBundleWithRoot } from '../../src/trust/sigstore.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/attestations/${name}`, 'utf8'));
const roots = parseTrustedRootLines(
  readFileSync('tests/fixtures/attestations/github-trusted-root.jsonl', 'utf8'),
);

describe('custom Sigstore roots', () => {
  it('verifies npm provenance with the public-good root and rejects a changed digest', () => {
    const raw = fixture('npm-sigstore-3.1.0.attestations.json') as {
      attestations: Array<{ predicateType: string; bundle: unknown }>;
    };
    const root = roots.find((r) => r.label === 'sigstore_public_good');
    expect(root).toBeDefined();
    const bundle = raw.attestations.find(
      (a) => a.predicateType === 'https://slsa.dev/provenance/v1',
    )?.bundle;
    expect(bundle).toBeDefined();
    const verified = verifyBundleWithRoot(bundle, root!, {
      expectedSubjectDigest: 'not-the-registry-digest',
    });
    expect(verified.state).toBe('verified_digest_only');
    expect(verified.trust_root).toBe('sigstore_public_good');
  });

  it('keeps GitHub roots separate from public-good roots', () => {
    expect(roots.some((r) => r.label === 'github_attestation_instance')).toBe(true);
    expect(roots.some((r) => r.label === 'sigstore_public_good')).toBe(true);
  });
});
