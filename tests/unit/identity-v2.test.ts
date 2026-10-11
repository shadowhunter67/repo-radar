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
const src = (path: string, content: string) => ({
  path,
  content,
  size: content.length,
  role: 'source' as const,
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
    const prog = v2(snap({ manifests: [go], treePaths: ['x.go'] }), {
      files: [src('main.go', 'package main\n\nfunc main() {}\n')],
    });
    const lib = v2(snap({ manifests: [go], treePaths: ['x.go'] }), {
      files: [src('x.go', 'package x\n')],
    });
    expect(prog.primary_artifact.value).toBe('cli');
    expect(lib.primary_artifact.value).toBe('library');
  });

  it('a program with a command-line parser that can also serve stays a CLI; the server is exposed as a secondary role', () => {
    const go = parseManifest('go.mod', 'module example.com/x\n\ngo 1.22\n')!;
    const r = v2(snap({ manifests: [go], hasDockerfile: true, treePaths: ['main.go'] }), {
      files: [
        src(
          'main.go',
          'package main\n\nfunc main() { flag.Parse(); http.ListenAndServe(":80", nil) }\n',
        ),
      ],
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

describe('identity v2: evidence hierarchy and structural reasoning', () => {
  const fw = [
    src(
      'lib/server.js',
      "const app = require('x');\napp.register(plugin);\napp.addHook('onRequest', f);\nrouter.get('/a', h);\nserver.listen({ port: 3000 });\nmiddleware.use(m);\n",
    ),
  ];

  it('a package with a server bootstrap AND an extension surface (routing, middleware, plugin, hooks) is a framework, not a library', () => {
    const r = v2(
      snap({
        manifests: [pkg('package.json', { main: 'fastify.js' })],
        treePaths: ['fastify.js', 'lib/server.js'],
      }),
      { files: fw },
    );
    expect(r.primary_artifact.value).toBe('framework');
    expect(r.interfaces).toContain('plugin_interface');
    expect(r.primary_artifact.evidence_strength.strong).toBeGreaterThanOrEqual(3);
  });

  it('a plain client library with no server bootstrap stays a library', () => {
    const r = v2(
      snap({ manifests: [pkg('package.json', { main: 'index.js' })], treePaths: ['index.js'] }),
      {
        files: [
          src(
            'lib/client.js',
            'function request(url) { return fetch(url); }\nmodule.exports = { request, register: 1 };\n',
          ),
        ],
      },
    );
    expect(r.primary_artifact.value).toBe('library');
  });

  it('a Cargo project with a src/bin/<name>/main.rs target is a CLI whose library surface is a secondary role', () => {
    const cargo = parseManifest(
      'Cargo.toml',
      '[package]\nname = "tool"\nversion = "1.0.0"\n\n[lib]\nname = "tool"\n',
    )!;
    const r = v2(
      snap({
        manifests: [cargo],
        treePaths: ['src/lib.rs', 'src/bin/tool/main.rs', 'src/bin/tool/cli.rs'],
      }),
    );
    expect(r.primary_artifact.value).toBe('cli');
    expect(r.secondary_roles).toContain('library_api');
    expect(r.interfaces).toEqual(expect.arrayContaining(['cli', 'library_api']));
  });

  it('a Dockerfile alone is a deployment form, never the identity of a repository that has code', () => {
    const go = parseManifest('go.mod', 'module example.com/x\n\ngo 1.22\n')!;
    const r = v2(
      snap({ manifests: [go], hasDockerfile: true, treePaths: ['main.go', 'Dockerfile'] }),
      {
        files: [src('main.go', 'package main\nfunc main() {}\n')],
      },
    );
    expect(r.primary_artifact.value).not.toBe('container');
    expect(r.deployment_form.supported).toContain('container');
    const image = v2(snap({ hasDockerfile: true, treePaths: ['Dockerfile', 'README.md'] }));
    expect(image.primary_artifact.value).toBe('container');
  });

  it('a C project without manifests but with src/main.c is a program, and a *-server.c entry points to a service', () => {
    const jq = v2(
      snap({
        hasDockerfile: true,
        treePaths: ['src/main.c', 'src/jv.c', 'configure.ac', 'Dockerfile'],
      }),
    );
    expect(jq.primary_artifact.value).toBe('cli');
    const srv = v2(
      snap({ treePaths: ['src/server.c', 'src/redis-cli.c', 'src/util.c', 'Makefile'] }),
    );
    expect(srv.primary_artifact.value).toBe('service');
    expect(srv.secondary_roles).toContain('cli_interface');
  });

  it('weak evidence alone (the keyword hint) never yields a clear answer', () => {
    const r = v2(
      snap({
        description: 'A web framework for http servers',
        topics: ['web-framework', 'http-server'],
        treePaths: ['README.md'],
      }),
    );
    expect(r.primary_artifact.status).not.toBe('clear');
    expect(r.primary_artifact.value).toBe('unknown');
  });

  it('close top candidates are reported as ambiguous, not forced', () => {
    const r = v2(
      snap({
        manifests: [pkg('package.json', { bin: { t: 'b.js' }, main: 'l.js' })],
        treePaths: ['b.js'],
      }),
    );
    expect(['ambiguous', 'clear']).toContain(r.primary_artifact.status);
    if (r.primary_artifact.status === 'ambiguous')
      expect(r.primary_artifact.alternatives.length).toBeGreaterThan(0);
  });
});
