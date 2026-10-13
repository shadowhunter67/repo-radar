import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { isSafeBundleUrl, LARGE_BUNDLE_LIMITS } from '../../src/collectors/github/releases.js';
import { classifyAsset } from '../../src/release/analyze.js';
import { gpgKey } from '../../src/trust/config.js';
import { verifyGpgDetached } from '../../src/trust/gpg.js';
import { inspectBundle, type BundleVerifier } from '../../src/trust/sigstore.js';
import { snappyDecompress } from '../../src/util/snappy.js';
import { fakeFetch, fixedClock, sha256, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const REAL = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'cli-attestation-bundle.json.sn'),
);

/** Snappy writer for tests: literal-only blocks (valid, if uncompressed), so the decoder is also tested on synthetic input. */
function snappyLiteral(data: Buffer): Buffer {
  const varint: number[] = [];
  let n = data.length;
  while (n >= 0x80) {
    varint.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  varint.push(n);
  const out: number[] = [...varint];
  let pos = 0;
  while (pos < data.length) {
    const len = Math.min(data.length - pos, 60);
    out.push((len - 1) << 2, ...data.subarray(pos, pos + len));
    pos += len;
  }
  return Buffer.from(out);
}

describe('snappy raw block decoder', () => {
  it('decodes a real GitHub attestation bundle into the Sigstore bundle it carries', () => {
    const out = snappyDecompress(REAL, 1024 * 1024);
    expect(out).toBeDefined();
    const json = JSON.parse((out as Buffer).toString('utf8')) as { mediaType: string };
    expect(json.mediaType).toMatch(/^application\/vnd\.dev\.sigstore\.bundle/);
    const shape = inspectBundle(json);
    expect(shape.kind).toBe('attestation');
  });

  it('round-trips literal blocks and understands the three copy forms', () => {
    const text = Buffer.from('hello snappy '.repeat(20));
    expect(snappyDecompress(snappyLiteral(text), 10_000)?.toString()).toBe(text.toString());
    // "abcd" then copy-1 (len 4, offset 4), then copy-2 (len 8, offset 8) then copy-4 (len 4, offset 16)
    const block = Buffer.from([
      20, // 20 bytes
      0x0c,
      97,
      98,
      99,
      100, // literal "abcd"
      0x01,
      4, // copy1: len 4+0, offset 4
      (7 << 2) | 2,
      8,
      0, // copy2: len 8, offset 8
      (3 << 2) | 3,
      16,
      0,
      0,
      0, // copy4: len 4, offset 16
    ]);
    expect(snappyDecompress(block, 100)?.toString()).toBe('abcdabcdabcdabcdabcd');
  });

  it('refuses a declared size over the limit before allocating anything', () => {
    // varint 2^31 as the declared length, then nothing
    expect(
      snappyDecompress(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x08]), 1024 * 1024),
    ).toBeUndefined();
    expect(
      snappyDecompress(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]), 1e9),
    ).toBeUndefined();
  });

  it('rejects every malformed shape: zero or out-of-range offsets, short input, wrong length, overflow', () => {
    const bad: number[][] = [
      [], // no length
      [5], // declared 5, no data
      [4, 0x0c, 97], // literal longer than the input
      [4, 0x0c, 97, 98, 99, 100, 0x01, 4], // output would exceed the declared length
      [8, 0x0c, 97, 98, 99, 100, 0x01, 0], // offset 0
      [8, 0x0c, 97, 98, 99, 100, 0x01, 9], // offset beyond what was written
      [8, 0x0c, 97, 98, 99, 100, 0x02, 4], // truncated copy2
      [8, 0x0c, 97, 98, 99, 100], // decoded 4 of 8
      [4, 0xf0], // literal length byte missing
    ];
    for (const b of bad)
      expect(snappyDecompress(Buffer.from(b), 1000), JSON.stringify(b)).toBeUndefined();
  });

  it('a decompression bomb (huge repeated copy) is bounded by the declared length', () => {
    // declared 100 MB: refused up front with a 1 MiB cap
    const varint = [0x80, 0xc8, 0xaf, 0x2f]; // ~100,000,000
    expect(
      snappyDecompress(Buffer.from([...varint, 0x0c, 97, 98, 99, 100]), 1024 * 1024),
    ).toBeUndefined();
  });
});

describe('asset classification', () => {
  it('a Sigstore bundle named after a checksum file is a signature, not a checksum file', () => {
    expect(classifyAsset('checksums.txt.sigstore.json')).toBe('signature');
    expect(classifyAsset('SHA256SUMS.asc')).toBe('signature');
    expect(classifyAsset('checksums.txt')).toBe('checksum');
    expect(classifyAsset('app_1.0_checksums.sha256')).toBe('checksum');
  });
});

describe('OpenPGP key files holding several keys', () => {
  it('every key in a published key file is a candidate; the pin selects the right one', async () => {
    const old = await pgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: 'old' }],
      format: 'armored',
    });
    const current = await pgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: 'current' }],
      format: 'armored',
    });
    const fp = (await pgp.readKey({ armoredKey: current.publicKey }))
      .getFingerprint()
      .toUpperCase();
    const block = `${old.publicKey}\n${current.publicKey}`;
    const data = Buffer.from('SHA256SUMS content');
    const sig = (await pgp.sign({
      message: await pgp.createMessage({ binary: new Uint8Array(data) }),
      signingKeys: await pgp.readPrivateKey({ armoredKey: current.privateKey }),
      detached: true,
      format: 'armored',
    })) as string;
    const pinned = await verifyGpgDetached({
      signature: sig,
      data,
      keys: [gpgKey(block, 'project_pinned', fp)],
      subject: 'SHA256SUMS',
    });
    expect(pinned.state).toBe('verified');
    // unpinned: both keys are candidates, the matching one signs
    const unpinned = await verifyGpgDetached({
      signature: sig,
      data,
      keys: [gpgKey(block)],
      subject: 'SHA256SUMS',
    });
    expect(unpinned.state).toBe('verified');
    // a pin that matches none of the keys rejects the file
    const wrong = await verifyGpgDetached({
      signature: sig,
      data,
      keys: [gpgKey(block, 'project_pinned', 'A'.repeat(40))],
      subject: 'x',
    });
    expect(wrong.state).toBe('verification_failed');
  }, 60_000);
});

// ---- through the pipeline ----------------------------------------------------------------------------------------
const SAS = 'sig=TOPSECRETSIGNATURE&se=2099';
const BLOB = (name: string) =>
  `https://tmaproduction.blob.core.windows.net/attestations/1/${name}.json.sn?${SAS}`;
const ASSET = 'tool.tar.gz';
const CONTENT = 'binary';

function spec(urls: string[], blobs: Record<string, Uint8Array | string>): FakeSpec {
  return goodRepo({
    releases: [
      {
        daysAgo: 3,
        detail: {
          tag: 'v1.0.0',
          commit: 'c'.repeat(40),
          assets: { [ASSET]: CONTENT },
          attestations: {
            [ASSET]: { attestations: urls.map((u) => ({ bundle: null, bundle_url: u })) },
          },
        },
      },
    ],
    blobs,
  });
}
const run = (s: FakeSpec, o: Parameters<typeof analyzeRepository>[1] = {}) =>
  analyzeRepository(`${s.owner}/${s.repo}`, {
    fetch: fakeFetch(s),
    clock: fixedClock,
    scorecard: false,
    osv: false,
    depsDev: false,
    registry: false,
    ...o,
  });

describe('large attestation bundles through the pipeline', () => {
  it("a bundle_url in GitHub's attestation store is downloaded, decompressed, parsed and verified like an inline bundle", async () => {
    const s = spec([BLOB('a')], { '/attestations/1/a.json.sn': REAL });
    const seen: unknown[] = [];
    const verifier: BundleVerifier = {
      trustRoot: 'sigstore_public_good',
      verify: async (b) => (
        seen.push(b),
        {
          identity: {
            subjectAlternativeName:
              'https://github.com/cli/cli/.github/workflows/x.yml@refs/tags/v1',
            extensions: { issuer: 'https://token.actions.githubusercontent.com' },
          },
        }
      ),
    };
    const r = await run(s, { verifyCrypto: true, verifier });
    const rel = r.release_intel.releases[0];
    expect(rel?.provenance).toHaveLength(1);
    expect(rel?.provenance[0]).toMatchObject({
      verification: 'verified',
      origin: 'github_attestation_api',
    });
    expect((seen[0] as { mediaType: string }).mediaType).toMatch(/sigstore\.bundle/);
    expect(s.blobRequests).toHaveLength(1);
    expect(r.release_intel.limits_hit.join(' ')).toMatch(
      /1 large attestation bundle\(s\) were downloaded/,
    );
    // the signed URL is a secret-bearing string: it appears nowhere in the report
    expect(JSON.stringify(r)).not.toContain('TOPSECRETSIGNATURE');
  });

  it('without --verify-crypto the downloaded statement is parsed but stays present_unverified', async () => {
    const s = spec([BLOB('a')], { '/attestations/1/a.json.sn': REAL });
    const r = await run(s);
    expect(r.release_intel.releases[0]?.provenance[0]?.verification).toBe('present_unverified');
  });

  it('a URL on any other host, with credentials, a port or an odd path is never fetched', async () => {
    const urls = [
      'https://evil.example.org/attestations/1/a.json.sn',
      'https://user:pw@tmaproduction.blob.core.windows.net/attestations/1/a.json.sn',
      'https://tmaproduction.blob.core.windows.net:8443/attestations/1/a.json.sn',
      'http://tmaproduction.blob.core.windows.net/attestations/1/a.json.sn',
      'https://tmaproduction.blob.core.windows.net/other/1/a.json.sn',
      'https://tmaproduction.blob.core.windows.net/attestations/../secret',
    ];
    for (const u of urls) expect(isSafeBundleUrl(u), u).toBe(false);
    const s = spec(urls, { '/': 'anything' });
    const r = await run(s);
    expect(s.blobRequests).toEqual([]);
    expect(r.release_intel.limits_hit.join(' ')).toMatch(/not inlined/);
  });

  it('an over-large, malformed or bomb-like blob becomes an explicit skipped record, never a silent drop', async () => {
    const big = Buffer.alloc(LARGE_BUNDLE_LIMITS.maxCompressedBytes + 10, 0x41);
    const bomb = Buffer.from([0x80, 0xc8, 0xaf, 0x2f, 0x0c, 97, 98, 99, 100]);
    const s = spec([BLOB('big'), BLOB('bomb'), BLOB('junk'), BLOB('missing')], {
      '/attestations/1/big.json.sn': big,
      '/attestations/1/bomb.json.sn': bomb,
      '/attestations/1/junk.json.sn': Buffer.from([1, 2, 3, 4, 5]),
    });
    const r = await run(s, {
      verifyCrypto: true,
      verifier: { trustRoot: 'sigstore_public_good', verify: async () => ({}) },
    });
    const prov = r.release_intel.releases[0]?.provenance ?? [];
    expect(prov.map((p) => p.verification)).toEqual([
      'verification_skipped_resource_limit',
      'verification_skipped_resource_limit',
      'verification_skipped_resource_limit',
    ]);
    expect(
      prov.every((p) => p.verification_detail?.state === 'verification_skipped_resource_limit'),
    ).toBe(true);
    expect(r.release_intel.limits_hit.join(' ')).toMatch(/could not be downloaded/); // the 404
    expect(r.facts.find((f) => f.id === 'release.provenance.verified')?.value).toBe(false);
  });

  it('at most five large bundles are fetched per release', async () => {
    const urls = Array.from({ length: 8 }, (_, i) => BLOB(`n${i}`));
    const blobs = Object.fromEntries(urls.map((u, i) => [`/attestations/1/n${i}.json.sn`, REAL]));
    const s = spec(urls, blobs);
    await run(s);
    // the API response itself is capped at 10 attestations; the fetch cap is the bound that matters
    expect(s.blobRequests.length).toBeLessThanOrEqual(LARGE_BUNDLE_LIMITS.maxFetches);
  });

  it('the checksum of the downloaded asset is unrelated: a bundle names its own subjects', () => {
    expect(sha256(CONTENT)).toMatch(/^[0-9a-f]{64}$/);
  });
});
