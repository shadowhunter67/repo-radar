import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNpm } from '../../src/registry/parse.js';
import { parseTrustedRootLines } from '../../src/trust/github-root.js';
import { HttpClient } from '../../src/util/http.js';
import {
  fetchNpmAttestation,
  npmSubjectMatches,
  npmReportedState,
  unsupportedAttestation,
  verifyNpmPublishSignature,
} from '../../src/registry/attestation.js';

describe('dependency attestation binding', () => {
  it('requires the exact npm package/version subject and the registry integrity (hex digest vs sha512-base64)', () => {
    const bytes = Buffer.alloc(64, 7);
    const integrity = `sha512-${bytes.toString('base64')}`;
    const subject = { name: 'pkg:npm/sigstore@3.1.0', digest: { sha512: bytes.toString('hex') } };
    expect(npmSubjectMatches('sigstore', '3.1.0', subject, integrity)).toBe(true);
    expect(npmSubjectMatches('sigstore', '3.1.1', subject, integrity)).toBe(false);
    expect(npmSubjectMatches('other', '3.1.0', subject, integrity)).toBe(false);
    const other = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;
    expect(npmSubjectMatches('sigstore', '3.1.0', subject, other)).toBe(false);
    // the base64 string is never equal to the hex digest
    expect(
      npmSubjectMatches(
        'sigstore',
        '3.1.0',
        { ...subject, digest: { sha512: bytes.toString('base64') } },
        integrity,
      ),
    ).toBe(false);
  });

  it('REAL fixture: sigstore@3.1.0 provenance is source_binding_verified against sigstore/sigstore-js, and a changed integrity is a conflict', async () => {
    const d = (n: string) => join(import.meta.dirname, '..', 'fixtures', 'attestations', n);
    const roots = parseTrustedRootLines(readFileSync(d('github-trusted-root.jsonl'), 'utf8'));
    const ver = JSON.parse(readFileSync(d('npm-sigstore-3.1.0.version.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const body = readFileSync(d('npm-sigstore-3.1.0.attestations.json'), 'utf8');
    const doc = (extra: Record<string, unknown> = {}) => ({
      name: 'sigstore',
      'dist-tags': { latest: '3.1.0' },
      time: { '3.1.0': '2024-10-01T00:00:00Z' },
      repository: { url: 'git+https://github.com/sigstore/sigstore-js.git' },
      versions: { '3.1.0': { ...ver, ...extra } },
    });
    const http = new HttpClient({
      allowedHosts: ['registry.npmjs.org'],
      userAgent: 't',
      fetch: (async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as never,
    });
    const run = async (extra: Record<string, unknown> = {}, repo?: string) => {
      const pkg = parseNpm(repo ? doc({ ...extra, repository: { url: repo } }) : doc(extra), {
        name: 'sigstore',
        declaredBy: 'x',
        observedAt: '2026-01-01T00:00:00Z',
      });
      return fetchNpmAttestation({
        http,
        name: 'sigstore',
        version: '3.1.0',
        versionDoc: pkg.versions[0]!,
        publicGoodRoot: roots.find((r) => r.label === 'sigstore_public_good')!,
      });
    };
    const ok = await run();
    expect(ok.map((r) => r.state)).toContain('source_binding_verified');
    const slsa = ok.find((r) => r.state === 'source_binding_verified')!;
    expect(slsa.repository).toEqual({
      value: 'sigstore/sigstore-js',
      binding: 'cryptographically_bound',
    });
    const altered = await run({
      dist: {
        ...(ver['dist'] as object),
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      },
    });
    expect(altered.map((r) => r.state)).not.toContain('source_binding_verified');
    expect(altered.map((r) => r.state)).toContain('source_binding_conflict');
    const wrongRepo = await run({}, 'git+https://github.com/someone/else.git');
    expect(wrongRepo.map((r) => r.state)).toContain('source_binding_conflict');
    expect(wrongRepo.map((r) => r.state)).not.toContain('source_binding_verified');
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

  it('REAL fixture: npm publish attestation verifies with registry-published key material', async () => {
    const d = (n: string) => join(import.meta.dirname, '..', 'fixtures', 'attestations', n);
    const version = JSON.parse(
      readFileSync(d('npm-sigstore-3.1.0.version.json'), 'utf8'),
    ) as Record<string, unknown>;
    const attestation = readFileSync(d('npm-sigstore-3.1.0.attestations.json'), 'utf8');
    const keys = readFileSync(d('npm-registry-keys.json'), 'utf8');
    const http = new HttpClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: (async (url: string) =>
        new Response(url.endsWith('/keys') ? keys : attestation, { status: 200 })) as never,
    });
    const roots = parseTrustedRootLines(readFileSync(d('github-trusted-root.jsonl'), 'utf8'));
    const parsed = parseNpm(
      { name: 'sigstore', versions: { '3.1.0': version }, time: { '3.1.0': '2025-01-01' } },
      { name: 'sigstore', declaredBy: 'x', observedAt: '2026-01-01' },
    );
    const results = await fetchNpmAttestation({
      http,
      name: 'sigstore',
      version: '3.1.0',
      versionDoc: parsed.versions[0]!,
      publicGoodRoot: roots.find((r) => r.label === 'sigstore_public_good'),
    });
    expect(
      results.some(
        (r) => r.verifiedBy === 'npm_registry_keys' && r.state === 'provenance_verified',
      ),
    ).toBe(true);
  });
});
