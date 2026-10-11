import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/collectors/manifests/parse.js';
import { compareSbom } from '../../src/deps/compare.js';
import { parseLock } from '../../src/deps/lock.js';
import { resolveDependencies } from '../../src/deps/resolve.js';
import { isSbomPath, jsonDepthExceeds, parseSbom, SBOM_LIMITS } from '../../src/deps/sbom.js';

const cdx = (components: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components, ...extra });
const comp = (name: string, version: string | undefined, extra: Record<string, unknown> = {}) => ({
  type: 'library',
  name,
  ...(version ? { version } : {}),
  'bom-ref': `${name}@${version}`,
  purl: `pkg:npm/${name}${version ? `@${version}` : ''}`,
  ...extra,
});
const spdx = (packages: unknown[], relationships: unknown[] = []) =>
  JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages, relationships });

const manifest = (deps: Record<string, string>) =>
  parseManifest('package.json', JSON.stringify({ name: 'x', dependencies: deps }))!;
const lock = (versions: Record<string, string>) =>
  parseLock(
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(
        Object.entries(versions).map(([n, v]) => [`node_modules/${n}`, { version: v }]),
      ),
    }),
  )!;
const depsFor = (declared: Record<string, string>, locked: Record<string, string>) =>
  resolveDependencies({ manifests: [manifest(declared)], locks: [lock(locked)], sboms: [] }).deps;

describe('SBOM discovery', () => {
  it('matches likely names, not arbitrary json, and not vendored copies', () => {
    for (const p of [
      'sbom.json',
      'bom.json',
      'cyclonedx.json',
      'spdx.json',
      'dist/app.cdx.json',
      'x.spdx.json',
      'sbom/sbom.spdx.json',
    ])
      expect(isSbomPath(p), p).toBe(true);
    for (const p of [
      'package.json',
      'tsconfig.json',
      'node_modules/a/sbom.json',
      'a/b/c/d/e/sbom.json',
    ])
      expect(isSbomPath(p), p).toBe(false);
  });
});

describe('CycloneDX JSON', () => {
  it('parses components, purls, licenses, hashes, supplier and nested components', () => {
    const d = parseSbom(
      'sbom.json',
      cdx(
        [
          comp('a', '1.0.0', {
            scope: 'required',
            licenses: [{ license: { id: 'MIT' } }, { expression: 'Apache-2.0 OR MIT' }],
            hashes: [{ alg: 'SHA-256', content: 'x' }],
            supplier: { name: 'Acme' },
            components: [comp('nested', '2.0.0')],
          }),
          { type: 'operating-system', name: 'debian', version: '12' },
        ],
        { dependencies: [{ ref: 'a@1.0.0', dependsOn: ['nested@2.0.0'] }] },
      ),
    );
    expect(d).toMatchObject({
      format: 'CycloneDX',
      spec_version: '1.5',
      status: 'parsed',
      component_count: 3,
      relationship_count: 1,
    });
    const a = d.components.find((c) => c.name === 'a')!;
    expect(a).toMatchObject({
      category: 'library',
      licenses: ['MIT', 'Apache-2.0 OR MIT'],
      hash_count: 1,
      supplier: 'Acme',
      package: { ecosystem: 'npm', name: 'a' },
    });
    expect(d.components.find((c) => c.name === 'debian')?.category).toBe('operating-system');
  });
  it('rejects unsupported spec versions, malformed JSON and non-SBOM documents with a reason', () => {
    expect(parseSbom('s.json', cdx([], { specVersion: '2.0' })).status).toBe('unsupported');
    expect(parseSbom('s.json', '{not json')).toMatchObject({ status: 'malformed' });
    expect(parseSbom('s.json', JSON.stringify({ hello: 'world' }))).toMatchObject({
      status: 'not_an_sbom',
    });
    expect(parseSbom('s.json', '[]')).toMatchObject({ status: 'not_an_sbom' });
  });
});

describe('SPDX JSON', () => {
  it('parses packages, purls from externalRefs, NOASSERTION handling and the described root', () => {
    const d = parseSbom(
      'spdx.json',
      spdx(
        [
          { SPDXID: 'SPDXRef-root', name: 'root', versionInfo: '1.0.0' },
          {
            SPDXID: 'SPDXRef-a',
            name: 'a',
            versionInfo: '2.1.0',
            licenseConcluded: 'MIT',
            licenseDeclared: 'NOASSERTION',
            primaryPackagePurpose: 'LIBRARY',
            externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/a@2.1.0' }],
          },
        ],
        [
          {
            spdxElementId: 'SPDXRef-DOCUMENT',
            relationshipType: 'DESCRIBES',
            relatedSpdxElement: 'SPDXRef-root',
          },
        ],
      ),
    );
    expect(d).toMatchObject({
      format: 'SPDX',
      spec_version: 'SPDX-2.3',
      status: 'parsed',
      component_count: 2,
    });
    expect(d.components.find((c) => c.name === 'root')?.category).toBe('application');
    expect(d.components.find((c) => c.name === 'a')).toMatchObject({
      licenses: ['MIT'],
      package: { ecosystem: 'npm', name: 'a' },
      version: '2.1.0',
    });
  });
  it('SPDX 3 (JSON-LD) and old SPDX versions are reported as unsupported', () => {
    expect(
      parseSbom(
        's.json',
        JSON.stringify({ '@context': 'https://spdx.org/rdf/3.0.0/spdx-context.jsonld' }),
      ),
    ).toMatchObject({ status: 'unsupported' });
    expect(
      parseSbom('s.json', JSON.stringify({ spdxVersion: 'SPDX-1.2', packages: [] })),
    ).toMatchObject({ status: 'unsupported' });
  });
});

describe('SBOM resource limits and hostile content', () => {
  it('oversized documents are not processed', () => {
    expect(parseSbom('s.json', ' '.repeat(SBOM_LIMITS.maxBytes + 1)).status).toBe('too_large');
  });
  it('a component list beyond the cap is truncated and flagged', () => {
    const many = Array.from({ length: SBOM_LIMITS.maxComponents + 50 }, (_, i) =>
      comp(`p${i}`, '1.0.0'),
    );
    const d = parseSbom('s.json', cdx(many));
    expect(d.component_count).toBe(SBOM_LIMITS.maxComponents);
    expect(d.truncated).toBe(true);
    expect(d.detail).toMatch(/only the first/);
  });
  it('deep nesting is refused before JSON.parse can overflow the stack', () => {
    const deep = '['.repeat(SBOM_LIMITS.maxDepth + 10) + ']'.repeat(SBOM_LIMITS.maxDepth + 10);
    expect(jsonDepthExceeds(deep, SBOM_LIMITS.maxDepth)).toBe(true);
    expect(parseSbom('s.json', deep)).toMatchObject({ status: 'malformed' });
    expect(jsonDepthExceeds('{"a":"[[[[[[[[["}', 3)).toBe(false); // brackets inside strings do not count
  });
  it('extreme strings are clipped and terminal control sequences are stripped', () => {
    const d = parseSbom(
      's.json',
      cdx([comp('evil\u001b]8;;http://x\u0007name', '1.0.0'), comp('long'.repeat(500), '1.0.0')]),
    );
    for (const c of d.components) {
      expect(c.name.length).toBeLessThanOrEqual(SBOM_LIMITS.maxString);
      expect([...c.name].some((ch) => ch.charCodeAt(0) < 9 || ch.charCodeAt(0) === 27)).toBe(false);
    }
  });
  it('a malformed purl never throws and yields no package identity', () => {
    const d = parseSbom(
      's.json',
      cdx([{ type: 'library', name: 'a', version: '1', purl: 'pkg:%%%/@@' }]),
    );
    expect(d.components[0]?.package).toBeUndefined();
  });
});

describe('SBOM vs repository comparison', () => {
  const doc = (components: unknown[]) => parseSbom('sbom.json', cdx(components));

  it('consistent: every direct runtime dependency is present with the locked version; extra components are not errors', () => {
    const deps = depsFor({ a: '^1.0.0', b: '^2.0.0' }, { a: '1.2.0', b: '2.0.1', t: '9.0.0' });
    const c = compareSbom(
      doc([comp('a', '1.2.0'), comp('b', '2.0.1'), comp('t', '9.0.0'), comp('tool', '3.0.0')]),
      deps,
    );
    expect(c).toMatchObject({
      state: 'consistent',
      matched: 2,
      direct_runtime_dependencies: 2,
      additional_sbom_components: 2,
    });
    expect(c.missing_from_sbom).toEqual([]);
    expect(c.confidence).toBeGreaterThan(0.7);
  });
  it('mismatch: a version that differs from the lockfile is reported with its basis', () => {
    const deps = depsFor({ a: '^1.0.0' }, { a: '1.2.0' });
    const c = compareSbom(doc([comp('a', '1.1.0')]), deps);
    expect(c.state).toBe('mismatch');
    expect(c.version_mismatches[0]).toMatchObject({
      package: 'npm:a',
      sbom_version: '1.1.0',
      expected: '1.2.0',
      basis: 'locked in package-lock.json',
    });
  });
  it('partial: a direct dependency missing from the SBOM', () => {
    const deps = depsFor({ a: '^1.0.0', b: '^2.0.0' }, { a: '1.2.0', b: '2.0.1' });
    const c = compareSbom(doc([comp('a', '1.2.0')]), deps);
    expect(c.state).toBe('partial');
    expect(c.missing_from_sbom).toEqual(['npm:b']);
  });
  it('without a lockfile the requested range decides: inside is fine, outside is a mismatch', () => {
    const noLock = resolveDependencies({
      manifests: [manifest({ a: '^1.0.0' })],
      locks: [],
      sboms: [],
    }).deps;
    expect(compareSbom(doc([comp('a', '1.5.0')]), noLock).state).toBe('consistent');
    expect(compareSbom(doc([comp('a', '3.0.0')]), noLock).state).toBe('mismatch');
    expect(compareSbom(doc([comp('a', '1.5.0')]), noLock).confidence).toBeLessThan(
      compareSbom(doc([comp('a', '1.2.0')]), depsFor({ a: '^1.0.0' }, { a: '1.2.0' })).confidence,
    );
  });
  it('duplicates, missing versions and components without purl are surfaced', () => {
    const deps = depsFor({ a: '^1.0.0' }, { a: '1.0.0' });
    const c = compareSbom(
      doc([
        comp('a', '1.0.0'),
        comp('a', '1.0.0'),
        { type: 'library', name: 'nopurl', version: '1.0.0' },
        { type: 'library', name: 'nover', purl: 'pkg:npm/nover' },
      ]),
      deps,
    );
    expect(c.duplicate_components.length).toBe(1);
    expect(c.invalid_versions).toContain('nover');
    expect(c.library_components_without_purl).toBe(1);
  });
  it('an SBOM for a different ecosystem is flagged; nothing to compare yields unable_to_compare', () => {
    const deps = depsFor({ a: '^1.0.0' }, { a: '1.0.0' });
    const other = doc([
      { type: 'library', name: 'serde', version: '1.0.0', purl: 'pkg:cargo/serde@1.0.0' },
    ]);
    expect(compareSbom(other, deps).ecosystem_mismatch[0]).toMatch(/^npm: 1 direct/);
    expect(
      compareSbom(doc([{ type: 'operating-system', name: 'debian', version: '12' }]), deps).state,
    ).toBe('unable_to_compare');
    expect(compareSbom(doc([comp('a', '1.0.0')]), []).state).toBe('unable_to_compare');
    expect(compareSbom(parseSbom('s.json', '{bad'), deps).state).toBe('unable_to_compare');
  });
  it('matching by bare name (no purl) is allowed but lowers confidence', () => {
    const deps = depsFor({ a: '^1.0.0' }, { a: '1.0.0' });
    const withPurl = compareSbom(doc([comp('a', '1.0.0')]), deps);
    const nameOnly = compareSbom(doc([{ type: 'library', name: 'a', version: '1.0.0' }]), deps);
    expect(nameOnly.matched).toBe(1);
    expect(nameOnly.confidence).toBeLessThan(withPurl.confidence);
  });
  it('an SBOM-derived exact version never validates itself against the SBOM', () => {
    const d = doc([comp('a', '1.0.0')]);
    const deps = resolveDependencies({
      manifests: [manifest({ a: '^1.0.0' })],
      locks: [],
      sboms: [d],
    }).deps;
    expect(deps[0]?.resolved).toMatchObject({ source: 'sbom', version: '1.0.0', confidence: 0.7 });
    expect(
      compareSbom(d, deps).unverifiable_versions + compareSbom(d, deps).matched,
    ).toBeGreaterThan(0);
  });
});

describe('source precedence and conflicts across lockfile, SBOM and manifest', () => {
  it('lockfile beats SBOM beats manifest pin, and every disagreement is recorded', () => {
    const d = parseSbom('sbom.json', cdx([comp('a', '2.3.8')]));
    const { deps, conflicts } = resolveDependencies({
      manifests: [manifest({ a: '^2.0.0' })],
      locks: [lock({ a: '2.4.1' })],
      sboms: [d],
    });
    expect(deps[0]?.resolved).toMatchObject({ version: '2.4.1', source: 'lockfile' });
    expect(deps[0]?.other_versions).toEqual([
      { version: '2.3.8', source: 'sbom', file: 'sbom.json' },
    ]);
    expect(conflicts.map((c) => c.kind)).toContain('lockfile_vs_sbom');
  });
  it('an SBOM resolves a range only when no lockfile exists, with lower confidence', () => {
    const d = parseSbom('sbom.json', cdx([comp('a', '2.3.8')]));
    const { deps } = resolveDependencies({
      manifests: [manifest({ a: '^2.0.0' })],
      locks: [],
      sboms: [d],
    });
    expect(deps[0]?.resolved).toMatchObject({ version: '2.3.8', source: 'sbom' });
    expect(deps[0]!.resolved!.confidence).toBeLessThan(0.95);
  });
  it('two different SBOM versions of the same package make the dependency ambiguous, not resolved', () => {
    const d = parseSbom('sbom.json', cdx([comp('a', '1.0.0'), comp('a', '2.0.0')]));
    const { deps } = resolveDependencies({
      manifests: [manifest({ a: '*' })],
      locks: [],
      sboms: [d],
    });
    expect(deps[0]).toMatchObject({ resolution: 'ambiguous' });
    expect(deps[0]?.resolved).toBeUndefined();
  });
});

describe('empty SBOM (found on mongodb/mongo-go-driver)', () => {
  it('a valid SBOM with zero components next to declared dependencies is partial, not "unable to compare"', () => {
    const empty = parseSbom('sbom.json', cdx([]));
    const c = compareSbom(empty, depsFor({ a: '^1.0.0' }, { a: '1.0.0' }));
    expect(c.state).toBe('partial');
    expect(c.missing_from_sbom).toEqual(['npm:a']);
    expect(c.notes[0]).toMatch(/empty/);
    expect(compareSbom(empty, []).state).toBe('unable_to_compare');
  });
});
