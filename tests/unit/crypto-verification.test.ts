import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as pgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { repositoryKeyFiles } from '../../src/release/verify-signatures.js';
import {
  assertPublicKeyMaterial,
  gpgKey,
  loadTrustFile,
  minisignKey,
  TrustConfigError,
  type TrustedKey,
} from '../../src/trust/config.js';
import { verifyGpgDetached } from '../../src/trust/gpg.js';
import { verifyMinisign } from '../../src/trust/minisign.js';
import { SIGSTORE_LIMITS, verifyBundle, type BundleVerifier } from '../../src/trust/sigstore.js';
import { inspectArtifact } from '../../src/registry/artifacts/inspect.js';
import type { Report } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

// ---- key material generated locally for the tests (nothing is fetched, nothing is committed) ------------------------
interface Gpg {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}
async function makeGpg(over: Record<string, unknown> = {}): Promise<Gpg> {
  const { privateKey, publicKey } = await pgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ name: 'Release Bot', email: 'bot@example.test' }],
    format: 'armored',
    ...over,
  });
  const fp = (await pgp.readKey({ armoredKey: publicKey })).getFingerprint().toUpperCase();
  return { publicKey, privateKey, fingerprint: fp };
}
async function gpgSign(key: Gpg, data: Buffer): Promise<string> {
  const priv = await pgp.readPrivateKey({ armoredKey: key.privateKey });
  return (await pgp.sign({
    message: await pgp.createMessage({ binary: new Uint8Array(data) }),
    signingKeys: priv,
    detached: true,
    format: 'armored',
  })) as string;
}

interface Mini {
  pub: string;
  keyIdHex: string;
  sign(data: Buffer, opts?: { prehashed?: boolean; comment?: string }): string;
}
function makeMinisign(): Mini {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const keyId = randomBytes(8);
  const pub = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64');
  return {
    pub,
    keyIdHex: keyId.toString('hex'),
    sign(data, o = {}) {
      const message = o.prehashed ? createHash('blake2b512').update(data).digest() : data;
      const sig = sign(null, message, privateKey);
      const head = Buffer.concat([Buffer.from(o.prehashed ? 'ED' : 'Ed'), keyId, sig]);
      const comment = o.comment ?? 'timestamp:1700000000 file:app.tar.gz';
      const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
      return [
        'untrusted comment: signature from minisign secret key',
        head.toString('base64'),
        `trusted comment: ${comment}`,
        global.toString('base64'),
        '',
      ].join('\n');
    },
  };
}

let A: Gpg;
let B: Gpg;
beforeAll(async () => {
  A = await makeGpg();
  B = await makeGpg();
}, 60_000);

const DATA = Buffer.from('release artifact bytes\n');

// ---- OpenPGP ----------------------------------------------------------------------------------------------------
describe('OpenPGP detached signature verification (configured keys only)', () => {
  it('a valid signature by a user-supplied key is verified and names its trust root and engine', async () => {
    const sig = await gpgSign(A, DATA);
    const v = await verifyGpgDetached({
      signature: sig,
      data: DATA,
      keys: [gpgKey(A.publicKey)],
      subject: 'app.tar.gz',
    });
    expect(v).toMatchObject({
      state: 'verified',
      trust_root: 'user_supplied_gpg_key',
      engine: 'openpgp',
      verified_by: 'local',
      subject: 'app.tar.gz',
    });
  });

  it('a key pinned in a user-maintained trust file is reported as project_pinned', async () => {
    const sig = await gpgSign(A, DATA);
    const v = await verifyGpgDetached({
      signature: sig,
      data: DATA,
      keys: [gpgKey(A.publicKey, 'project_pinned', A.fingerprint)],
      subject: 'x',
    });
    expect(v.state).toBe('verified');
    expect(v.trust_root).toBe('project_pinned_gpg_key');
  });

  it('a signature over different bytes is invalid, not a failure to decide', async () => {
    const sig = await gpgSign(A, DATA);
    const v = await verifyGpgDetached({
      signature: sig,
      data: Buffer.from('tampered'),
      keys: [gpgKey(A.publicKey)],
      subject: 'x',
    });
    expect(v.state).toBe('invalid');
    expect(v.trust_root).toBe('user_supplied_gpg_key');
  });

  it('a signature by a key that is not trusted cannot be decided: unavailable, never verified, never invalid', async () => {
    const sig = await gpgSign(B, DATA);
    const v = await verifyGpgDetached({
      signature: sig,
      data: DATA,
      keys: [gpgKey(A.publicKey)],
      subject: 'x',
    });
    expect(v.state).toBe('verification_unavailable');
    expect(v.trust_root).toBe('none');
    expect(v.detail).toMatch(/not among the 1 trusted key/);
  });

  it('with no configured key nothing is verified (no host keyring is consulted)', async () => {
    const v = await verifyGpgDetached({
      signature: await gpgSign(A, DATA),
      data: DATA,
      keys: [],
      subject: 'x',
    });
    expect(v.state).toBe('verification_unavailable');
    expect(v.detail).toMatch(/no trusted GPG key/);
  });

  it('a fingerprint pin that does not match rejects the key', async () => {
    const v = await verifyGpgDetached({
      signature: await gpgSign(A, DATA),
      data: DATA,
      keys: [gpgKey(A.publicKey, 'project_pinned', B.fingerprint)],
      subject: 'x',
    });
    expect(v.state).toBe('verification_failed');
    expect(v.detail).toMatch(/fingerprint pin/);
  });

  it('a key that has expired is not trusted, even for a signature dated while it was valid', async () => {
    const old = await makeGpg({ date: new Date('2020-01-01'), keyExpirationTime: 3600 });
    const priv = await pgp.readPrivateKey({ armoredKey: old.privateKey });
    const sig = (await pgp.sign({
      message: await pgp.createMessage({ binary: new Uint8Array(DATA) }),
      signingKeys: priv,
      detached: true,
      format: 'armored',
      date: new Date('2020-01-01T00:30:00Z'),
    })) as string;
    const v = await verifyGpgDetached({
      signature: sig,
      data: DATA,
      keys: [gpgKey(old.publicKey)],
      subject: 'x',
    });
    expect(v.state).toBe('invalid');
    expect(v.detail).toMatch(/has expired/);
  });

  it('garbage and oversized signatures never reach the parser', async () => {
    const keys = [gpgKey(A.publicKey)];
    const junk = await verifyGpgDetached({
      signature: Buffer.from('not a signature at all'),
      data: DATA,
      keys,
      subject: 'x',
    });
    expect(junk.state).toBe('verification_failed');
    const big = await verifyGpgDetached({
      signature: Buffer.alloc(100_000, 1),
      data: DATA,
      keys,
      subject: 'x',
    });
    expect(big.state).toBe('verification_skipped_resource_limit');
    const huge = await verifyGpgDetached({
      signature: await gpgSign(A, DATA),
      data: Buffer.alloc(9 * 1024 * 1024),
      keys,
      subject: 'x',
    });
    expect(huge.state).toBe('verification_skipped_resource_limit');
  });

  it('private key material is refused everywhere', () => {
    expect(() => gpgKey(A.privateKey)).toThrow(TrustConfigError);
    expect(() => assertPublicKeyMaterial(A.privateKey)).toThrow(/private key/);
    expect(() => minisignKey('untrusted comment: minisign secret key\nRWQ=')).toThrow(
      TrustConfigError,
    );
  });
});

// ---- minisign ---------------------------------------------------------------------------------------------------
describe('minisign verification (explicit key required)', () => {
  const keysOf = (m: Mini): TrustedKey[] => [minisignKey(m.pub)];

  it('a valid signature by a configured key is verified', () => {
    const m = makeMinisign();
    const v = verifyMinisign({
      signatureText: m.sign(DATA),
      data: DATA,
      keys: keysOf(m),
      subject: 'app.tar.gz',
    });
    expect(v).toMatchObject({
      state: 'verified',
      engine: 'minisign',
      trust_root: 'user_supplied_minisign_key',
    });
  });

  it('the pre-hashed (ED) mode verifies too', () => {
    const m = makeMinisign();
    expect(
      verifyMinisign({
        signatureText: m.sign(DATA, { prehashed: true }),
        data: DATA,
        keys: keysOf(m),
        subject: 'x',
      }).state,
    ).toBe('verified');
  });

  it('changed data or a swapped trusted comment is invalid', () => {
    const m = makeMinisign();
    const text = m.sign(DATA);
    expect(
      verifyMinisign({ signatureText: text, data: Buffer.from('x'), keys: keysOf(m), subject: 'x' })
        .state,
    ).toBe('invalid');
    const swapped = text.replace('app.tar.gz', 'evil.tar.gz');
    const v = verifyMinisign({ signatureText: swapped, data: DATA, keys: keysOf(m), subject: 'x' });
    expect(v.state).toBe('invalid');
    expect(v.detail).toMatch(/trusted comment/);
  });

  it('a .minisig alone is not trust: unknown key id is unavailable, no key is unavailable', () => {
    const signer = makeMinisign();
    const other = makeMinisign();
    const text = signer.sign(DATA);
    const a = verifyMinisign({
      signatureText: text,
      data: DATA,
      keys: keysOf(other),
      subject: 'x',
    });
    expect(a.state).toBe('verification_unavailable');
    expect(a.detail).toContain(signer.keyIdHex);
    const b = verifyMinisign({ signatureText: text, data: DATA, keys: [], subject: 'x' });
    expect(b.state).toBe('verification_unavailable');
    expect(b.detail).toMatch(/not trust/);
  });

  it('malformed and oversized files are rejected before any crypto', () => {
    const m = makeMinisign();
    expect(
      verifyMinisign({ signatureText: 'hello', data: DATA, keys: keysOf(m), subject: 'x' }).state,
    ).toBe('verification_failed');
    expect(
      verifyMinisign({
        signatureText: 'x'.repeat(5000),
        data: DATA,
        keys: keysOf(m),
        subject: 'x',
      }).state,
    ).toBe('verification_skipped_resource_limit');
  });
});

// ---- Sigstore blob bundles --------------------------------------------------------------------------------------
describe('Sigstore blob bundle verification', () => {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest();
  const blobBundle = (data: Buffer, extra: Record<string, unknown> = {}) => ({
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: 'AAAA' },
      tlogEntries: [{ logIndex: '1' }],
      ...extra,
    },
    messageSignature: {
      messageDigest: { algorithm: 'SHA2_256', digest: sha(data).toString('base64') },
      signature: 'AAAA',
    },
  });
  const ok = (san = 'https://github.com/acme/widget/.github/workflows/release.yml@refs/tags/v1') =>
    ({
      trustRoot: 'sigstore_public_good',
      verify: async () => ({
        identity: {
          subjectAlternativeName: san,
          extensions: { issuer: 'https://token.actions.githubusercontent.com' },
        },
      }),
    }) satisfies BundleVerifier;
  const failing = (name: string, message: string, code?: string): BundleVerifier => ({
    trustRoot: 'sigstore_public_good',
    verify: async () => {
      throw Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
    },
  });

  it('a valid blob bundle is verified, with identity, engine and subject', async () => {
    const v = await verifyBundle(ok(), blobBundle(DATA), { data: DATA, subject: 'app.tar.gz' });
    expect(v).toMatchObject({
      state: 'verified',
      trust_root: 'sigstore_public_good',
      engine: 'sigstore',
      verified_by: 'local',
      subject: 'app.tar.gz',
    });
    expect(v.identity?.source_repository).toBe('acme/widget');
  });

  it('the artifact digest is checked first: a bundle for other bytes is invalid without asking the verifier', async () => {
    let called = 0;
    const v: BundleVerifier = {
      trustRoot: 'sigstore_public_good',
      verify: async () => (called++, {}),
    };
    const r = await verifyBundle(v, blobBundle(DATA), { data: Buffer.from('other bytes') });
    expect(r.state).toBe('invalid');
    expect(r.detail).toMatch(/digest does not match/);
    expect(called).toBe(0);
  });

  it('a blob bundle without the artifact bytes cannot be verified', async () => {
    expect((await verifyBundle(ok(), blobBundle(DATA))).state).toBe('verification_unavailable');
  });

  it('an expected identity that does not match makes a cryptographically valid signature invalid', async () => {
    const wrong = await verifyBundle(ok(), blobBundle(DATA), {
      data: DATA,
      expectedIdentity: { sourceRepository: 'someone/else' },
    });
    expect(wrong.state).toBe('invalid');
    expect(wrong.detail).toMatch(/signed by acme\/widget, expected someone\/else/);
    const right = await verifyBundle(ok(), blobBundle(DATA), {
      data: DATA,
      expectedIdentity: { sourceRepository: 'ACME/widget' },
    });
    expect(right.state).toBe('verified');
  });

  it('without an expected identity the signer is reported, not judged', async () => {
    const v = await verifyBundle(
      ok('https://github.com/evil/repo/.github/workflows/x.yml@refs/heads/main'),
      blobBundle(DATA),
      {
        data: DATA,
      },
    );
    expect(v.state).toBe('verified');
    expect(v.identity?.source_repository).toBe('evil/repo');
  });

  it('an invalid transparency-log inclusion proof is invalid', async () => {
    const byCode = await verifyBundle(
      failing(
        'VerificationError',
        'calculated root hash does not match inclusion proof',
        'TLOG_INCLUSION_PROOF_ERROR',
      ),
      blobBundle(DATA),
      { data: DATA },
    );
    expect(byCode.state).toBe('invalid');
    const byMessage = await verifyBundle(
      failing('VerificationError', 'calculated root hash does not match inclusion proof'),
      blobBundle(DATA),
      { data: DATA },
    );
    expect(byMessage.state).toBe('invalid');
  });

  it('an expired certificate is invalid', async () => {
    const v = await verifyBundle(
      failing(
        'VerificationError',
        'certificate is not valid or expired at the specified date',
        'CERTIFICATE_ERROR',
      ),
      blobBundle(DATA),
      { data: DATA },
    );
    expect(v.state).toBe('invalid');
  });

  it('missing trust material is verification_failed: neither a pass nor a rejection', async () => {
    for (const [msg, code] of [
      ['key not found: abc', 'PUBLIC_KEY_ERROR'],
      ['no matching trusted root for this bundle', undefined],
      ['timestamp could not be verified', 'TIMESTAMP_ERROR'],
    ] as const) {
      const v = await verifyBundle(failing('VerificationError', msg, code), blobBundle(DATA), {
        data: DATA,
      });
      expect(v.state, msg).toBe('verification_failed');
    }
  });

  it('bundles over the limits are skipped, never verified', async () => {
    let called = 0;
    const v: BundleVerifier = {
      trustRoot: 'sigstore_public_good',
      verify: async () => (called++, {}),
    };
    const tooBig = await verifyBundle(v, {
      ...blobBundle(DATA),
      padding: 'x'.repeat(SIGSTORE_LIMITS.maxBundleBytes),
    });
    const manyCerts = await verifyBundle(
      v,
      blobBundle(DATA, {
        certificate: undefined,
        x509CertificateChain: {
          certificates: Array.from({ length: 9 }, () => ({ rawBytes: 'AA' })),
        },
      }),
      { data: DATA },
    );
    const manyLogs = await verifyBundle(
      v,
      blobBundle(DATA, { tlogEntries: Array.from({ length: 5 }, () => ({})) }),
      { data: DATA },
    );
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: Array.from({ length: 65 }, (_, i) => ({
        name: `a${i}`,
        digest: { sha256: 'a'.repeat(64) },
      })),
    };
    const manySubjects = await verifyBundle(v, {
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
        payloadType: 'x',
        signatures: [],
      },
      verificationMaterial: { certificate: { rawBytes: 'AA' }, tlogEntries: [{}] },
    });
    for (const r of [tooBig, manyCerts, manyLogs, manySubjects])
      expect(r.state).toBe('verification_skipped_resource_limit');
    expect(called).toBe(0);
  });

  it('no verifier: unavailable and no trust root claimed', async () => {
    const v = await verifyBundle(undefined, blobBundle(DATA), { data: DATA });
    expect(v).toMatchObject({
      state: 'verification_unavailable',
      trust_root: 'none',
      engine: 'none',
    });
  });
});

// ---- trust configuration ----------------------------------------------------------------------------------------
describe('trust configuration', () => {
  it('a trust file pins keys as project_pinned and holds the expected identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-trust-'));
    writeFileSync(join(dir, 'release.asc'), A.publicKey);
    writeFileSync(
      join(dir, 'trust.json'),
      JSON.stringify({
        keys: [
          { kind: 'gpg', file: 'release.asc', fingerprint: A.fingerprint },
          {
            kind: 'minisign',
            material: 'RWQabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ',
          },
        ],
        expected_identity: { source_repository: 'acme/widget' },
      }),
    );
    const t = loadTrustFile(join(dir, 'trust.json'));
    expect(t.keys.map((k) => [k.kind, k.origin])).toEqual([
      ['gpg', 'project_pinned'],
      ['minisign', 'project_pinned'],
    ]);
    expect(t.expectedIdentity).toEqual({ sourceRepository: 'acme/widget' });
  });

  it('rejects unknown fields, key entries with both file and material, and private keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-trust-'));
    const put = (name: string, v: unknown): string => {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(v));
      return p;
    };
    expect(() => loadTrustFile(put('a.json', { keys: [], trust_all: true }))).toThrow(
      TrustConfigError,
    );
    expect(() =>
      loadTrustFile(put('b.json', { keys: [{ kind: 'gpg', file: 'x', material: 'y' }] })),
    ).toThrow(/exactly one/);
    expect(() =>
      loadTrustFile(put('c.json', { keys: [{ kind: 'gpg', material: A.privateKey }] })),
    ).toThrow(/private key/);
    expect(() => loadTrustFile(join(dir, 'missing.json'))).toThrow(/not found/);
  });

  it('committed key files are reported as evidence and never as trusted', () => {
    const keys = repositoryKeyFiles([
      'README.md',
      'KEYS',
      'keys/release.asc',
      'minisign.pub',
      'src/a.ts',
    ]);
    expect(keys.map((k) => k.path)).toEqual(['KEYS', 'keys/release.asc', 'minisign.pub']);
    for (const k of keys) {
      expect(k.state).toBe('key_present_in_repository');
      expect(k.trusted).toBe(false);
    }
  });
});

// ---- through the whole pipeline ---------------------------------------------------------------------------------
const OWNER = 'acme';
const REPO = 'widget';
const COMMIT = 'c'.repeat(40);

function releaseSpec(over: {
  assets: Record<string, string>;
  annotated?: boolean;
  verification?: { verified: boolean; reason: string; signature?: string; payload?: string };
  files?: Record<string, string>;
}): FakeSpec {
  const base = goodRepo();
  return goodRepo({
    files: { ...base.files, ...(over.files ?? {}) },
    releases: [
      {
        daysAgo: 5,
        detail: {
          tag: 'v1.0.0',
          commit: COMMIT,
          ...(over.annotated ? { annotated: true } : {}),
          ...(over.verification ? { verification: over.verification } : {}),
          assets: over.assets,
        },
      },
    ],
  });
}
async function run(
  spec: FakeSpec,
  opts: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> {
  return analyzeRepository(`${OWNER}/${REPO}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    scorecard: false,
    osv: false,
    depsDev: false,
    registry: false,
    ...opts,
  });
}
const sigOf = (r: Report, subject: string) =>
  r.release_intel.releases[0]?.signatures.find((s) => s.subject === subject);

describe('release signatures through the pipeline', () => {
  it('dependency archives, SBOM contents, and registry metadata cannot become trust roots', async () => {
    const fixture = readFileSync(
      join(process.cwd(), 'tests/fixtures/artifacts/npm-colors-1.4.0.tgz'),
    );
    const inspected = inspectArtifact(fixture);
    expect(inspected.state).not.toBe('verified');
    expect(inspected.entries.some((e) => /key|trust|root/i.test(e.path))).toBe(false);
    expect(JSON.stringify(inspected)).not.toMatch(/trust_root|verified_by/);

    const synthetic = new Uint8Array(1024);
    const header = new TextEncoder().encode('keys/release.asc');
    synthetic.set(header, 0);
    synthetic[100] = 0;
    synthetic[156] = 0x30;
    synthetic.set(new TextEncoder().encode('00000000000\0'), 124);
    synthetic.set(new TextEncoder().encode('ustar\0'), 257);
    synthetic.set(new Uint8Array(512), 512);
    const embedded = inspectArtifact(gzipSync(synthetic));
    expect(embedded.state).not.toBe('verified');
    expect(embedded.entries.some((e) => e.path === 'keys/release.asc')).toBe(true);
    expect(JSON.stringify(embedded)).not.toMatch(/trust_root|verified_by/);

    const s = releaseSpec({
      assets: { 'app.tar.gz': 'artifact', 'app.tar.gz.asc': 'not-a-signature' },
      files: {
        'sbom.json': JSON.stringify({
          components: [{ name: 'fake-root', publicKey: 'not trusted' }],
        }),
      },
    });
    const report = await run(s);
    expect(report.analysis_manifest.trust_roots).toEqual([]);
    expect(sigOf(report, 'app.tar.gz')?.state).not.toBe('verified');
    expect(report.release_intel.releases[0]?.correspondence).not.toBe('verified_source_binding');
    expect(
      report.dependency_intel.sboms.every(
        (x) => JSON.stringify(x).includes('trust_root') === false,
      ),
    ).toBe(true);
  });

  it('an OpenPGP signature asset verifies against the user-supplied key and is reported as local crypto', async () => {
    const artifact = 'binary-content-of-app';
    const sig = await gpgSign(A, Buffer.from(artifact));
    const spec = releaseSpec({ assets: { 'app.tar.gz': artifact, 'app.tar.gz.asc': sig } });
    const r = await run(spec, { trust: { keys: [gpgKey(A.publicKey)] }, verifyCrypto: false });
    const s = sigOf(r, 'app.tar.gz');
    expect(s).toMatchObject({
      kind: 'gpg',
      state: 'verified',
      trust_root: 'user_supplied_gpg_key',
      verified_by: 'local',
      local_state: 'verified',
      basis: 'local_crypto_verified',
    });
    expect(s?.local_detail).toMatchObject({ engine: 'openpgp', subject: 'app.tar.gz' });
    expect(r.release_intel.verification_run).toMatchObject({ signatures: true, trusted_keys: 1 });
  });

  it('a tampered artifact is invalid; a key that is not configured leaves the signature unverified', async () => {
    const sig = await gpgSign(A, Buffer.from('original'));
    const spec = releaseSpec({ assets: { 'app.tar.gz': 'tampered', 'app.tar.gz.asc': sig } });
    const bad = await run(spec, { trust: { keys: [gpgKey(A.publicKey)] } });
    expect(sigOf(bad, 'app.tar.gz')).toMatchObject({ state: 'invalid', basis: 'not_verified' });
    const noKey = await run(spec);
    expect(sigOf(noKey, 'app.tar.gz')).toMatchObject({
      state: 'present_unverified',
      local_state: 'present_unverified',
      basis: 'present_unverified',
    });
    const otherKey = await run(spec, { trust: { keys: [gpgKey(B.publicKey)] } });
    expect(sigOf(otherKey, 'app.tar.gz')?.state).toBe('verification_unavailable');
  });

  it('a public key committed in the repository is evidence only: it does not verify anything', async () => {
    const artifact = 'binary-content-of-app';
    const sig = await gpgSign(A, Buffer.from(artifact));
    const spec = releaseSpec({
      assets: { 'app.tar.gz': artifact, 'app.tar.gz.asc': sig },
      files: { 'release-key.asc': A.publicKey },
    });
    const r = await run(spec); // the user trusts nothing
    expect(r.release_intel.key_material_in_repository).toEqual([
      { path: 'release-key.asc', kind: 'gpg', state: 'key_present_in_repository', trusted: false },
    ]);
    expect(sigOf(r, 'app.tar.gz')?.state).toBe('present_unverified');
    expect(sigOf(r, 'app.tar.gz')?.trust_root).toBe('none');
    // and no request fetched the committed key
    expect(spec.releaseRequests.some((x) => x.includes('release-key'))).toBe(false);
  });

  it('minisign needs an explicit key; with one it is verified', async () => {
    const m = makeMinisign();
    const artifact = 'binary-content-of-app';
    const spec = releaseSpec({
      assets: { 'app.zip': artifact, 'app.zip.minisig': m.sign(Buffer.from(artifact)) },
    });
    const without = await run(spec);
    expect(sigOf(without, 'app.zip')).toMatchObject({
      kind: 'minisign',
      state: 'present_unverified',
    });
    const withKey = await run(spec, { trust: { keys: [minisignKey(m.pub)] } });
    expect(sigOf(withKey, 'app.zip')).toMatchObject({
      state: 'verified',
      trust_root: 'user_supplied_minisign_key',
      basis: 'local_crypto_verified',
    });
  });

  it('a signed git tag with no trusted key keeps GitHub as the only voice: present, GitHub-asserted, not locally verified', async () => {
    const payload = 'object ' + COMMIT + '\ntype commit\ntag v1.0.0\n\nrelease\n';
    const signature = await gpgSign(A, Buffer.from(payload));
    const spec = releaseSpec({
      assets: { 'a.txt': 'x' },
      annotated: true,
      verification: { verified: true, reason: 'valid', signature, payload },
    });
    const r = await run(spec);
    const s = sigOf(r, 'tag');
    expect(s).toMatchObject({
      state: 'verified',
      trust_root: 'github_api_assertion',
      verified_by: 'github',
      local_state: 'verification_unavailable',
      basis: 'github_api_verified',
    });
    expect(s?.local_detail?.detail).toMatch(/no trusted GPG key/);
  });

  it('with a trusted key the tag signature is verified locally, beside GitHub, and the armored signature is not stored', async () => {
    const payload = 'object ' + COMMIT + '\ntype commit\ntag v1.0.0\n\nrelease\n';
    const signature = await gpgSign(A, Buffer.from(payload));
    const spec = releaseSpec({
      assets: { 'a.txt': 'x' },
      annotated: true,
      verification: { verified: true, reason: 'valid', signature, payload },
    });
    const r = await run(spec, { trust: { keys: [gpgKey(A.publicKey)] } });
    const s = sigOf(r, 'tag');
    expect(s).toMatchObject({
      local_state: 'verified',
      basis: 'local_crypto_verified',
      trust_root: 'github_api_assertion',
    });
    expect(s?.local_detail).toMatchObject({
      trust_root: 'user_supplied_gpg_key',
      engine: 'openpgp',
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain('BEGIN PGP');
    expect(json).not.toContain(A.fingerprint.slice(0, 20));
  });

  it('a tag whose payload was altered is invalid locally even when GitHub says verified', async () => {
    const payload = 'object ' + COMMIT + '\ntype commit\ntag v1.0.0\n\nrelease\n';
    const signature = await gpgSign(A, Buffer.from(payload));
    const spec = releaseSpec({
      assets: { 'a.txt': 'x' },
      annotated: true,
      verification: { verified: true, reason: 'valid', signature, payload: payload + 'extra' },
    });
    const r = await run(spec, { trust: { keys: [gpgKey(A.publicKey)] } });
    const s = sigOf(r, 'tag');
    expect(s?.state).toBe('verified'); // GitHub's word
    expect(s?.local_state).toBe('invalid'); // ours
    expect(s?.basis).toBe('github_api_verified');
  });

  it('keys, private or public, never appear in reports', async () => {
    const spec = releaseSpec({ assets: { 'a.txt': 'x' } });
    const r = await run(spec, {
      trust: { keys: [gpgKey(A.publicKey), minisignKey(makeMinisign().pub)] },
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain('PGP PUBLIC KEY');
    expect(json).not.toContain('PGP PRIVATE KEY');
    expect(r.methodology.config_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
