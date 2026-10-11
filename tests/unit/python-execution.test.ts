import { describe, expect, it } from 'vitest';
import { analyzeCode, type CodeAnalysis } from '../../src/analysis/index.js';
import type { FileRole, ScannedFile } from '../../src/analysis/types.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';

const file = (path: string, content: string, role: FileRole = 'build'): ScannedFile => ({
  path,
  content,
  size: content.length,
  role,
});
const toml = (path: string, text: string) => parseManifest(path, text)!;

function run(
  files: ScannedFile[],
  manifests: ReturnType<typeof toml>[],
  extraTree: string[] = [],
): CodeAnalysis {
  return analyzeCode({
    manifests,
    files,
    treePaths: [...files.map((f) => f.path), ...extraTree],
    sourceFilesTotal: files.filter((f) => f.role === 'source').length,
    fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
  });
}
const hook = (a: CodeAnalysis, name: string) => a.execution.hooks.find((h) => h.name === name);
const project = (a: CodeAnalysis, i = 0) => a.execution.projects[i]!;

const PYPROJECT = (backend: string, extra = '', requires = '"x"') =>
  `[build-system]\nrequires = [${requires}]\nbuild-backend = "${backend}"\n[project]\nname = "pkg"\nversion = "1.0"\n${extra}`;

describe('Python build backends', () => {
  it('no pyproject at all: legacy setup.py is run by setuptools (stage LEGACY_SETUP, build-tool invoked, isolated build env)', () => {
    const a = run([file('setup.py', "import subprocess\nsubprocess.call(['make'])\n")], []);
    expect(hook(a, 'setup.py')).toMatchObject({
      ecosystem: 'pypi',
      runs_for_dependents: true,
      context: 'install',
      stage: 'LEGACY_SETUP',
      trigger_kind: 'BUILD_TOOL_INVOKED',
      environment: 'BUILD_ENVIRONMENT',
    });
    expect(hook(a, 'setup.py')?.capabilities).toContain('PROCESS_EXEC');
    expect(project(a)).toMatchObject({ kind: 'legacy_default', repository_code_runs: true });
    expect(hook(a, 'pep517:setuptools')).toBeDefined();
  });

  it('setuptools.build_meta declared: setup.py still runs', () => {
    const a = run(
      [file('setup.py', 'from setuptools import setup\nsetup()\n')],
      [toml('pyproject.toml', PYPROJECT('setuptools.build_meta'))],
    );
    expect(hook(a, 'setup.py')?.runs_for_dependents).toBe(true);
    expect(project(a).build_system).toBe('setuptools.build_meta');
  });

  it.each([
    ['hatchling.build', 'hatchling'],
    ['flit_core.buildapi', 'flit'],
    ['poetry.core.masonry.api', 'poetry-core'],
    ['uv_build', 'uv-build'],
    ['pdm.backend', 'pdm-backend'],
  ])(
    '%s is a known declarative backend: nothing from the repository runs, and a leftover setup.py is bypassed',
    (backend, id) => {
      const a = run(
        [file('setup.py', "import os\nos.system('rm')\n")],
        [toml('pyproject.toml', PYPROJECT(backend))],
      );
      expect(hook(a, 'setup.py')).toBeUndefined();
      expect(hook(a, `pep517:${id}`)).toMatchObject({
        runs_for_dependents: false,
        stage: 'BUILD_BACKEND',
      });
      expect(project(a)).toMatchObject({ kind: 'known_declarative', repository_code_runs: false });
      expect(project(a).bypassed.join(' ')).toMatch(/setup\.py is not run/);
      expect(a.execution.hooks.some((h) => h.runs_for_dependents)).toBe(false);
    },
  );

  it('custom external backend is explicit, not guessed', () => {
    const a = run([], [toml('pyproject.toml', PYPROJECT('some_vendor_backend.build'))]);
    expect(project(a)).toMatchObject({ kind: 'external_custom', repository_code_runs: false });
    expect(hook(a, 'pep517:some_vendor_backend.build')).toBeDefined();
  });

  it('backend-path: an in-tree backend is repository code that runs during the build, with its capabilities', () => {
    const a = run(
      [
        file(
          'backend/mybuild.py',
          "import subprocess\nfrom . import helpers\n\ndef build_wheel(d, c=None, m=None):\n    subprocess.run(['curl', 'https://x.test/a'])\n",
          'build',
        ),
        file(
          'backend/helpers.py',
          "import urllib.request\nurllib.request.urlopen('https://x.test')\n",
          'build',
        ),
      ],
      [
        toml(
          'pyproject.toml',
          PYPROJECT('mybuild', '', '"setuptools"').replace(
            'build-backend = "mybuild"',
            'build-backend = "mybuild"\nbackend-path = ["backend"]',
          ),
        ),
      ],
    );
    expect(project(a)).toMatchObject({ kind: 'in_tree_custom', repository_code_runs: true });
    const h = hook(a, 'pep517:mybuild')!;
    expect(h).toMatchObject({
      runs_for_dependents: true,
      stage: 'BUILD_BACKEND',
      environment: 'BUILD_ENVIRONMENT',
    });
    expect(h.capabilities).toEqual(expect.arrayContaining(['PROCESS_EXEC']));
    expect(h.files).toEqual(expect.arrayContaining(['backend/mybuild.py', 'backend/helpers.py']));
    const edges = a.execution.graph.edges.filter((e) => e.relation === 'SELECTS_BACKEND');
    expect(edges[0]).toMatchObject({ stage: 'BUILD_BACKEND', trigger_kind: 'BUILD_TOOL_INVOKED' });
    expect(
      a.capabilities.detections
        .filter((d) => d.file === 'backend/mybuild.py')
        .every((d) => d.contexts.includes('install')),
    ).toBe(true);
  });

  it('backend-path without the module in the tree is not treated as in-tree code', () => {
    const a = run(
      [],
      [
        toml(
          'pyproject.toml',
          PYPROJECT('ghost').replace(
            'build-backend = "ghost"',
            'build-backend = "ghost"\nbackend-path = ["nowhere"]',
          ),
        ),
      ],
    );
    expect(project(a).kind).toBe('external_custom');
    expect(project(a).notes.join(' ')).toMatch(/not found in the git tree/);
  });
});

describe('custom build hooks of declarative backends', () => {
  it('hatch custom build hook, poetry build script and pdm setup script are repository code', () => {
    const hatch = run(
      [file('hatch_build.py', 'import subprocess\nsubprocess.run(["make"])\n')],
      [toml('pyproject.toml', PYPROJECT('hatchling.build', '[tool.hatch.build.hooks.custom]\n'))],
    );
    expect(hook(hatch, 'hatch:custom-build-hook')).toMatchObject({ runs_for_dependents: true });
    expect(project(hatch)).toMatchObject({
      kind: 'known_with_repository_code',
      repository_code_runs: true,
    });

    const poetry = run(
      [file('build.py', 'import os\nos.system("cc x.c")\n')],
      [
        toml(
          'pyproject.toml',
          '[tool.poetry]\nname="p"\nversion="1"\nbuild = "build.py"\n[build-system]\nrequires=["poetry-core"]\nbuild-backend="poetry.core.masonry.api"\n',
        ),
      ],
    );
    expect(hook(poetry, 'poetry:build-script')?.capabilities).toContain('PROCESS_EXEC');

    const pdm = run(
      [file('build.py', 'x = 1\n')],
      [
        toml(
          'pyproject.toml',
          PYPROJECT('pdm.backend', '[tool.pdm.build]\nsetup-script = "build.py"\n'),
        ),
      ],
    );
    expect(hook(pdm, 'pdm:setup-script')).toBeDefined();
  });

  it('a hatch hook declared but whose file is missing is still reported as unanalyzed, not hidden', () => {
    const a = run(
      [],
      [
        toml(
          'pyproject.toml',
          PYPROJECT(
            'hatchling.build',
            '[tool.hatch.build.hooks.custom]\npath = "scripts_build.py"\n',
          ),
        ),
      ],
      [],
    );
    expect(hook(a, 'hatch:custom-build-hook')).toBeUndefined(); // the file is not in the tree: nothing to analyze
  });
});

describe('native builds', () => {
  it('maturin / meson-python / scikit-build-core / setuptools extensions are detected with their implications', () => {
    const maturin = run(
      [],
      [toml('pyproject.toml', PYPROJECT('maturin', '[tool.maturin]\nmodule-name="x"\n'))],
      ['Cargo.toml', 'build.rs'],
    );
    expect(hook(maturin, 'native:rust (cargo)')).toMatchObject({
      stage: 'NATIVE_BUILD',
      runs_for_dependents: true,
      environment: 'BUILD_ENVIRONMENT',
    });

    const meson = run(
      [file('meson.build', "project('x')\nrun_command('python', 'gen.py')\nsubproject('dep')\n")],
      [toml('pyproject.toml', PYPROJECT('mesonpy', '', '"meson-python"'))],
    );
    const nm = hook(meson, 'native:meson')!;
    expect(nm.capabilities).toEqual(expect.arrayContaining(['PROCESS_EXEC', 'REMOTE_DOWNLOAD']));

    const sk = run(
      [
        file(
          'CMakeLists.txt',
          'include(FetchContent)\nFetchContent_Declare(x URL https://x.test/x.zip)\nexecute_process(COMMAND git rev-parse HEAD)\n',
        ),
      ],
      [toml('pyproject.toml', PYPROJECT('scikit_build_core.build', '', '"scikit-build-core"'))],
    );
    expect(hook(sk, 'native:cmake')?.capabilities).toContain('REMOTE_DOWNLOAD');
    expect(project(sk).native_build_systems).toEqual(['cmake']);

    const ext = run(
      [
        file(
          'setup.py',
          "from setuptools import setup, Extension\nsetup(ext_modules=[Extension('a', ['a.c'])])\n",
        ),
      ],
      [],
    );
    expect(project(ext).native_build_systems[0]).toMatch(/c-extension/);
    expect(hook(ext, 'native:c-extension (setuptools)')).toBeDefined();
  });

  it('a pure-Python declarative project has no native hook (false-positive check)', () => {
    const a = run([], [toml('pyproject.toml', PYPROJECT('hatchling.build'))]);
    expect(a.execution.hooks.some((h) => h.stage === 'NATIVE_BUILD')).toBe(false);
    expect(project(a).native_build_systems).toEqual([]);
  });
});

describe('custom setuptools commands', () => {
  it('cmdclass overrides are recorded on the setup.py hook and in the graph, with lower confidence than the hook itself', () => {
    const setup = `from setuptools import setup\nfrom setuptools.command.build_ext import build_ext\nimport subprocess\n\nclass MyBuild(build_ext):\n    def run(self):\n        subprocess.check_call(['make'])\n        super().run()\n\nclass Unused(build_ext):\n    pass\n\nsetup(cmdclass={'build_ext': MyBuild}, ext_modules=[])\n`;
    const a = run([file('setup.py', setup)], []);
    const h = hook(a, 'setup.py')!;
    expect(h.details?.['custom_commands']).toContain('MyBuild(build_ext)');
    expect(h.details?.['custom_commands']).toContain('Unused(build_ext) [not seen in cmdclass]');
    const cfg = a.execution.graph.edges.filter((e) => e.relation === 'CONFIGURES');
    expect(cfg.map((e) => e.confidence)).toEqual(expect.arrayContaining([0.7, 0.4]));
    expect(h.capabilities).toContain('PROCESS_EXEC');
  });
});

describe('entry points are installed launchers, never install-time execution', () => {
  const pyproject = PYPROJECT(
    'hatchling.build',
    '[project.scripts]\ntool = "pkg.cli:main"\nmissing = "pkg.nowhere:run"\n[project.gui-scripts]\ngui = "pkg.gui:start"\n[project.entry-points."pytest11"]\nplug = "pkg.plugin"\n',
  );
  const files = [
    file('pkg/cli.py', "import subprocess\n\ndef main():\n    subprocess.run(['ls'])\n", 'source'),
    file('pkg/gui.py', 'def other():\n    pass\n', 'source'),
  ];

  it('console_scripts/gui_scripts become entrypoints with USER_INVOKED trigger and automatic=false', () => {
    const a = run(files, [toml('pyproject.toml', pyproject)]);
    const eps = a.execution.entrypoints;
    const tool = eps.find((e) => e.name === 'tool')!;
    expect(tool).toMatchObject({
      ecosystem: 'pypi',
      kind: 'console_script',
      target: 'pkg.cli:main',
      file: 'pkg/cli.py',
      callable_found: true,
      stage: 'INSTALL_GENERATED_ENTRYPOINT',
      trigger_kind: 'USER_INVOKED',
      environment: 'VIRTUAL_ENV',
      automatic: false,
    });
    expect(tool.capabilities).toContain('PROCESS_EXEC');
    expect(eps.find((e) => e.name === 'gui')).toMatchObject({
      kind: 'gui_script',
      callable_found: false,
    });
    expect(eps.find((e) => e.name === 'missing')?.file).toBeUndefined();
    expect(eps.find((e) => e.name === 'pytest11:plug')).toMatchObject({
      kind: 'plugin_group',
      trigger_kind: 'RUNTIME',
    });
  });

  it('the subprocess inside the entry point is NOT install-time execution and creates no automatic hook', () => {
    const a = run(files, [toml('pyproject.toml', pyproject)]);
    expect(a.execution.hooks.some((h) => h.runs_for_dependents)).toBe(false);
    const d = a.capabilities.detections.find(
      (x) => x.file === 'pkg/cli.py' && x.capability === 'PROCESS_EXEC',
    );
    expect(d?.contexts).toEqual(['runtime']);
  });

  it('setup.cfg and setup.py entry points are understood too', () => {
    const cfg = file(
      'setup.cfg',
      '[options.entry_points]\nconsole_scripts =\n    one = pkg.a:main\n    two = pkg.b:run\n',
    );
    const a = run(
      [
        file('setup.py', 'from setuptools import setup\nsetup()\n'),
        cfg,
        file('pkg/a.py', 'def main():\n    pass\n', 'source'),
      ],
      [],
    );
    expect(a.execution.entrypoints.map((e) => e.name).sort()).toEqual(['one', 'two']);
    const b = run(
      [
        file(
          'setup.py',
          "from setuptools import setup\nsetup(entry_points={'console_scripts': ['x = pkg.m:go']})\n",
        ),
      ],
      [],
    );
    expect(b.execution.entrypoints[0]).toMatchObject({
      name: 'x',
      target: 'pkg.m:go',
      automatic: false,
    });
  });

  it('npm bin entries are entrypoints as well, not lifecycle hooks', () => {
    const a = run(
      [file('bin/cli.js', 'const cp = require("child_process"); cp.exec("ls");\n', 'source')],
      [parseManifest('package.json', JSON.stringify({ name: 'x', bin: { x: './bin/cli.js' } }))!],
    );
    expect(a.execution.entrypoints[0]).toMatchObject({
      ecosystem: 'npm',
      kind: 'bin',
      file: 'bin/cli.js',
      trigger_kind: 'USER_INVOKED',
      automatic: false,
    });
    expect(a.execution.hooks).toEqual([]);
  });
});

describe('Python false positives and scope', () => {
  it('setup.py inside tests/fixtures/examples is an independent project and is ignored', () => {
    const a = run(
      [file('tests/fixtures/demo/setup.py', "import os\nos.system('x')\n")],
      [toml('tests/fixtures/demo/pyproject.toml', PYPROJECT('setuptools.build_meta'))],
    );
    expect(a.execution.hooks).toEqual([]);
    expect(a.execution.projects).toEqual([]);
  });

  it('documentation containing a setup.py snippet or "pip install" text is not a build path', () => {
    const a = run(
      [
        file(
          'docs/guide.md',
          'Run `python setup.py install`\n```\nsubprocess.run(["x"])\n```\n',
          'ref',
        ),
      ],
      [],
    );
    expect(a.execution.hooks).toEqual([]);
    expect(a.execution.projects).toEqual([]);
  });

  it('a project that only has runtime subprocess use in its package has no automatic build code', () => {
    const a = run(
      [file('pkg/run.py', "import subprocess\nsubprocess.run(['git'])\n", 'source')],
      [toml('pyproject.toml', PYPROJECT('hatchling.build'))],
    );
    expect(a.execution.hooks.some((h) => h.runs_for_dependents)).toBe(false);
    expect(project(a).repository_code_runs).toBe(false);
  });

  it('build dependencies stay a separate relationship in the dependency model', () => {
    const m = toml(
      'pyproject.toml',
      PYPROJECT('setuptools.build_meta', '', '"setuptools>=61", "wheel"'),
    );
    expect(m.rawDeps?.filter((d) => d.relationship === 'build').map((d) => d.name)).toEqual([
      'setuptools',
      'wheel',
    ]);
    const a = run([file('setup.py', 'x=1\n')], [m]);
    expect(project(a).requires).toEqual(['setuptools>=61', 'wheel']);
  });
});

describe('regressions found by real-repository probes (Pillow, numpy, black)', () => {
  it('an in-tree backend that wraps setuptools still runs setup.py (no bypass claim)', () => {
    const a = run(
      [
        file(
          '_custom_build/backend.py',
          'from setuptools import build_meta as _orig\nbuild_wheel = _orig.build_wheel\n',
        ),
        file('setup.py', 'from setuptools import setup\nsetup()\n'),
      ],
      [
        toml(
          'pyproject.toml',
          PYPROJECT('backend').replace(
            'build-backend = "backend"',
            'build-backend = "backend"\nbackend-path = ["_custom_build"]',
          ),
        ),
      ],
    );
    expect(hook(a, 'setup.py')).toMatchObject({ runs_for_dependents: true, stage: 'LEGACY_SETUP' });
    expect(project(a).bypassed).toEqual([]);
    expect(project(a).kind).toBe('in_tree_custom');
  });

  it('an in-tree backend that does NOT touch setuptools bypasses setup.py', () => {
    const a = run(
      [file('_b/backend.py', 'def build_wheel(*a):\n    pass\n'), file('setup.py', 'x = 1\n')],
      [
        toml(
          'pyproject.toml',
          PYPROJECT('backend').replace(
            'build-backend = "backend"',
            'build-backend = "backend"\nbackend-path = ["_b"]',
          ),
        ),
      ],
    );
    expect(hook(a, 'setup.py')).toBeUndefined();
    expect(project(a).bypassed.join(' ')).toMatch(/setup\.py is not run/);
  });

  it('an unknown external backend next to a setup.py: not claimed as a hook, not claimed as bypassed either', () => {
    const a = run(
      [file('setup.py', 'x = 1\n')],
      [toml('pyproject.toml', PYPROJECT('vendor_backend'))],
    );
    expect(hook(a, 'setup.py')).toBeUndefined();
    expect(project(a).bypassed).toEqual([]);
    expect(project(a).notes.join(' ')).toMatch(/may or may not call it/);
  });

  it('Cython in the requirements of a meson-python build is "cython", not a setuptools extension', () => {
    const a = run(
      [],
      [toml('pyproject.toml', PYPROJECT('mesonpy', '', '"meson-python", "Cython"'))],
    );
    expect(project(a).native_build_systems).toEqual(['cython', 'meson']);
  });

  it('entry-point targets with an extras suffix resolve to their module', () => {
    const a = run(
      [file('blackd/__init__.py', 'def patched_main():\n    pass\n', 'source')],
      [
        toml(
          'pyproject.toml',
          PYPROJECT('hatchling.build', '[project.scripts]\nblackd = "blackd:patched_main [d]"\n'),
        ),
      ],
    );
    expect(a.execution.entrypoints[0]).toMatchObject({
      file: 'blackd/__init__.py',
      callable_found: true,
    });
  });
});
