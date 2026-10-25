import { describe, expect, it } from 'vitest';
import { buildMetadata, inspectPackageEntries, sha256 } from '../../src/release/dry-run.js';

describe('release dry-run pure helpers', () => {
  it('generates stable checksums and build metadata', () => {
    expect(sha256(Buffer.from('repo-radar'))).toBe(
      '74ee64d629bfbceca2c0df973da33604af2e9a1961563afc5156fe8a00617435',
    );
    expect(
      buildMetadata({
        version: '0.16.0',
        node: 'v20',
        npm: '10',
        commit: 'abc',
        commands: ['check'],
      }),
    ).toEqual({
      name: 'repo-radar',
      version: '0.16.0',
      node: 'v20',
      npm: '10',
      commit: 'abc',
      commands: ['check'],
    });
  });

  it('accepts required package content and rejects private material', () => {
    expect(
      inspectPackageEntries([
        'package/dist/cli.js',
        'package/README.md',
        'package/LICENSE',
        'package/SECURITY.md',
      ]),
    ).toMatchObject({ entries: 4 });
    expect(() =>
      inspectPackageEntries(['package/dist/cli.js', 'package/tests/secret.json']),
    ).toThrow(/forbidden/);
  });
});
