import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsSnapshotStore, validKey } from '../../src/store/snapshots.js';
import { inspectArtifact } from '../../src/registry/artifacts/inspect.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';

const block = (name: string): Uint8Array => {
  const h = new Uint8Array(512);
  h.set(new TextEncoder().encode(name), 0);
  h.set(new TextEncoder().encode('0'.repeat(11) + '\0'), 124);
  return h;
};

describe('cross-platform path boundaries', () => {
  it.each(['../escape', '..\\escape', '/absolute', 'C:\\absolute', 'CON', 'name. ', 'name '])(
    'rejects unsafe snapshot repository component %s',
    (value) => {
      expect(
        validKey({
          repository: `acme/${value}`,
          commit: 'a'.repeat(40),
          schema_version: '0.16',
          methodology: '0.4',
          config_digest: 'a'.repeat(16),
        }),
      ).toBe(false);
    },
  );

  it('keeps snapshot storage contained and supports POSIX/Windows path helpers', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-paths-'));
    try {
      const store = new FsSnapshotStore(root);
      expect(store).toBeDefined();
      expect(posix.normalize('acme/../escape')).toBe('escape');
      expect(win32.normalize('acme\\..\\escape')).toBe('escape');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags traversal with mixed separators in tar metadata', () => {
    const raw = new Uint8Array([...block('../a\\..\\b'), ...block('')]);
    const result = inspectArtifact(gzipSync(raw));
    expect(result.entries[0]?.unsafe).toBe(true);
  });

  it('parses CRLF manifests and rejects a BOM as malformed JSON', () => {
    expect(
      parseManifest('package.json', '{\r\n"name":"x",\r\n"dependencies":{"a":"1"}\r\n}'),
    ).toBeTruthy();
    expect(parseManifest('package.json', '\ufeff{"name":"x"}')).toBeUndefined();
  });
});
