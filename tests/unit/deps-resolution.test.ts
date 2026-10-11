import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/collectors/manifests/parse.js';
import { parseLock } from '../../src/deps/lock.js';
import { makePurl, parsePurl } from '../../src/deps/model.js';
import { resolveDependencies } from '../../src/deps/resolve.js';
import { maxSatisfying, satisfies } from '../../src/deps/semver.js';
import { classifySpec } from '../../src/deps/spec.js';

const pkgJson = (o: Record<string, unknown>, file = 'package.json') =>
  parseManifest(file, JSON.stringify({ name: 'x', version: '1.0.0', ...o }))!;

describe('semver helper', () => {
  it('npm ranges: caret, tilde, x-ranges, or, hyphen, prerelease rule', () => {
    expect(satisfies('^1.2.3', '1.9.0', 'npm')).toBe(true);
    expect(satisfies('^1.2.3', '2.0.0', 'npm')).toBe(false);
    expect(satisfies('^0.2.3', '0.2.9', 'npm')).toBe(true);
    expect(satisfies('^0.2.3', '0.3.0', 'npm')).toBe(false);
    expect(satisfies('~1.2.3', '1.2.9', 'npm')).toBe(true);
    expect(satisfies('~1.2.3', '1.3.0', 'npm')).toBe(false);
    expect(satisfies('1.x', '1.7.1', 'npm')).toBe(true);
    expect(satisfies('>=1.0.0 <2.0.0 || >=3', '3.1.0', 'npm')).toBe(true);
    expect(satisfies('1.2.3 - 2.0.0', '1.5.0', 'npm')).toBe(true);
    expect(satisfies('^1.0.0', '1.1.0-beta.1', 'npm')).toBe(false);
  });
  it('Cargo: a bare version is a caret requirement', () => {
    expect(satisfies('1.2.3', '1.9.0', 'cargo')).toBe(true);
    expect(satisfies('1.2.3', '2.0.0', 'cargo')).toBe(false);
    expect(satisfies('>=1.2, <1.5', '1.4.0', 'cargo')).toBe(true);
  });
  it('unparseable input is "cannot tell", never true', () => {
    expect(satisfies('latest', '1.0.0', 'npm')).toBeUndefined();
    expect(satisfies('^1.0.0', 'not-a-version', 'npm')).toBeUndefined();
    expect(satisfies('x'.repeat(500), '1.0.0', 'npm')).toBeUndefined();
  });
  it('maxSatisfying ignores prereleases', () => {
    expect(maxSatisfying('^1.0.0', ['1.0.0', '1.4.2', '1.5.0-rc.1', '2.0.0'], 'npm')).toBe('1.4.2');
  });
});

describe('specification classification (exact vs range vs everything else)', () => {
  const k = (e: Parameters<typeof classifySpec>[0], s: string) => classifySpec(e, s).kind;
  it('npm', () => {
    expect(k('npm', '1.2.3')).toBe('exact');
    expect(k('npm', '=1.2.3')).toBe('exact');
    expect(k('npm', '^4.0.0')).toBe('range');
    expect(k('npm', '*')).toBe('range');
    expect(k('npm', 'latest')).toBe('tag');
    expect(k('npm', 'github:user/repo')).toBe('branch');
    expect(k('npm', 'user/repo#0123456789abcdef0123456789abcdef01234567')).toBe('commit');
    expect(k('npm', 'git+https://example.test/x.git#main')).toBe('branch');
    expect(k('npm', 'workspace:*')).toBe('workspace');
    expect(k('npm', 'file:../foo')).toBe('path');
    expect(k('npm', 'https://example.test/x.tgz')).toBe('url');
    const alias = classifySpec('npm', 'npm:real-pkg@^1.0.0');
    expect(alias).toMatchObject({ kind: 'range', alias_of: 'real-pkg' });
  });
  it('PyPI / Cargo / Go', () => {
    expect(k('PyPI', '==1.2.3')).toBe('exact');
    expect(k('PyPI', '==1.*')).toBe('range');
    expect(k('PyPI', '>=1.0,<2')).toBe('range');
    expect(k('PyPI', 'url:https://x.test/a.whl')).toBe('url');
    expect(k('crates.io', '1.2.3')).toBe('range'); // caret
    expect(k('crates.io', '=1.2.3')).toBe('exact');
    expect(k('crates.io', 'path:../x')).toBe('path');
    expect(
      k('crates.io', 'git:https://x.test/r#rev=0123456789abcdef0123456789abcdef01234567'),
    ).toBe('commit');
    expect(k('Go', 'v1.2.3')).toBe('exact');
    expect(k('Go', 'v0.0.0-20200101000000-abcdef123456')).toBe('exact');
  });
  it('preserves the requested spec and strips control characters', () => {
    const r = classifySpec('npm', '^1.0.0\u001b[31m');
    expect(r.spec).not.toContain('\u001b');
  });
});

describe('purl helpers', () => {
  it('builds and parses purls including scoped npm and Go paths', () => {
    expect(makePurl('npm', '@scope/pkg', '1.0.0')).toBe('pkg:npm/%40scope/pkg@1.0.0');
    expect(parsePurl('pkg:npm/%40scope/pkg@1.0.0')).toEqual({
      ecosystem: 'npm',
      name: '@scope/pkg',
      version: '1.0.0',
    });
    expect(parsePurl('pkg:golang/github.com/a/b@v1.2.3')).toEqual({
      ecosystem: 'Go',
      name: 'github.com/a/b',
      version: 'v1.2.3',
    });
    expect(makePurl('PyPI', 'Foo_Bar')).toBe('pkg:pypi/foo-bar');
    expect(parsePurl('pkg:evil')).toBeUndefined();
    expect(parsePurl('x'.repeat(600))).toBeUndefined();
  });
});

describe('manifest raw dependencies', () => {
  it('npm relationships and spec forms', () => {
    const m = pkgJson({
      dependencies: { a: '^1.0.0' },
      devDependencies: { b: '2.0.0' },
      peerDependencies: { c: '>=3' },
      optionalDependencies: { d: 'file:../d' },
    });
    expect(m.rawDeps?.map((d) => [d.name, d.relationship])).toEqual([
      ['a', 'runtime'],
      ['d', 'optional'],
      ['c', 'peer'],
      ['b', 'development'],
    ]);
  });
  it('Cargo tables are normalized and renames use the registry name', () => {
    const m = parseManifest(
      'Cargo.toml',
      `[package]\nname="x"\n[dependencies]\nserde="1"\nlocal={path="../l"}\ng={git="https://x.test/g", rev="abc1234"}\nw={workspace=true}\nr={package="real", version="2"}\n[dev-dependencies]\nt="0.3"\n[build-dependencies]\ncc="1"\n`,
    )!;
    const by = Object.fromEntries(m.rawDeps!.map((d) => [d.name, d]));
    expect(by['local']?.spec).toBe('path:../l');
    expect(by['g']?.spec).toBe('git:https://x.test/g#rev=abc1234');
    expect(by['w']?.spec).toBe('inherited:workspace');
    expect(by['real']?.spec).toBe('2');
    expect(by['t']?.relationship).toBe('development');
    expect(by['cc']?.relationship).toBe('build');
  });
  it('go.mod keeps indirect requirements as non-direct and honours local replaces', () => {
    const m = parseManifest(
      'go.mod',
      'module x\nrequire (\n a.test/a v1.0.0\n b.test/b v2.0.0 // indirect\n c.test/c v0.1.0\n)\nreplace c.test/c => ../c\n',
    )!;
    const by = Object.fromEntries(m.rawDeps!.map((d) => [d.name, d]));
    expect(by['b.test/b']?.direct).toBe(false);
    expect(by['c.test/c']?.spec).toBe('path:../c');
    expect(m.dependencies.map((d) => d.name)).toEqual(['a.test/a', 'c.test/c']);
  });
  it('pyproject: extras, dependency groups, build requires, poetry tables and PEP 508 direct references', () => {
    const m = parseManifest(
      'pyproject.toml',
      `[build-system]\nrequires=["setuptools>=61"]\nbuild-backend="setuptools.build_meta"\n[project]\nname="x"\ndependencies=["requests>=2,<3","tool @ https://x.test/t.whl"]\n[project.optional-dependencies]\nfast=["ujson==5.0.0"]\n[dependency-groups]\ntest=["pytest"]\n`,
    )!;
    const by = Object.fromEntries(m.rawDeps!.map((d) => [d.name, d]));
    expect(by['requests']?.relationship).toBe('runtime');
    expect(by['tool']?.spec).toBe('url:https://x.test/t.whl');
    expect(by['ujson']?.relationship).toBe('optional');
    expect(by['pytest']?.relationship).toBe('test');
    expect(by['setuptools']?.relationship).toBe('build');
  });
});

describe('lockfiles', () => {
  it('package-lock v3: resolves from the nearest node_modules, ignores links', () => {
    const lock = parseLock(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'x' },
          'node_modules/a': { version: '1.4.0' },
          'packages/w/node_modules/a': { version: '2.0.0' },
          'node_modules/w': { resolved: 'packages/w', link: true },
          'node_modules/b': { version: '3.0.0', dev: true },
        },
      }),
    )!;
    expect(lock.resolve('', 'a', '^1').versions).toEqual(['1.4.0']);
    expect(lock.resolve('packages/w', 'a', '^2').versions).toEqual(['2.0.0']);
    expect(lock.resolve('packages/w', 'b', '3').versions).toEqual(['3.0.0']);
    expect(lock.entries.find((e) => e.name === 'w')).toBeUndefined();
    expect(lock.entries.find((e) => e.name === 'b')?.dev).toBe(true);
  });
  it('yarn.lock v1 resolves by exact request string', () => {
    const lock = parseLock(
      'yarn.lock',
      '# yarn lockfile v1\n\nleft-pad@^1.0.0, left-pad@^1.1.0:\n  version "1.3.0"\n  resolved "https://x"\n\nother@^2.0.0:\n  version "2.1.0"\n',
    )!;
    expect(lock.resolve('', 'left-pad', '^1.0.0').versions).toEqual(['1.3.0']);
    expect(lock.resolve('', 'other', '^2.0.0').versions).toEqual(['2.1.0']);
  });
  it('pnpm-lock importers give the direct version, peers suffix stripped', () => {
    const lock = parseLock(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^18.0.0\n        version: 18.2.0(peer@1.0.0)\npackages:\n  react@18.2.0: {}\n",
    )!;
    expect(lock.resolve('', 'react', '^18.0.0').versions).toEqual(['18.2.0']);
  });
  it('Cargo.lock: several versions are narrowed by the requirement; workspace crates are local', () => {
    const lock = parseLock(
      'Cargo.lock',
      '[[package]]\nname="syn"\nversion="1.0.109"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n[[package]]\nname="syn"\nversion="2.0.50"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n[[package]]\nname="me"\nversion="0.1.0"\n',
    )!;
    expect(lock.resolve('', 'syn', '2').versions).toEqual(['2.0.50']);
    expect(lock.resolve('', 'syn', '*').versions.length).toBe(2);
    expect(lock.entries.find((e) => e.name === 'me')?.local).toBe(true);
  });
  it('malformed lockfiles return undefined instead of throwing', () => {
    expect(parseLock('package-lock.json', '{not json')).toBeUndefined();
    expect(parseLock('Cargo.lock', 'not = [toml')).toBeUndefined();
  });
});

describe('resolution precedence and honesty', () => {
  const lockJson = (v: string) =>
    parseLock(
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: v } } }),
    )!;

  it('a lockfile resolves a range to its exact version (requested spec is kept)', () => {
    const { deps } = resolveDependencies({
      manifests: [pkgJson({ dependencies: { a: '^1.0.0' } })],
      locks: [lockJson('1.4.0')],
      sboms: [],
    });
    expect(deps[0]).toMatchObject({
      resolution: 'resolved',
      requested: { spec: '^1.0.0', kind: 'range' },
      resolved: { version: '1.4.0', source: 'lockfile' },
      direct: true,
    });
  });

  it('a range without any lockfile stays UNRESOLVED (no registry guess, no exact version)', () => {
    const { deps } = resolveDependencies({
      manifests: [pkgJson({ dependencies: { a: '^1.0.0' } })],
      locks: [],
      sboms: [],
    });
    expect(deps[0]).toMatchObject({ resolution: 'unresolved' });
    expect(deps[0]?.resolved).toBeUndefined();
    expect(deps[0]?.vulnerability.state).toBe('not_checked');
  });

  it('an exact pin without a lockfile resolves from the manifest with lower confidence than a lockfile', () => {
    const { deps } = resolveDependencies({
      manifests: [pkgJson({ dependencies: { a: '1.2.3' } })],
      locks: [],
      sboms: [],
    });
    expect(deps[0]?.resolved).toMatchObject({ version: '1.2.3', source: 'manifest_pin' });
    expect(deps[0]!.resolved!.confidence).toBeLessThan(0.95);
  });

  it('workspace, path and git dependencies are not registry dependencies', () => {
    const { deps } = resolveDependencies({
      manifests: [
        pkgJson({ dependencies: { w: 'workspace:*', p: 'file:../p', g: 'github:u/r#main' } }),
      ],
      locks: [],
      sboms: [],
    });
    expect(deps.map((d) => d.resolution)).toEqual(['not_registry', 'not_registry', 'not_registry']);
  });

  it('manifest pin vs lockfile disagreement is reported, lockfile wins, the other value is kept', () => {
    const { deps, conflicts } = resolveDependencies({
      manifests: [pkgJson({ dependencies: { a: '1.0.0' } })],
      locks: [lockJson('1.0.5')],
      sboms: [],
    });
    expect(deps[0]?.resolved?.version).toBe('1.0.5');
    expect(deps[0]?.other_versions).toEqual([
      { version: '1.0.0', source: 'manifest_pin', file: 'package.json' },
    ]);
    expect(conflicts[0]).toMatchObject({ kind: 'manifest_vs_lockfile' });
  });

  it('a stale lockfile (locked version outside the requested range) is a conflict', () => {
    const { conflicts } = resolveDependencies({
      manifests: [pkgJson({ dependencies: { a: '^2.0.0' } })],
      locks: [lockJson('1.9.0')],
      sboms: [],
    });
    expect(
      conflicts.some(
        (c) => c.kind === 'manifest_vs_lockfile' && /outside the range/.test(c.detail),
      ),
    ).toBe(true);
  });

  it('lockfile packages nobody asked for by name become transitive dependencies', () => {
    const lock = parseLock(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/a': { version: '1.0.0' },
          'node_modules/t': { version: '9.0.0' },
        },
      }),
    )!;
    const { deps } = resolveDependencies({
      manifests: [pkgJson({ dependencies: { a: '^1' } })],
      locks: [lock],
      sboms: [],
    });
    expect(deps.filter((d) => d.direct === false).map((d) => d.package.name)).toEqual(['t']);
  });

  it('Go: go.mod pins are exact for the build list, indirect requirements are not direct', () => {
    const m = parseManifest(
      'go.mod',
      'module x\nrequire (\n a.test/a v1.0.0\n b.test/b v2.0.0 // indirect\n)\n',
    )!;
    const { deps } = resolveDependencies({ manifests: [m], locks: [], sboms: [] });
    expect(deps.map((d) => [d.package.name, d.direct, d.resolved?.version])).toEqual([
      ['a.test/a', true, 'v1.0.0'],
      ['b.test/b', false, 'v2.0.0'],
    ]);
  });
});
