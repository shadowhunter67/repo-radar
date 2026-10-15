import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectArtifact } from '../../src/registry/artifacts/inspect.js';
import { extractStaticFacts } from '../../src/registry/artifacts/static.js';
import { safeArtifactUrl } from '../../src/registry/artifacts/download.js';

const root = join(process.cwd(), 'tests/fixtures/artifacts');
const bytes = (name: string): Uint8Array => readFileSync(join(root, name));
const digest = (name: string): string =>
  readFileSync(join(root, name), 'utf8').trim().split(/\s+/)[0]!;

describe('dependency artifacts: pinned fixtures', () => {
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
});
