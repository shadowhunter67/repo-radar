import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseBuildSource } from '../../src/collectors/build-systems/parse.js';
import { extractDomains } from '../../src/domains/extract.js';
import { inspectArtifact } from '../../src/registry/artifacts/inspect.js';
import { safeArtifactUrl } from '../../src/registry/artifacts/download.js';
import { comparePackageNames, normalizePackageName } from '../../src/registry/names.js';
import { parseMinimums } from '../../src/scoring/policy.js';
import { SIGSTORE_LIMITS, verifyBundle } from '../../src/trust/sigstore.js';
import { HttpClient, TooLargeError } from '../../src/util/http.js';
import { FsSnapshotStore, SNAPSHOT_LIMITS } from '../../src/store/snapshots.js';

const memoryDelta = <T>(fn: () => T): { value: T; heap: number; arrayBuffers: number } => {
  const before = process.memoryUsage();
  const value = fn();
  const after = process.memoryUsage();
  return {
    value,
    heap: Math.max(0, after.heapUsed - before.heapUsed),
    arrayBuffers: Math.max(0, after.arrayBuffers - before.arrayBuffers),
  };
};

const zipBombEntry = (): Uint8Array => {
  const name = Buffer.from('bomb.txt');
  const body = deflateRawSync(Buffer.alloc(1024 * 1024, 0));
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(1024 * 1024, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(1024 * 1024, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + body.length, 16);
  return Buffer.concat([local, body, central, end]);
};

describe('H5 hostile-input memory bounds', () => {
  it('rejects gzip bombs before retaining their expanded output', () => {
    const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024, 0));
    const r = memoryDelta(() => inspectArtifact(bomb, { kind: 'unknown' }));
    expect(r.value).toMatchObject({ state: 'failed' });
    expect((r.value as { diagnostics: string[] }).diagnostics).toContain('decompression_bomb');
    expect(r.heap + r.arrayBuffers).toBeLessThan(128 * 1024 * 1024);
  });

  it('rejects a ZIP entry whose declared output exceeds the entry limit', () => {
    const r = memoryDelta(() => inspectArtifact(zipBombEntry(), { kind: 'unknown' }));
    expect(r.value).toMatchObject({ state: 'verification_unavailable' });
    expect(
      (r.value as { entries?: Array<{ content?: unknown; size: number }> }).entries?.[0],
    ).toMatchObject({ size: 1024 * 1024 });
    expect(
      (r.value as { entries?: Array<{ content?: unknown }> }).entries?.[0]?.content,
    ).toBeUndefined();
    expect(r.heap + r.arrayBuffers).toBeLessThan(128 * 1024 * 1024);
  });

  it('skips an oversized Sigstore bundle without invoking its verifier', async () => {
    let called = false;
    const r = await verifyBundle(
      { trustRoot: 'sigstore_public_good', verify: async () => ((called = true), {}) },
      { padding: 'x'.repeat(SIGSTORE_LIMITS.maxBundleBytes + 1) },
    );
    expect(r.state).toBe('verification_skipped_resource_limit');
    expect(called).toBe(false);
  });

  it('rejects an oversized registry response while reading it', async () => {
    const body = 'x'.repeat(17 * 1024 * 1024);
    const http = new HttpClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const before = process.memoryUsage();
    await expect(
      http.request('https://registry.npmjs.org/pkg', { maxBytes: 16 * 1024 * 1024 }),
    ).rejects.toBeInstanceOf(TooLargeError);
    const after = process.memoryUsage();
    expect(
      Math.max(0, after.heapUsed - before.heapUsed) +
        Math.max(0, after.arrayBuffers - before.arrayBuffers),
    ).toBeLessThan(128 * 1024 * 1024);
  });

  it('rejects an oversized snapshot index before reading it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-h5-snapshot-'));
    writeFileSync(join(dir, 'index.jsonl'), 'x'.repeat(SNAPSHOT_LIMITS.maxBytes + 1));
    const r = memoryDelta(() => new FsSnapshotStore(dir).listSnapshots());
    expect(r.value).toEqual([]);
    expect(r.heap + r.arrayBuffers).toBeLessThan(128 * 1024 * 1024);
  });
});

describe('H5 pathological regex inputs', () => {
  it('keeps name, build, artifact, domain, and policy parsing bounded', () => {
    const hostile = `${'a'.repeat(200_000)}${'('.repeat(20_000)}${'\\'.repeat(20_000)}`;
    const t = performance.now();
    expect(normalizePackageName(hostile, 'pypi')).toHaveLength(hostile.length);
    expect(comparePackageNames(hostile, `${hostile}x`, 'npm').distance).toBeNull();
    expect(parseBuildSource('MODULE.bazel', hostile).dependencies).toEqual([]);
    expect(
      extractDomains({
        files: [{ path: 'README.md', content: hostile, size: hostile.length, role: 'ref' }],
        hooks: [],
        detections: [],
      }).domains,
    ).toEqual([]);
    expect(safeArtifactUrl(`https://registry.npmjs.org/${hostile}`, 'npm')).toBe(false);
    expect(() => parseMinimums([`${hostile}=1`])).toThrow(/invalid --min/);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('keeps archive URL and source parsers linear on near-miss input', () => {
    const nearMiss = `https://${'a'.repeat(500_000)}${'!'.repeat(100_000)}`;
    const t = performance.now();
    expect(safeArtifactUrl(nearMiss, 'npm')).toBe(false);
    expect(parseBuildSource('BUILD', nearMiss).dependencies).toEqual([]);
    expect(
      extractDomains({
        files: [{ path: 'x.js', content: nearMiss, size: nearMiss.length, role: 'source' }],
        hooks: [],
        detections: [],
      }).domains,
    ).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
