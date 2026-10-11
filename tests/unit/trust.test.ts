import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { binaryMeta } from '../../src/release/binmeta.js';
import { evaluateBinding } from '../../src/release/binding.js';
import type { Provenance } from '../../src/release/model.js';
import {
  parseWorkflowIdentity,
  verifyBundle,
  type BundleVerifier,
} from '../../src/trust/sigstore.js';
import type { Report } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, sha256, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const COMMIT = 'e'.repeat(40);
const OTHER = '9'.repeat(40);
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64');
const attest = (digest: string, rev: string | null) => ({
  attestations: [
    {
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        dsseEnvelope: {
          payload: b64({
            subject: [{ name: 'tool.tar.gz', digest: { sha256: digest } }],
            predicateType: 'https://slsa.dev/provenance/v1',
            predicate: {
              buildDefinition: {
                buildType: 'x',
                externalParameters: {},
                resolvedDependencies: rev ? [{ uri: 'u', digest: { gitCommit: rev } }] : [],
              },
              runDetails: { builder: { id: 'https://github.com/actions/runner' } },
            },
          }),
        },
      },
    },
  ],
});
/** A verifier that accepts every bundle and reports a workflow identity of the given repository. */
const accepting = (repo: string): BundleVerifier => ({
  trustRoot: 'sigstore_public_good',
  verify: async () => ({
    identity: {
      extensions: { issuer: 'https://token.actions.githubusercontent.com' },
      subjectAlternativeName: `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/v1`,
    },
  }),
});
const rejecting = (name: string, message = 'bad signature'): BundleVerifier => ({
  trustRoot: 'sigstore_public_good',
  verify: async () => {
    throw Object.assign(new Error(message), { name });
  },
});

const spec = (rev: string | null, content = 'artifact'): FakeSpec => {
  const s = goodRepo();
  s.releases = [
    {
      daysAgo: 5,
      detail: {
        tag: 'v1',
        commit: COMMIT,
        assets: { 'tool.tar.gz': content },
        attestations: { 'tool.tar.gz': attest(sha256(content), rev) },
      },
    },
  ];
  return s;
};
const run = (s: FakeSpec, extra: Parameters<typeof analyzeRepository>[1] = {}): Promise<Report> =>
  analyzeRepository(`${s.owner}/${s.repo}`, { fetch: fakeFetch(s), clock: fixedClock, ...extra });
const rel = (r: Report) => r.release_intel.releases[0]!;

describe('verification vocabulary: presence is not verification', () => {
  it('without --verify-crypto an attestation is present_unverified with no trust root', async () => {
    const r = rel(await run(spec(COMMIT)));
    expect(r.provenance[0]).toMatchObject({
      verification: 'present_unverified',
      verification_detail: null,
    });
    expect(r.correspondence).toBe('attested_to_tag_commit');
    expect(r.slsa).toMatchObject({
      provenance_present: true,
      provenance_verified: false,
      mapped_level: null,
    });
  });

  it('a verified attestation bound to this repository, the asset digest and the tag commit is verified_source_binding', async () => {
    const r = rel(
      await run(spec(COMMIT), { verifyCrypto: true, verifier: accepting('acme/widget') }),
    );
    expect(r.provenance[0]?.verification).toBe('verified');
    expect(r.provenance[0]?.verification_detail).toMatchObject({
      trust_root: 'sigstore_public_good',
      verified_by: 'local',
    });
    expect(r.correspondence).toBe('verified_source_binding');
    expect(r.slsa).toMatchObject({
      provenance_verified: true,
      source_revision_bound: true,
      subject_digest_bound: true,
      build_service_identified: true,
      mapped_level: null,
    });
  });

  it('verified provenance without a source revision is verified_build_provenance, not a source binding', async () => {
    const r = rel(
      await run(spec(null), { verifyCrypto: true, verifier: accepting('acme/widget') }),
    );
    expect(r.correspondence).toBe('verified_build_provenance');
    expect(r.slsa.source_revision_bound).toBe(false);
  });

  it('a genuine signature that names another commit or another signer repository is a source_binding_conflict', async () => {
    const wrongCommit = rel(
      await run(spec(OTHER), { verifyCrypto: true, verifier: accepting('acme/widget') }),
    );
    expect(wrongCommit.correspondence).toBe('source_binding_conflict');
    const wrongRepo = rel(
      await run(spec(COMMIT), { verifyCrypto: true, verifier: accepting('evil/widget') }),
    );
    expect(wrongRepo.correspondence).toBe('source_binding_conflict');
    const full = await run(spec(OTHER), { verifyCrypto: true, verifier: accepting('acme/widget') });
    expect(full.findings.find((x) => /contradicts/.test(x.title))?.severity).toBe('medium');
  });

  it('a verified attestation for a DIFFERENT digest does not bind the asset', async () => {
    const s = spec(COMMIT);
    s.releases[0]!.detail!.attestations = { 'tool.tar.gz': attest('0'.repeat(64), COMMIT) };
    const r = rel(await run(s, { verifyCrypto: true, verifier: accepting('acme/widget') }));
    expect(r.correspondence).not.toBe('verified_source_binding');
    expect(r.slsa.subject_digest_bound).toBe(false);
  });

  it('a rejected attestation is state invalid, raises a finding and never links the asset', async () => {
    const r = await run(spec(COMMIT), {
      verifyCrypto: true,
      verifier: rejecting('VerificationError', 'certificate chain does not validate'),
    });
    expect(rel(r).provenance[0]?.verification).toBe('invalid');
    expect(rel(r).correspondence).not.toMatch(/verified/);
    expect(r.findings.some((f) => /rejected by the verifier/.test(f.title))).toBe(true);
    expect(r.facts.find((f) => f.id === 'release.provenance.verified')?.value).toBe(false);
  });

  it('a verifier that cannot decide (TUF/network) is verification_failed: neither a pass nor a rejection', async () => {
    const r = rel(
      await run(spec(COMMIT), {
        verifyCrypto: true,
        verifier: rejecting('TUFError', 'cannot fetch root'),
      }),
    );
    expect(r.provenance[0]?.verification).toBe('verification_failed');
    expect(r.provenance[0]?.verification_detail?.state).toBe('verification_failed');
  });

  it('a missing verifier is verification_unavailable and says so', async () => {
    const r = await verifyBundle(undefined, { x: 1 });
    expect(r).toMatchObject({
      state: 'verification_unavailable',
      trust_root: 'none',
      verified_by: 'none',
    });
  });

  it('oversized or empty bundles never reach the verifier', async () => {
    let called = 0;
    const v: BundleVerifier = {
      trustRoot: 'sigstore_public_good',
      verify: async () => (called++, {}),
    };
    const big = await verifyBundle(v, { chain: 'x'.repeat(300 * 1024) });
    expect(big.state).toBe('verification_failed');
    expect(big.detail).toMatch(/size limit/);
    expect((await verifyBundle(v, undefined)).state).toBe('verification_failed');
    expect(called).toBe(0);
  });

  it('the GitHub tag assertion keeps its own trust root and is not a local verification', async () => {
    const s = goodRepo();
    s.releases = [
      {
        daysAgo: 1,
        detail: {
          tag: 'v2',
          commit: COMMIT,
          annotated: true,
          verification: { verified: true, reason: 'valid' },
          assets: { 'a.zip': 'z' },
        },
      },
    ];
    const sig = rel(await run(s)).signatures.find((x) => x.subject === 'tag')!;
    expect(sig).toMatchObject({
      state: 'verified',
      trust_root: 'github_api_assertion',
      verified_by: 'github',
      local_state: 'verification_unavailable',
    });
  });
});

describe('signer identity parsing is data-only', () => {
  it('extracts owner/repo and workflow from a GitHub Actions identity', () => {
    expect(
      parseWorkflowIdentity(
        'https://github.com/Acme/Widget/.github/workflows/rel.yml@refs/tags/v1',
        'https://token.actions.githubusercontent.com',
      ),
    ).toMatchObject({
      source_repository: 'acme/widget',
      workflow_ref: '.github/workflows/rel.yml@refs/tags/v1',
    });
  });

  it('anything else (other hosts, prefix tricks, control characters, huge strings) yields no repository', () => {
    for (const san of [
      'https://github.com.evil.example/acme/widget/.github/workflows/x.yml@refs/heads/main',
      'https://evil.example/https://github.com/acme/widget/.github/workflows/x.yml@r',
      'mailto:someone@example.com',
      'https://github.com/acme/widget/other/path@ref',
    ])
      expect(parseWorkflowIdentity(san, 'i').source_repository, san).toBeNull();
    const esc = parseWorkflowIdentity(
      `https://github.com/a/b/.github/workflows/x.yml@r${String.fromCharCode(27)}[2J`,
      null,
    );
    expect(JSON.stringify(esc).includes(String.fromCharCode(27))).toBe(false);
    const huge = parseWorkflowIdentity(
      `https://github.com/a/b/.github/workflows/x.yml@${'a'.repeat(5000)}`,
      null,
    );
    expect((huge.subject_alternative_name ?? '').length).toBeLessThanOrEqual(400);
  });
});

describe('binding logic (pure)', () => {
  const prov = (over: Partial<Provenance>): Provenance => ({
    subject: [{ name: 'a', algorithm: 'sha256', digest: 'd'.repeat(64) }],
    predicate_type: 'https://slsa.dev/provenance/v1',
    slsa: true,
    builder_id: 'b',
    build_type: null,
    source_repository: null,
    source_revision: COMMIT,
    invocation: null,
    verification: 'verified',
    verification_detail: {
      state: 'verified',
      trust_root: 'sigstore_public_good',
      verified_by: 'local',
      detail: 'ok',
      identity: {
        issuer: 'i',
        subject_alternative_name: 's',
        source_repository: 'acme/widget',
        workflow_ref: 'w',
      },
    },
    origin: 'github_attestation_api',
    problems: [],
    ...over,
  });
  const base = {
    repository: 'Acme/Widget',
    tagCommit: COMMIT,
    assetDigests: new Set([`sha256:${'d'.repeat(64)}`]),
    attestationsListed: 1,
    checksumListed: false,
    digestVerified: false,
  };

  it('the strongest class needs verification, digest, signer repository and revision together', () => {
    expect(evaluateBinding({ ...base, provenance: [prov({})] }).correspondence).toBe(
      'verified_source_binding',
    );
    expect(
      evaluateBinding({ ...base, provenance: [prov({ verification: 'present_unverified' })] })
        .correspondence,
    ).toBe('attested_to_tag_commit');
    expect(
      evaluateBinding({
        ...base,
        provenance: [prov({ verification: 'present_unverified', source_revision: OTHER })],
      }).correspondence,
    ).toBe('attestation_inconsistent');
  });

  it('digest-only and checksum-only evidence never read as source binding', () => {
    expect(evaluateBinding({ ...base, provenance: [], digestVerified: true }).correspondence).toBe(
      'digest_verified_only',
    );
    expect(evaluateBinding({ ...base, provenance: [], checksumListed: true }).correspondence).toBe(
      'checksum_listed',
    );
    expect(
      evaluateBinding({ ...base, provenance: [], attestationsListed: 0 }).slsa.provenance_present,
    ).toBe(false);
  });
});

describe('bounded asset verification and binary metadata', () => {
  const withAssets = (assets: Record<string, string>, sums: string | null): FakeSpec => {
    const s = goodRepo();
    s.releases = [
      {
        daysAgo: 3,
        detail: {
          tag: 'v3',
          commit: COMMIT,
          assets: { ...assets, ...(sums ? { SHA256SUMS: sums } : {}) },
        },
      },
    ];
    return s;
  };

  it('downloaded bytes that match the published digest are checksum_verified and the format is read, never executed', async () => {
    const elf = '\u007fELF\u0002\u0001\u0001\u0000' + '\u0000'.repeat(8) + '\u0002\u0000>\u0000';
    const s = withAssets({ 'tool-linux': elf }, `${sha256(elf)}  tool-linux\n`);
    const r = rel(await run(s, { verifyAssets: true }));
    const c = r.asset_checks.find((x) => x.asset === 'tool-linux')!;
    expect(c.state).toBe('checksum_verified');
    expect(c.inspection).toMatchObject({ format: 'elf' });
    expect(r.correspondence).toBe('digest_verified_only');
  });

  it('a mismatch between the downloaded bytes and the published checksum is a high finding', async () => {
    const s = withAssets({ 'tool.zip': 'real bytes' }, `${'0'.repeat(64)}  tool.zip\n`);
    const r = await run(s, { verifyAssets: true });
    expect(rel(r).asset_checks[0]).toMatchObject({ state: 'checksum_mismatch' });
    expect(
      r.findings.find((f) => /does not match its published digest/.test(f.title))?.severity,
    ).toBe('high');
    expect(r.facts.find((f) => f.id === 'release.assets.checksum_verified')?.value).toBe(false);
  });

  it('assets above the size limit are skipped and reported as such, never as verified', async () => {
    const s = withAssets({ 'big.zip': 'x'.repeat(1000) }, null);
    const r = rel(await run(s, { verifyAssets: true, assetLimits: { maxAssetBytes: 100 } }));
    expect(r.asset_checks[0]?.state).toBe('verification_skipped_resource_limit');
    expect(r.correspondence).not.toBe('digest_verified_only');
  });

  it('only the configured number of assets is downloaded', async () => {
    const s = withAssets(
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}.zip`, `c${i}`])),
      null,
    );
    const r = rel(await run(s, { verifyAssets: true, assetLimits: { maxAssets: 2 } }));
    expect(r.asset_checks.filter((c) => c.bytes !== null)).toHaveLength(2);
    expect(s.releaseRequests.filter((x) => x.startsWith('download:t')).length).toBe(2);
  });

  it('nothing is downloaded unless --verify-assets is set; weak algorithms are never the expected value', async () => {
    const s = withAssets({ 'a.zip': 'a' }, `${'1'.repeat(32)}  a.zip\n`);
    const r = rel(await run(s));
    expect(r.asset_checks).toEqual([]);
    expect(s.releaseRequests.some((x) => x === 'download:a.zip')).toBe(false);
  });

  it('binary headers: ELF, PE, Mach-O, scripts; truncated input is unknown rather than a crash', () => {
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    elf.writeUInt16LE(0xb7, 18);
    expect(binaryMeta(elf)).toMatchObject({ format: 'elf', architecture: 'aarch64' });
    const pe = Buffer.alloc(0x100);
    pe.write('MZ');
    pe.writeUInt32LE(0x80, 0x3c);
    pe.write('PE\u0000\u0000', 0x80, 'latin1');
    pe.writeUInt16LE(0x8664, 0x84);
    expect(binaryMeta(pe)).toMatchObject({
      format: 'pe',
      architecture: 'x86-64',
      platform: 'windows',
    });
    const mach = Buffer.alloc(16);
    mach.writeUInt32LE(0xfeedfacf, 0);
    mach.writeUInt32LE(0x0100000c, 4);
    expect(binaryMeta(mach)).toMatchObject({ format: 'macho', architecture: 'aarch64' });
    expect(binaryMeta(Buffer.from('#!/usr/bin/env sh\necho'))).toMatchObject({
      format: 'script',
      interpreter: '/usr/bin/env sh',
    });
    expect(binaryMeta(Buffer.from([1, 2]))).toMatchObject({ format: 'unknown' });
    expect(() => binaryMeta(Buffer.alloc(0))).not.toThrow();
  });
});

describe('error classification: rejection vs no decision', () => {
  const stateFor = async (name: string, msg: string) =>
    (await verifyBundle(rejecting(name, msg), { a: 1 })).state;

  it('a bad signature or certificate chain is invalid', async () => {
    expect(await stateFor('VerificationError', 'signature verification failed')).toBe('invalid');
    expect(await stateFor('PolicyError', 'certificate identity does not match')).toBe('invalid');
  });

  it('missing trust material for a timestamp or transparency log is verification_failed (observed on real goreleaser bundles)', async () => {
    expect(await stateFor('VerificationError', 'timestamp could not be verified')).toBe(
      'verification_failed',
    );
    expect(await stateFor('VerificationError', 'no matching transparency log key')).toBe(
      'verification_failed',
    );
    expect(await stateFor('TUFError', 'cannot fetch root')).toBe('verification_failed');
    expect(await stateFor('Error', 'anything else')).toBe('verification_failed');
  });
});
