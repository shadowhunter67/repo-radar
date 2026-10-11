import { describe, expect, it } from 'vitest';
import type { RepoSnapshot } from '../../src/collectors/types.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';
import { HeuristicClassifier, loadDefaultTaxonomy } from '../../src/identity/index.js';
import { classifyIdentityV2, IdentityV2Schema } from '../../src/identity/v2.js';

const classifier = new HeuristicClassifier(loadDefaultTaxonomy());
const pkg = (file: string, extra: Record<string, unknown> = {}) =>
  parseManifest(file, JSON.stringify({ name: file.replace(/\W/g, '-'), ...extra }))!;
const snap = (over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  owner: 'o',
  repo: 'r',
  displayName: 'r',
  topics: [],
  treePaths: [],
  manifests: [],
  hasDockerfile: false,
  hasActionYml: false,
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/o/r',
  ...over,
});
const v2 = (s: RepoSnapshot, extra: Partial<Parameters<typeof classifyIdentityV2>[0]> = {}) => {
  const legacy = classifier.classify(s);
  const r = classifyIdentityV2({ snapshot: s, legacy, ...extra });
  expect(IdentityV2Schema.safeParse(r).success).toBe(true);
  return r;
};

describe('identity v2: packaging is separate from what the artifact is', () => {
  it('a workspace of libraries is a library with workspace packaging, never "monorepo" as its identity', () => {
    const r = v2(
      snap({
        manifests: ['a', 'b', 'c'].map((n) => pkg(`packages/${n}/package.json`, { main: 'i.js' })),
      }),
    );
    expect(r.packaging.value).toBe('multi_package');
    expect(r.packaging.published_packages).toBe(3);
    expect(r.primary_artifact.value).not.toBe('monorepo' as never);
    expect(r.secondary_roles).toContain('workspace_root');
  });

  it('a root package with a bin entry and a library surface is a CLI with a library_api secondary role', () => {
    const r = v2(
      snap({
        manifests: [pkg('package.json', { bin: { tool: 'bin/tool.js' }, main: 'lib.js' })],
        treePaths: ['bin/tool.js', 'lib.js'],
      }),
    );
    expect(r.primary_artifact.value).toBe('cli');
    expect(r.interfaces).toEqual(expect.arrayContaining(['cli', 'library_api']));
    expect(r.secondary_roles).toContain('library_api');
    expect(r.deployment_form.value).toBe('local_executable');
    expect(r.primary_artifact.alternatives.map((a) => a.value)).toContain('library');
  });

  it('examples, tests and vendored manifests do not count as packages', () => {
    const r = v2(
      snap({
        manifests: [
          pkg('package.json', { main: 'i.js' }),
          pkg('examples/a/package.json'),
          pkg('vendor/x/package.json'),
          pkg('tests/fixtures/package.json'),
        ],
      }),
    );
    expect(r.packaging).toMatchObject({ value: 'single_package', package_count: 1 });
  });
});

describe('identity v2: structural evidence, not names or prose', () => {
  it('the repository name and README keywords do not change the primary artifact', () => {
    const base = snap({ manifests: [pkg('package.json', { main: 'i.js' })] });
    const named = snap({
      displayName: 'super-cli-server-framework',
      readme: 'A command line tool server framework application',
      topics: ['cli', 'server'],
      manifests: base.manifests,
    });
    expect(v2(named).primary_artifact.value).toBe(v2(base).primary_artifact.value);
    expect(v2(named).evidence.join(' ')).not.toMatch(/super-cli/);
  });

  it('a Go module with a `package main` file is a program; without one it is a library', () => {
    const go = parseManifest('go.mod', 'module example.com/x\n\ngo 1.22\n')!;
    const prog = v2(snap({ manifests: [go], treePaths: ['x.go'] }), { goPackageMain: true });
    const lib = v2(snap({ manifests: [go], treePaths: ['x.go'] }), { goPackageMain: false });
    expect(prog.primary_artifact.value).toBe('cli');
    expect(lib.primary_artifact.value).toBe('library');
  });

  it('a server capability inside a CLI does not turn the CLI into a service, but it is exposed', () => {
    const go = parseManifest('go.mod', 'module example.com/x\n\ngo 1.22\n')!;
    const r = v2(snap({ manifests: [go], hasDockerfile: true, treePaths: ['main.go'] }), {
      goPackageMain: true,
      observedCapabilities: ['NETWORK_SERVER'],
    });
    expect(r.primary_artifact.value).toBe('cli');
    expect(r.interfaces).toContain('http_server');
    expect(r.secondary_roles).toContain('service_component');
  });

  it('a web server with views and a private root is an application; without UI assets it is a service', () => {
    const m = [pkg('package.json', { private: true, dependencies: { express: '^4' } })];
    const app = v2(
      snap({ manifests: m, hasDockerfile: true, treePaths: ['views/index.ejs', 'app.js'] }),
    );
    const svc = v2(snap({ manifests: m, hasDockerfile: true, treePaths: ['app.js'] }));
    expect(app.primary_artifact.value).toBe('application');
    expect(svc.primary_artifact.value).toBe('service');
  });

  it('no structural evidence means unknown with low confidence, not a guess', () => {
    const r = v2(snap({ treePaths: ['index.html', 'style.css'] }));
    expect(r.primary_artifact.value).toBe('unknown');
    expect(r.primary_artifact.confidence).toBeLessThanOrEqual(0.2);
    expect(r.deployment_form.value).toBe('unknown');
  });

  it('uncertainty is structural: alternatives carry their own confidence, semantics stay heuristic_uncalibrated', () => {
    const r = v2(
      snap({
        manifests: [pkg('package.json', { bin: { t: 'b.js' }, main: 'l.js' })],
        treePaths: ['b.js'],
      }),
    );
    expect(r.confidence_semantics).toBe('heuristic_uncalibrated');
    for (const a of r.primary_artifact.alternatives) {
      expect(a.confidence).toBeGreaterThan(0);
      expect(a.confidence).toBeLessThanOrEqual(0.9);
    }
    expect(r.primary_artifact.confidence).toBeLessThanOrEqual(0.9);
  });

  it('a GitHub Action is a plugin deployed as a CI action', () => {
    const r = v2(snap({ hasActionYml: true }));
    expect(r.primary_artifact.value).toBe('plugin');
    expect(r.deployment_form.value).toBe('ci_action');
    expect(r.interfaces).toContain('plugin_interface');
  });
});
