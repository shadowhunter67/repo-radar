import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { buildTrustGraph } from '../../src/graph/trust.js';
import { dependenciesWithUnverifiedProvenance, GraphIndex } from '../../src/graph/query.js';
import { parseTrustedRootLines } from '../../src/trust/github-root.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const dir = (n: string) => join(import.meta.dirname, '..', 'fixtures', 'attestations', n);
const read = (n: string) => readFileSync(dir(n), 'utf8');
const version = JSON.parse(read('npm-sigstore-3.1.0.version.json')) as Record<string, unknown>;
const ROOTS = parseTrustedRootLines(read('github-trusted-root.jsonl'));

/** A repository that depends on sigstore@3.1.0 (locked), with the registry answering from the pinned real fixtures. */
function spec(over: { attestations?: string | number | 'big'; budget?: never } = {}): FakeSpec {
  const base = goodRepo();
  const packument = {
    name: 'sigstore',
    'dist-tags': { latest: '3.1.0' },
    time: { '3.1.0': '2024-10-01T00:00:00Z' },
    repository: { url: 'git+https://github.com/sigstore/sigstore-js.git' },
    maintainers: [{ name: 'bdehamer' }],
    versions: { '3.1.0': version },
  };
  return goodRepo({
    files: {
      ...base.files,
      'package.json': JSON.stringify({ name: 'widget', dependencies: { sigstore: '3.1.0' } }),
      'package-lock.json': JSON.stringify({
        packages: { '': { name: 'widget' }, 'node_modules/sigstore': { version: '3.1.0' } },
      }),
    },
    // the attestation endpoint must be matched before the packument URL (substring match, first hit wins)
    registry: {
      '/-/npm/v1/attestations/': JSON.parse(read('npm-sigstore-3.1.0.attestations.json')),
      '/-/npm/v1/keys': JSON.parse(read('npm-registry-keys.json')),
      'registry.npmjs.org/sigstore': packument,
    },
    registryFail:
      over.attestations === undefined
        ? {}
        : { '/-/npm/v1/attestations/': over.attestations as never },
  });
}
const run = (s: FakeSpec, extra: Parameters<typeof analyzeRepository>[1] = {}) =>
  analyzeRepository(`${s.owner}/${s.repo}`, {
    fetch: fakeFetch(s),
    clock: fixedClock,
    scorecard: false,
    osv: false,
    depsDev: false,
    ...extra,
  });
const sig = (r: Awaited<ReturnType<typeof run>>) =>
  r.dependency_registry_intel.packages.find((p) => p.name === 'sigstore');

describe('dependency attestations through the whole analysis (real npm fixtures)', () => {
  it('without --verify-crypto the provenance is present but UNVERIFIED, and no verified fact exists', async () => {
    const r = await run(spec());
    expect(sig(r)?.attestation_states?.['3.1.0']).toBe('provenance_present_unverified');
    expect(r.facts.some((f) => f.id === 'registry.deps.provenance_verified')).toBe(false);
  });

  it('with --verify-crypto and the public-good root supplied: source_binding_verified, facts, graph edge and query', async () => {
    const r = await run(spec(), { verifyCrypto: true, trust: { keys: [], trustedRoots: ROOTS } });
    expect(sig(r)?.attestation_states?.['3.1.0']).toBe('source_binding_verified');
    expect(r.facts.find((f) => f.id === 'registry.deps.source_binding_verified')?.value).toBe(true);
    const g = buildTrustGraph(r);
    expect(g.edges.some((e) => e.type === 'VERIFIED_BY' && e.from.includes('sigstore'))).toBe(true);
    expect(
      dependenciesWithUnverifiedProvenance(new GraphIndex(g)).map((x) => x.package),
    ).not.toContain('sigstore');
  });

  it('with --verify-crypto but NO Sigstore root only the npm publish attestation can verify: provenance_verified, never source_binding_verified', async () => {
    const r = await run(spec(), { verifyCrypto: true });
    expect(sig(r)?.attestation_states?.['3.1.0']).toBe('provenance_verified');
    expect(r.facts.find((f) => f.id === 'registry.deps.source_binding_verified')?.value).toBe(
      false,
    );
  });

  it.each([
    ['404', 404],
    ['500', 500],
    ['429', 429],
    ['malformed JSON', 'broken'],
    ['wrong content type', 'html'],
    ['oversized body', 'big'],
  ])(
    'attestation endpoint %s => unavailable/failed/skipped, never verified, facts withheld',
    async (_n, mode) => {
      const r = await run(spec({ attestations: mode as never }), {
        verifyCrypto: true,
        trust: { keys: [], trustedRoots: ROOTS },
      });
      const st = sig(r)?.attestation_states?.['3.1.0'];
      expect([
        'verification_unavailable',
        'verification_failed',
        'verification_skipped_resource_limit',
      ]).toContain(st);
      expect(
        r.facts.some((f) => f.id === 'registry.deps.source_binding_verified' && f.value === true),
      ).toBe(false);
    },
  );

  it('budget maxAttestations=0 leaves the state unknown, not clean', async () => {
    const r = await run(spec(), {
      verifyCrypto: true,
      trust: { keys: [], trustedRoots: ROOTS },
      dependencyRegistryBudget: { maxAttestations: 0 },
    });
    expect(sig(r)?.attestation_states?.['3.1.0']).toBe('unknown');
  });
});
