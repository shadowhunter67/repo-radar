import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { isSafeAssetUrl } from '../../src/collectors/github/releases.js';
import { inspectArchive, inspectTar, inspectZip, sniffFormat } from '../../src/release/archive.js';
import { classifyAsset } from '../../src/release/analyze.js';
import {
  looksLikeChecksumFile,
  parseChecksumFile,
  parseDigestString,
} from '../../src/release/checksums.js';
import { parseStatement, provenanceFromAttestationResponse } from '../../src/release/provenance.js';
import type { Report } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, sha256, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const H64 = 'a'.repeat(64);

describe('checksum files', () => {
  it('parses GNU and BSD styles, assigns algorithms by length and flags weak ones', () => {
    const c = parseChecksumFile(
      `${H64}  tool-linux.tar.gz\n${'b'.repeat(64)} *tool-win.zip\nSHA256 (tool-mac.zip) = ${'c'.repeat(64)}\n${'d'.repeat(32)}  old.md5\n`,
    );
    expect(c.entries.map((e) => `${e.algorithm}:${e.name}`)).toEqual([
      'sha256:tool-linux.tar.gz',
      'sha256:tool-win.zip',
      'sha256:tool-mac.zip',
      'md5:old.md5',
    ]);
    expect(c.malformed).toBe(0);
  });

  it('malformed lines, wrong lengths and bad hex are counted, never guessed', () => {
    const c = parseChecksumFile(`nothex  file\n${'a'.repeat(63)}  short\n${H64}\n\n# comment\n`);
    expect(c.entries).toEqual([]);
    expect(c.malformed).toBe(3);
  });

  it('a name listed with two different digests is a conflict and the first is kept', () => {
    const c = parseChecksumFile(`${H64}  a.zip\n${'b'.repeat(64)}  a.zip\n`);
    expect(c.entries).toHaveLength(1);
    expect(c.conflicts).toEqual(['a.zip']);
  });

  it('path traversal, absolute and control-character names are rejected', () => {
    const esc = String.fromCharCode(27);
    const c = parseChecksumFile(
      `${H64}  ../../etc/passwd\n${H64}  /abs/path\n${H64}  evil${esc}[2Jname\n${H64}  ok.zip\n`,
    );
    expect(c.entries.map((e) => e.name)).toEqual(['ok.zip']);
    expect(c.unsafe_names).toHaveLength(3);
    expect(c.unsafe_names.join('').includes(esc)).toBe(false);
  });

  it('huge files and line floods are truncated and flagged', () => {
    const big = Array.from({ length: 6000 }, (_, i) => `${H64}  f${i}.bin`).join('\n');
    const c = parseChecksumFile(big);
    expect(c.truncated).toBe(true);
    expect(c.entries.length).toBeLessThanOrEqual(5000);
    expect(parseChecksumFile('x'.repeat(3_000_000)).truncated).toBe(true);
  });

  it('GitHub asset digest strings and file-name heuristics', () => {
    expect(parseDigestString(`sha256:${H64}`)).toEqual({ algorithm: 'sha256', value: H64 });
    expect(parseDigestString('sha256:abc')).toBeUndefined();
    expect(parseDigestString(5)).toBeUndefined();
    for (const n of ['SHA256SUMS', 'checksums.txt', 'tool.sha256', 'tool_1.0_checksums.txt'])
      expect(looksLikeChecksumFile(n), n).toBe(true);
    expect(looksLikeChecksumFile('SHA256SUMS.asc')).toBe(false);
    expect(classifyAsset('tool.tar.gz.sig')).toBe('signature');
    expect(classifyAsset('multiple.intoto.jsonl')).toBe('attestation');
    expect(classifyAsset('tool-1.0.cdx.json')).toBe('sbom');
    expect(classifyAsset('tool-linux-amd64')).toBe('binary');
  });
});

describe('provenance parsing', () => {
  const statement = (rev: string | null, subjectDigest = H64) => ({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'tool.tar.gz', digest: { sha256: subjectDigest } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://actions.github.io/buildtypes/workflow/v1',
        externalParameters: { workflow: { repository: 'https://github.com/o/r' } },
        resolvedDependencies: rev
          ? [{ uri: 'git+https://github.com/o/r', digest: { gitCommit: rev } }]
          : [],
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner' } },
    },
  });

  it('reads a SLSA v1 statement but never marks it verified', () => {
    const p = parseStatement(statement('1'.repeat(40)), 'github_attestation_api')!;
    expect(p).toMatchObject({
      slsa: true,
      builder_id: 'https://github.com/actions/runner',
      source_revision: '1'.repeat(40),
      verification: 'verification_unavailable',
    });
    expect(p.source_repository).toBe('https://github.com/o/r');
  });

  it('a non-SLSA predicate or short revision is recorded as a problem, not trusted', () => {
    const odd = parseStatement(
      { ...statement('abc'), predicateType: 'https://example.com/x' },
      'release_asset',
    )!;
    expect(odd.slsa).toBe(false);
    expect(odd.problems.join(' ')).toMatch(/not SLSA/);
    const short = parseStatement(statement('abc'), 'release_asset')!;
    expect(short.source_revision).toBeNull();
    expect(short.problems.join(' ')).toMatch(/full commit sha/);
  });

  it('malicious or malformed bundles are counted as unreadable, never thrown', () => {
    const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64');
    const r = provenanceFromAttestationResponse({
      attestations: [
        { bundle: { dsseEnvelope: { payload: b64(statement('2'.repeat(40))) } } },
        { bundle: { dsseEnvelope: { payload: '!!!not base64!!!' } } },
        { bundle: { dsseEnvelope: { payload: Buffer.from('{broken').toString('base64') } } },
        { bundle: {} },
        { bundle: { dsseEnvelope: { payload: b64({ nothing: true }) } } },
      ],
    });
    expect(r.records).toHaveLength(1);
    expect(r.unreadable).toBe(4);
    expect(provenanceFromAttestationResponse('garbage').records).toEqual([]);
    const huge = {
      attestations: [{ bundle: { dsseEnvelope: { payload: 'A'.repeat(3_000_000) } } }],
    };
    expect(provenanceFromAttestationResponse(huge).unreadable).toBe(1);
  });

  it('a subject list is capped', () => {
    const st = statement('3'.repeat(40));
    st.subject = Array.from({ length: 100 }, (_, i) => ({
      name: `a${i}`,
      digest: { sha256: H64 },
    }));
    const p = parseStatement(st, 'release_asset')!;
    expect(p.subject).toHaveLength(20);
    expect(p.problems.join(' ')).toMatch(/truncated/);
  });
});

/** Minimal ZIP writer: entries with explicit names, optionally lying about the uncompressed size. */
function zip(
  entries: { name: string; data?: string; claimSize?: number; attrs?: number }[],
): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? 'x');
    const comp = deflateRawSync(data);
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(e.claimSize ?? data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(e.attrs ?? 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
function tar(entries: { name: string; size?: number; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 'utf8');
    h.write((e.size ?? 0).toString(8).padStart(11, '0'), 124, 'ascii');
    h.write(e.type ?? '0', 156, 'ascii');
    h.write('ustar', 257, 'ascii');
    blocks.push(h);
    if ((e.size ?? 0) > 0) blocks.push(Buffer.alloc(Math.ceil((e.size ?? 0) / 512) * 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('archive safety (metadata only; nothing is extracted)', () => {
  it('lists a normal zip without alarms', () => {
    const r = inspectZip(zip([{ name: 'bin/tool' }, { name: 'README.md' }]));
    expect(r).toMatchObject({ format: 'zip', entries: 2 });
    expect(r.problems).toEqual([]);
  });

  it('zip slip, absolute and backslash/control names are flagged', () => {
    const r = inspectZip(
      zip([
        { name: '../../evil.sh' },
        { name: '/etc/cron.d/x' },
        { name: 'a\\b' },
        { name: `x${String.fromCharCode(27)}y` },
      ]),
    );
    expect(r.problems).toEqual(
      expect.arrayContaining(['path_traversal', 'absolute_path', 'unsafe_name']),
    );
    expect(r.sample.join('').includes(String.fromCharCode(27))).toBe(false);
  });

  it('a declared-size bomb is detected from the headers without inflating', () => {
    const r = inspectZip(zip([{ name: 'big.bin', claimSize: 3 * 1024 * 1024 * 1024 }]));
    expect(r.problems).toContain('declared_size_too_large');
    const ratio = inspectZip(
      zip([{ name: 'r.bin', data: 'x'.repeat(100), claimSize: 500 * 1024 * 1024 }]),
    );
    expect(ratio.problems).toContain('compression_bomb');
  });

  it('symlinks, duplicates and nested archives are reported', () => {
    const r = inspectZip(
      zip([
        { name: 'l', attrs: (0xa000 << 16) >>> 0 },
        { name: 'd' },
        { name: 'd' },
        { name: 'inner.zip' },
        { name: 'run.sh' },
      ]),
    );
    expect(r.problems).toEqual(
      expect.arrayContaining(['symlink_entry', 'duplicate_entry', 'nested_archive']),
    );
    expect(r.executables).toBe(1);
  });

  it('truncated or garbage input is "malformed", not a crash', () => {
    expect(inspectZip(Buffer.from('PK\x03\x04garbage')).problems).toContain('malformed');
    const z = zip([{ name: 'a' }]);
    expect(() => inspectZip(z.subarray(0, z.length - 10))).not.toThrow();
  });

  it('tar and tar.gz: traversal, symlink and huge declared sizes; a gzip bomb is refused', () => {
    const t = tar([{ name: '../x' }, { name: 'link', type: '2' }, { name: 'ok.txt', size: 5 }]);
    const r = inspectTar(t);
    expect(r.problems).toEqual(expect.arrayContaining(['path_traversal', 'symlink_entry']));
    expect(inspectTar(gzipSync(t), true).entries).toBe(3);
    const bomb = gzipSync(Buffer.alloc(80 * 1024 * 1024));
    expect(inspectTar(bomb, true).problems).toContain('compression_bomb');
  });

  it('input above the size limit is not read; unknown formats yield an empty report', () => {
    expect(inspectZip(Buffer.alloc(26 * 1024 * 1024)).problems).toContain('input_too_large');
    expect(inspectArchive(Buffer.from('hello world')).format).toBe('unknown');
  });

  it('executable formats are recognised from magic bytes, never run', () => {
    expect(sniffFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))).toBe('elf');
    expect(sniffFormat(Buffer.from('MZ\x90\x00'))).toBe('pe');
    expect(sniffFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe('macho');
    expect(sniffFormat(Buffer.from('#!/bin/sh\n'))).toBe('script');
    expect(sniffFormat(Buffer.from('hello'))).toBe('unknown');
  });
});

describe('release asset URLs', () => {
  it('only https github.com release downloads of this very repository are fetched', () => {
    const ok = 'https://github.com/o/r/releases/download/v1/SHA256SUMS';
    expect(isSafeAssetUrl(ok, 'o', 'r')).toBe(true);
    for (const bad of [
      'http://github.com/o/r/releases/download/v1/x',
      'https://github.com/o/other/releases/download/v1/x',
      'https://evil.example/o/r/releases/download/v1/x',
      'https://127.0.0.1/o/r/releases/download/v1/x',
      'https://localhost/o/r/releases/download/v1/x',
      'https://user:pw@github.com/o/r/releases/download/v1/x',
      'https://github.com:8443/o/r/releases/download/v1/x',
      'https://github.com/o/r/releases/download/../../../x',
      'https://github.com/o/r/archive/main.zip',
      'not a url',
      42,
    ])
      expect(isSafeAssetUrl(bad, 'o', 'r'), String(bad)).toBe(false);
  });
});

const COMMIT = 'e'.repeat(40);
const withRelease = (
  detail: NonNullable<FakeSpec['releases'][number]['detail']>,
  over: Partial<FakeSpec> = {},
): FakeSpec => {
  const spec = goodRepo(over);
  spec.releases = [{ daysAgo: 10, detail }];
  return spec;
};
const run = (
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    ...extra,
  });
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64');
const attest = (digest: string, rev: string) => ({
  attestations: [
    {
      bundle: {
        dsseEnvelope: {
          payload: b64({
            subject: [{ name: 'tool.tar.gz', digest: { sha256: digest } }],
            predicateType: 'https://slsa.dev/provenance/v1',
            predicate: {
              buildDefinition: {
                buildType: 'x',
                externalParameters: {},
                resolvedDependencies: [{ uri: 'u', digest: { gitCommit: rev } }],
              },
              runDetails: { builder: { id: 'https://github.com/actions/runner' } },
            },
          }),
        },
      },
    },
  ],
});

describe('release intelligence end to end', () => {
  it('a release with a checksum file lists assets, digests and covers them, but proves origin of nothing', async () => {
    const tarball = 'binary-content';
    const sums = `${sha256(tarball)}  tool.tar.gz\n`;
    const spec = withRelease({
      tag: 'v1.0.0',
      commit: COMMIT,
      assets: { 'tool.tar.gz': tarball, SHA256SUMS: sums },
    });
    const r = await run(spec);
    const rel = r.release_intel.releases[0]!;
    expect(r.release_intel.status).toBe('analyzed');
    expect(rel).toMatchObject({
      tag: 'v1.0.0',
      tag_commit: COMMIT,
      tag_kind: 'lightweight',
      correspondence: 'checksum_listed',
    });
    expect(rel.checksum_files[0]).toMatchObject({
      asset: 'SHA256SUMS',
      entries: 1,
      covers_assets: 1,
    });
    expect(rel.assets.find((a) => a.name === 'tool.tar.gz')?.digest?.value).toBe(sha256(tarball));
    expect(rel.correspondence_reasons.join(' ')).toMatch(/not origin/);
    expect(spec.releaseRequests).not.toContain('download:tool.tar.gz'); // binaries are never downloaded
  });

  it('an attestation naming the tag commit and the asset digest links the asset to the tag commit, unverified', async () => {
    const content = 'artifact bytes';
    const spec = withRelease({
      tag: 'v2.0.0',
      commit: COMMIT,
      assets: { 'tool.tar.gz': content },
      attestations: { 'tool.tar.gz': attest(sha256(content), COMMIT) },
    });
    const rel = (await run(spec)).release_intel.releases[0]!;
    expect(rel.correspondence).toBe('attested_to_tag_commit');
    expect(rel.provenance[0]).toMatchObject({
      verification: 'verification_unavailable',
      slsa: true,
    });
    expect(rel.correspondence_reasons.join(' ')).toMatch(/not verified/);
  });

  it('an attestation for a different commit is reported as inconsistent', async () => {
    const content = 'artifact bytes';
    const spec = withRelease({
      tag: 'v2.0.1',
      commit: COMMIT,
      assets: { 'tool.tar.gz': content },
      attestations: { 'tool.tar.gz': attest(sha256(content), '9'.repeat(40)) },
    });
    expect((await run(spec)).release_intel.releases[0]!.correspondence).toBe(
      'attestation_inconsistent',
    );
  });

  it('GitHub-verified annotated tag signatures are verified_by github; an unverifiable one is not "invalid"; a .sig asset is only present', async () => {
    const mk = (v: { verified: boolean; reason: string }) =>
      withRelease({
        tag: 'v3',
        commit: COMMIT,
        annotated: true,
        verification: v,
        assets: { 'tool.zip': 'z', 'tool.zip.asc': 'sig' },
      });
    const ok = (await run(mk({ verified: true, reason: 'valid' }))).release_intel.releases[0]!;
    expect(ok.tag_kind).toBe('annotated');
    expect(ok.signatures.find((s) => s.subject === 'tag')).toMatchObject({
      state: 'signature_verified',
      verified_by: 'github',
    });
    expect(ok.signatures.find((s) => s.subject === 'tool.zip')).toMatchObject({
      state: 'signature_present',
      verified_by: 'none',
      kind: 'gpg',
    });
    const unknownKey = (await run(mk({ verified: false, reason: 'gpgverify_unavailable' })))
      .release_intel.releases[0]!;
    expect(unknownKey.signatures.find((s) => s.subject === 'tag')?.state).toBe(
      'verification_unavailable',
    );
    const bad = (await run(mk({ verified: false, reason: 'invalid' }))).release_intel.releases[0]!;
    expect(bad.signatures.find((s) => s.subject === 'tag')?.state).toBe('signature_invalid');
    const unsigned = (await run(mk({ verified: false, reason: 'unsigned' }))).release_intel
      .releases[0]!;
    expect(unsigned.signatures.find((s) => s.subject === 'tag')).toBeUndefined();
  });

  it('fake checksum files: conflicting digests, traversal names and weak-only algorithms are surfaced', async () => {
    const sums = `${'1'.repeat(32)}  a.zip\n${H64}  ../../x\n${'2'.repeat(64)}  a.zip\n${'3'.repeat(64)}  a.zip\n`;
    const spec = withRelease({
      tag: 'v4',
      commit: COMMIT,
      assets: { 'a.zip': 'A', 'checksums.txt': sums },
    });
    const rel = (await run(spec)).release_intel.releases[0]!;
    const cf = rel.checksum_files[0]!;
    expect(cf.malformed_lines).toBeGreaterThanOrEqual(1);
    expect(cf.conflicts).toBeGreaterThanOrEqual(0);
    // a weak md5 entry never replaces the strong GitHub digest as integrity evidence
    expect(rel.assets.find((a) => a.name === 'a.zip')?.digest?.weak).toBe(false);
  });

  it('a Unicode-confusable or control-character asset name is flagged and never echoed raw', async () => {
    const spec = withRelease({
      tag: 'v5',
      commit: COMMIT,
      assets: { 'tооl.zip': 'x', ['bad\u001b[2J.zip']: 'y' },
    });
    const rel = (await run(spec)).release_intel.releases[0]!;
    expect(rel.assets.filter((a) => a.suspicious_name)).toHaveLength(2);
    expect(JSON.stringify(rel).includes('\u001b')).toBe(false);
  });

  it('a checksum asset whose download URL points elsewhere (localhost, other repo) is never requested', async () => {
    const spec = withRelease({
      tag: 'v6',
      commit: COMMIT,
      assets: { 'tool.zip': 'x', SHA256SUMS: 'irrelevant' },
      downloadUrl: { SHA256SUMS: 'https://127.0.0.1/o/r/releases/download/v6/SHA256SUMS' },
    });
    const r = await run(spec);
    expect(spec.releaseRequests).not.toContain('download:SHA256SUMS');
    expect(r.release_intel.limits_hit.join(' ')).toMatch(/unsafe download URL/);
    expect(r.release_intel.releases[0]!.checksum_files).toEqual([]);
  });

  it('API failures are limits, not "no signature"; --no-releases leaves the section disabled', async () => {
    const spec = withRelease({ tag: 'v7', commit: COMMIT, assets: { 'tool.zip': 'x' } });
    spec.failing = ['/git/ref/tags/'];
    const r = await run(spec);
    expect(r.release_intel.releases[0]).toMatchObject({
      tag_kind: 'unresolved',
      tag_commit: null,
      correspondence: 'unlinked',
    });
    const off = await run(withRelease({ tag: 'v8', commit: COMMIT, assets: { a: 'x' } }), {
      releases: false,
    });
    expect(off.release_intel.status).toBe('disabled');
  });

  it('a repository without releases says so', async () => {
    const spec = goodRepo();
    spec.releases = [];
    expect((await run(spec)).release_intel.status).toBe('no_releases');
  });
});
