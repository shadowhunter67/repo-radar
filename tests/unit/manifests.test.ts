import { describe, expect, it } from 'vitest';
import { parseLockedPackages, parseManifest } from '../../src/collectors/manifests/parse.js';

describe('package.json', () => {
  it('extracts metadata, deps, bins', () => {
    const m = parseManifest(
      'package.json',
      JSON.stringify({
        name: 'x',
        description: 'does x',
        keywords: ['a', 'b'],
        bin: { xcli: 'cli.js' },
        dependencies: { a: '^1', b: '2.0.0' },
        devDependencies: { eslint: '9' },
        private: true,
      }),
    )!;
    expect(m).toMatchObject({
      ecosystem: 'npm',
      name: 'x',
      description: 'does x',
      keywords: ['a', 'b'],
      entrypoints: ['xcli'],
      isPrivate: true,
      devDependencyCount: 1,
      devDependencyNames: ['eslint'],
    });
    expect(m.dependencies.map((d) => d.name)).toEqual(['a', 'b']);
  });
  it('string bin uses the package name', () => {
    expect(parseManifest('package.json', '{"name":"tool","bin":"cli.js"}')!.entrypoints).toEqual([
      'tool',
    ]);
  });
  it('rejects invalid or non-object JSON without throwing', () => {
    expect(parseManifest('package.json', '{nope')).toBeUndefined();
    expect(parseManifest('package.json', '[]')).toBeUndefined();
    expect(parseManifest('package.json', 'null')).toBeUndefined();
  });
  it('is not confused by prototype-pollution keys', () => {
    const m = parseManifest(
      'package.json',
      '{"name":"x","dependencies":{"__proto__":"1","constructor":"2"}}',
    )!;
    expect(m.dependencies.map((d) => d.name).sort()).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('ignores non-string field types', () => {
    const m = parseManifest(
      'package.json',
      '{"name":42,"description":{"a":1},"keywords":"nope","dependencies":[1]}',
    )!;
    expect(m.name).toBeUndefined();
    expect(m.description).toBeUndefined();
    expect(m.keywords).toEqual([]);
    expect(m.dependencies).toEqual([]);
  });
});

describe('pyproject.toml / requirements.txt', () => {
  it('reads PEP 621 metadata', () => {
    const m = parseManifest(
      'pyproject.toml',
      `[project]\nname = "pkg"\ndescription = "A python thing"\nkeywords = ["q"]\ndependencies = ["requests>=2", "rich[jupyter] ; python_version>'3'"]\n[project.scripts]\npkg = "pkg.cli:main"\n`,
    )!;
    expect(m).toMatchObject({
      ecosystem: 'PyPI',
      name: 'pkg',
      description: 'A python thing',
      entrypoints: ['pkg'],
    });
    expect(m.dependencies.map((d) => d.name)).toEqual(['requests', 'rich']);
  });
  it('reads Poetry metadata and drops python itself', () => {
    const m = parseManifest(
      'pyproject.toml',
      `[tool.poetry]\nname = "p"\ndescription = "d d d"\n[tool.poetry.dependencies]\npython = "^3.9"\nflask = "^2"\n`,
    )!;
    expect(m.dependencies.map((d) => d.name)).toEqual(['flask']);
    expect(m.name).toBe('p');
  });
  it('returns undefined for TOML without project tables or with syntax errors', () => {
    expect(parseManifest('pyproject.toml', '[tool.black]\nline-length=1')).toBeUndefined();
    expect(parseManifest('pyproject.toml', 'this is = = not toml')).toBeUndefined();
  });
  it('parses requirements.txt, skipping options, URLs and comments', () => {
    const m = parseManifest(
      'requirements.txt',
      `# c\n-r other.txt\nflask==2.0.1  # web\nnumpy>=1.2\ngit+https://example.com/x.git\nhttps://example.com/y.whl\n-e .\n`,
    )!;
    expect(m.dependencies).toEqual([
      { name: 'flask', spec: '==2.0.1' },
      { name: 'numpy', spec: '>=1.2' },
    ]);
  });
});

describe('go.mod / Cargo.toml', () => {
  const gomod = `module example.com/tool\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.1.0 // indirect\n)\nrequire github.com/e/f v2.0.0\n`;
  it('go.mod: module name and direct deps only', () => {
    const m = parseManifest('go.mod', gomod)!;
    expect(m.name).toBe('example.com/tool');
    expect(m.dependencies.map((d) => d.name)).toEqual(['github.com/a/b', 'github.com/e/f']);
  });
  it('go.mod: all requires (including indirect) are version-pinned for OSV', () => {
    expect(parseLockedPackages('go.mod', gomod).map((p) => `${p.name}@${p.version}`)).toEqual([
      'github.com/a/b@v1.2.3',
      'github.com/c/d@v0.1.0',
      'github.com/e/f@v2.0.0',
    ]);
  });
  it('Cargo.toml: metadata, deps, [[bin]]', () => {
    const m = parseManifest(
      'Cargo.toml',
      `[package]\nname="c"\ndescription="rust thing"\nkeywords=["k"]\n[dependencies]\nserde="1"\ntokio={version="1",features=["full"]}\n[dev-dependencies]\ncriterion="0.5"\n[[bin]]\nname="cbin"\npath="src/main.rs"\n`,
    )!;
    expect(m).toMatchObject({
      ecosystem: 'crates.io',
      name: 'c',
      entrypoints: ['cbin'],
      devDependencyCount: 1,
      devDependencyNames: ['criterion'],
    });
    expect(m.dependencies.map((d) => d.name)).toEqual(['serde', 'tokio']);
  });
});

describe('lockfiles', () => {
  it('package-lock.json v2/3 packages, skipping root and links', () => {
    const t = JSON.stringify({
      packages: {
        '': { name: 'r', version: '1' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/a/node_modules/@s/b': { version: '2.0.0' },
        'node_modules/l': { version: '1', link: true },
      },
    });
    expect(
      parseLockedPackages('package-lock.json', t).map((p) => `${p.name}@${p.version}`),
    ).toEqual(['a@1.0.0', '@s/b@2.0.0']);
  });
  it('Cargo.lock skips workspace crates without a registry source', () => {
    const t = `[[package]]\nname="me"\nversion="0.1.0"\n\n[[package]]\nname="serde"\nversion="1.0.1"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n`;
    expect(parseLockedPackages('Cargo.lock', t)).toEqual([
      { ecosystem: 'crates.io', name: 'serde', version: '1.0.1' },
    ]);
  });
  it('poetry.lock / uv.lock map to PyPI', () => {
    expect(
      parseLockedPackages('poetry.lock', `[[package]]\nname="flask"\nversion="2.0.0"\n`)[0]!
        .ecosystem,
    ).toBe('PyPI');
  });
  it('requirements.txt only yields exact == pins', () => {
    expect(
      parseLockedPackages('requirements.txt', 'a==1.0\nb>=2\nc[x]==3.1.4\n').map((p) => p.name),
    ).toEqual(['a', 'c']);
  });
  it('caps the number of packages and survives garbage', () => {
    const many = {
      packages: Object.fromEntries(
        Array.from({ length: 3000 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }]),
      ),
    };
    expect(parseLockedPackages('package-lock.json', JSON.stringify(many)).length).toBe(1000);
    expect(parseLockedPackages('package-lock.json', 'garbage')).toEqual([]);
    expect(parseLockedPackages('Cargo.lock', '= =')).toEqual([]);
    expect(parseLockedPackages('unknown.lock', 'x')).toEqual([]);
  });
  it('unknown manifest names are ignored', () => {
    expect(parseManifest('Gemfile', 'gem "x"')).toBeUndefined();
  });
});
