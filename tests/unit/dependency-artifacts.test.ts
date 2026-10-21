import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/util/http.js';
import { BoundedBinaryReader, inspectArtifact } from '../../src/registry/artifacts/inspect.js';
import { extractStaticFacts } from '../../src/registry/artifacts/static.js';
import {
  inspectDownloadedArtifacts,
  safeArtifactUrl,
} from '../../src/registry/artifacts/download.js';

const root = join(process.cwd(), 'tests/fixtures/artifacts');
const bytes = (name: string): Uint8Array => readFileSync(join(root, name));
const digest = (name: string): string =>
  readFileSync(join(root, name), 'utf8').trim().split(/\s+/)[0]!;

describe('dependency artifacts: pinned fixtures', () => {
  it('extracts executable entries, native magic and artifact-owned repository host', () => {
    const facts = extractStaticFacts(
      {
        state: 'verified',
        format: 'tar',
        entries: [
          {
            path: 'package/package.json',
            kind: 'file',
            size: 80,
            unsafe: false,
            duplicate: false,
            content: new TextEncoder().encode(
              '{"version":"1.0.0","bin":{"tool":"cli.js"},"repository":"https://github.com/acme/tool"}',
            ),
          },
          {
            path: 'package/native.node',
            kind: 'file',
            size: 4,
            unsafe: false,
            duplicate: false,
            content: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
          },
        ],
        totalSize: 84,
        limitsHit: [],
        diagnostics: [],
      },
      { name: 'tool', version: '1.0.0' },
    );
    expect(facts.executable_entry_present).toBe(true);
    expect(facts.native_binary_present).toBe(true);
    expect(facts.repository_host).toBe('github.com');
  });
  it('bounds and validates PAX path/linkpath/size records', () => {
    const block = (name: string, body: Uint8Array, type = '0'): Uint8Array => {
      const h = new Uint8Array(512);
      h.set(new TextEncoder().encode(name).slice(0, 100), 0);
      h.set(new TextEncoder().encode(body.length.toString(8).padStart(11, '0') + '\0'), 124);
      h[156] = type.charCodeAt(0);
      return new Uint8Array([...h, ...body, ...new Uint8Array((512 - (body.length % 512)) % 512)]);
    };
    const paxRecord = (key: string, value: string): Uint8Array => {
      let length = key.length + value.length + 3;
      while (String(length).length + key.length + value.length + 3 !== length) length++;
      return new TextEncoder().encode(`${length} ${key}=${value}\n`);
    };
    const pax = new Uint8Array([
      ...paxRecord('path', '../escape'),
      ...paxRecord('path', '../escape'),
    ]);
    const raw = new Uint8Array([
      ...block('PaxHeader', pax, 'x'),
      ...block('target', new Uint8Array([1])),
    ]);
    const result = inspectArtifact(gzipSync(raw));
    expect(result.entries[0]?.unsafe).toBe(true);
    expect(result.diagnostics).toContain('duplicate_pax_key');
    const invalid = new Uint8Array([
      ...block('PaxHeader', new Uint8Array([5, 32, 112, 97, 116, 104, 61, 255]), 'x'),
      ...block('target', new Uint8Array()),
    ]);
    expect(inspectArtifact(gzipSync(invalid)).diagnostics).toContain('invalid_utf8');
  });
  it('bounds binary reads and reports ZIP64 without interpreting wrapped fields', () => {
    const reader = new BoundedBinaryReader(new Uint8Array([1, 2, 3, 4]));
    expect(reader.readUInt32LE(0)).toBe(0x04030201);
    expect(reader.readUInt32BE(0)).toBe(0x01020304);
    expect(reader.readUInt32LE(1)).toBeUndefined();
    const zip = new Uint8Array(22);
    zip.set([0x50, 0x4b, 5, 6], 0);
    zip[10] = 0xff;
    zip[11] = 0xff;
    expect(inspectArtifact(zip).diagnostics).toContain('zip64_unsupported');
  });
  it('extracts the exact esbuild lifecycle script', () => {
    const i = inspectArtifact(bytes('npm-esbuild-0.28.2.tgz'));
    const f = extractStaticFacts(i, { name: 'esbuild', version: '0.28.2', hasInstallScript: true });
    expect(f.hooks).toEqual([{ name: 'postinstall', text: 'node install.js' }]);
    expect(i.entries.some((e) => e.path === 'package/install.js')).toBe(true);
  });
  it('finds core-js postinstall and domains, while colors and sigstore have no hooks', () => {
    const core = extractStaticFacts(inspectArtifact(bytes('npm-core-js-3.37.0.tgz')), {
      name: 'core-js',
      version: '3.37.0',
      hasInstallScript: true,
    });
    expect(core.hooks).toEqual([
      { name: 'postinstall', text: 'node -e "try{require(\'./postinstall\')}catch(e){}"' },
    ]);
    expect(core.domains).toContain('opencollective.com');
    for (const n of ['npm-colors-1.4.0.tgz', 'npm-sigstore-3.1.0.tgz'])
      expect(
        extractStaticFacts(inspectArtifact(bytes(n)), { name: n, version: '1.0.0' }).hooks,
      ).toEqual([]);
  });
  it('parses real crate and wheel metadata', () => {
    const crate = inspectArtifact(bytes('crate-itoa-1.0.11.crate'), {
      expectedDigest: digest('crate-itoa-1.0.11.sha256'),
      algorithm: 'sha256',
    });
    expect(crate.state).toBe('verified');
    expect(crate.entries.some((e) => e.path.endsWith('build.rs'))).toBe(false);
    expect(crate.entries.some((e) => e.path.endsWith('Cargo.toml'))).toBe(true);
    const wheel = inspectArtifact(bytes('pypi-six-1.16.0-py2.py3-none-any.whl'), {
      expectedDigest: readFileSync(join(root, 'pypi-six-1.16.0.url'), 'utf8')
        .trim()
        .split(/\s+/)
        .pop(),
      algorithm: 'sha256',
    });
    expect(wheel.state).toBe('verified');
    expect(wheel.entries.some((e) => e.path.endsWith('METADATA'))).toBe(true);
    expect(wheel.entries.some((e) => e.path.endsWith('RECORD'))).toBe(true);
  });
  it('verifies every npm integrity fixture and refuses a flipped byte before inspection', () => {
    for (const [a, d] of [
      ['npm-colors-1.4.0.tgz', 'npm-colors-1.4.0.integrity'],
      ['npm-core-js-3.37.0.tgz', 'npm-core-js-3.37.0.integrity'],
      ['npm-esbuild-0.28.2.tgz', 'npm-esbuild-0.28.2.integrity'],
      ['npm-sigstore-3.1.0.tgz', 'npm-sigstore-3.1.0.integrity'],
    ] as const)
      expect(
        inspectArtifact(bytes(a), { expectedDigest: digest(d), algorithm: 'sha512' }).state,
      ).toBe('verified');
    const flipped = bytes('npm-colors-1.4.0.tgz').slice();
    flipped[flipped.length - 1]! ^= 1;
    const bad = inspectArtifact(flipped, {
      expectedDigest: digest('npm-colors-1.4.0.integrity'),
      algorithm: 'sha512',
    });
    expect(bad.state).toBe('invalid');
    expect(bad.entries).toEqual([]);
  });
  it('rejects unsafe artifact URLs and hostile archive paths without following links', () => {
    expect(safeArtifactUrl('https://registry.npmjs.org/x/-/x.tgz', 'npm')).toBe(true);
    expect(safeArtifactUrl('http://registry.npmjs.org/x.tgz', 'npm')).toBe(false);
    expect(safeArtifactUrl('https://127.0.0.1/x.tgz', 'npm')).toBe(false);
    expect(safeArtifactUrl('https://registry.npmjs.org:443/x.tgz', 'npm')).toBe(false);
    expect(safeArtifactUrl('https://user:pass@registry.npmjs.org/x.tgz', 'npm')).toBe(false);
    const tar = new Uint8Array(1024);
    tar.set(new TextEncoder().encode('../escape'), 0);
    tar[156] = 0;
    const i = inspectArtifact(new Uint8Array([0x1f, 0x8b, 0x08]));
    expect(i.state).toBe('failed');
    expect(inspectArtifact(tar).diagnostics).toContain('unsupported_archive');
  });

  it('does not persist raw artifact URLs after an allowlisted download', async () => {
    const result = await inspectDownloadedArtifacts({
      http: new HttpClient({
        allowedHosts: ['registry.npmjs.org'],
        fetch: async () => new Response(''),
      }),
      candidates: [
        {
          registry: 'npm',
          package: 'x',
          version: '1.0.0',
          url: 'https://registry.npmjs.org/x/-/x.tgz',
        },
      ],
    });
    expect(result.artifacts[0]?.url).toBeNull();
  });

  it('refuses a foreign redirect before artifact inspection', async () => {
    let inspected = false;
    const result = await inspectDownloadedArtifacts({
      http: new HttpClient({
        allowedHosts: ['registry.npmjs.org'],
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example/payload.tgz' },
          }),
      }),
      candidates: [
        {
          registry: 'npm',
          package: 'x',
          version: '1.0.0',
          url: 'https://registry.npmjs.org/x.tgz',
        },
      ],
    });
    inspected = result.artifacts[0]?.entries !== 0;
    expect(result.artifacts[0]?.reason).toBe('fetch_failed');
    expect(inspected).toBe(false);
  });
});

describe('dependency artifacts: decompression bombs', () => {
  it('a small gzip that inflates past the cap is failed as a bomb, never inspected', async () => {
    const { gzipSync } = await import('node:zlib');
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024)); // 40 MiB of zeros, a few KiB compressed
    expect(bomb.length).toBeLessThan(200 * 1024);
    const r = inspectArtifact(bomb, {});
    expect(r.state).toBe('failed');
    expect(r.limitsHit).toEqual(['uncompressed_size']);
    expect(r.diagnostics).toEqual(['decompression_bomb']);
    expect(r.entries).toEqual([]);
  });
});
