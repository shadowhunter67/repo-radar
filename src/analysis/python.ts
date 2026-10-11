import { posix } from 'node:path';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import { AUXILIARY_DIR } from '../util/scope.js';
import { sanitizeForTerminal } from '../util/text.js';
import type { ExecApi } from './exec-api.js';
import { addHookCapabilities, type BuildProject, type Entrypoint } from './exec-model.js';
import type { ExecEdge, ExecNode, Hook } from './execution.js';
import { resolvePyModule } from './refs.js';
import type { Capability, ExecContext, RiskLevel, ScannedFile } from './types.js';

/**
 * Python execution model (static; setup.py and backends are NEVER run).
 *
 * It answers: which Python-related code may run automatically while a dependent builds/installs this project from
 * source, which code is merely installed for later use (entry points), which native build systems are involved, and
 * which path connects the metadata (pyproject.toml, setup.py) to the code.
 *
 * Key rules:
 *  - `pip install <sdist or git>` runs the declared PEP 517 build backend; a wheel install runs none of it. Hooks here
 *    therefore describe the SOURCE BUILD path (`runs_for_dependents` = repository-controlled code runs on that path).
 *  - `setup.py` only runs when the backend is setuptools (explicitly, or implicitly when no backend is declared).
 *    Another backend bypasses it and the bypass is recorded instead of reporting a hook.
 *  - `console_scripts` / `gui_scripts` create launchers; the target runs when the USER invokes the command.
 */

export type PythonExecApi = ExecApi;

export interface PythonInput {
  manifests: ParsedManifest[];
  files: ScannedFile[];
  tree: ReadonlySet<string>;
}

export interface PythonResult {
  projects: BuildProject[];
  entrypoints: Omit<Entrypoint, 'id'>[];
}

type BackendFamily =
  'setuptools' | 'declarative' | 'maturin' | 'meson' | 'scikit-build' | 'pdm' | 'poetry' | 'hatch';

const KNOWN_BACKENDS: { match: RegExp; id: string; family: BackendFamily }[] = [
  { match: /^setuptools(?:\.|:|$)/, id: 'setuptools', family: 'setuptools' },
  { match: /^pbr\.build/, id: 'pbr (setuptools)', family: 'setuptools' },
  { match: /^flit_core(?:\.|:|$)|^flit(?:\.|:|$)/, id: 'flit', family: 'declarative' },
  { match: /^hatchling(?:\.|:|$)/, id: 'hatchling', family: 'hatch' },
  { match: /^poetry\.core(?:\.|:|$)|^poetry\.masonry/, id: 'poetry-core', family: 'poetry' },
  { match: /^pdm\.backend|^pdm\.pep517/, id: 'pdm-backend', family: 'pdm' },
  { match: /^maturin(?:\.|:|$)/, id: 'maturin', family: 'maturin' },
  { match: /^mesonpy(?:\.|:|$)/, id: 'meson-python', family: 'meson' },
  { match: /^scikit_build_core(?:\.|:|$)/, id: 'scikit-build-core', family: 'scikit-build' },
  { match: /^uv_build(?:\.|:|$)/, id: 'uv-build', family: 'declarative' },
  {
    match: /^trampolim(?:\.|:|$)|^whey(?:\.|:|$)|^sipbuild/,
    id: 'known declarative',
    family: 'declarative',
  },
];

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (d: string, f: string): string => posix.normalize(d ? `${d}/${f}` : f);
const clean = (s: string, n = 120): string => sanitizeForTerminal(s, n);

const CMDCLASS_BASE =
  /^\s*class\s+(\w+)\s*\(\s*(?:[\w.]*\.)?(build(?:_py|_ext|_clib)?|install(?:_lib|_scripts|_data)?|develop|egg_info|sdist|bdist_wheel|bdist_egg|editable_wheel)\b/gm;
const SETUP_EXT = /\b(?:ext_modules\s*=|Extension\s*\(|cythonize\s*\(|CMakeExtension|build_ext\b)/;
const SETUP_ENTRY = /(console_scripts|gui_scripts)['"]?\s*[:=]\s*\[([^\]]{0,2000})\]/g;

interface Detail {
  [k: string]: string;
}

export function analyzePython(api: PythonExecApi, input: PythonInput): PythonResult {
  const projects: BuildProject[] = [];
  const entrypoints: Omit<Entrypoint, 'id'>[] = [];

  // ---- discover Python projects: a directory with pyproject.toml (build-system), setup.py or setup.cfg -------------------
  const dirs = new Set<string>();
  for (const m of input.manifests)
    if (m.ecosystem === 'PyPI' && m.file.endsWith('pyproject.toml') && m.python)
      dirs.add(dirOf(m.file));
  for (const p of input.tree) if (/(?:^|\/)setup\.py$/.test(p)) dirs.add(dirOf(p));
  const candidates = [...dirs]
    .filter((d) => d.split('/').filter(Boolean).length <= 2 && !AUXILIARY_DIR.test(`${d}/`))
    .sort();

  for (const dir of candidates.slice(0, 12)) {
    const pyproject = input.manifests.find(
      (m) => m.ecosystem === 'PyPI' && m.file === join(dir, 'pyproject.toml') && m.python,
    );
    const facts = pyproject?.python;
    const setupPy = join(dir, 'setup.py');
    const hasSetupPy = input.tree.has(setupPy);
    const setupFile = api.byPath.get(setupPy);
    const setupCfg = api.byPath.get(join(dir, 'setup.cfg'));
    const bypassed: string[] = [];
    const notes: string[] = [];
    const nativeSystems = new Set<string>();
    const hookStart = api.hooks.length;

    // ---- classify the build backend --------------------------------------------------------------------------------
    const declared = facts?.backend;
    const effective = declared ?? 'setuptools.build_meta:__legacy__';
    const known = KNOWN_BACKENDS.find((k) => k.match.test(effective));
    const backendModule = effective.split(':')[0] ?? effective;
    let kind: BuildProject['kind'];
    let inTreeFiles: string[] = [];
    if (!declared) kind = 'legacy_default';
    else if (facts && facts.backendPath.length > 0) {
      // PEP 517: backend-path directories are prepended to sys.path, so the backend module is repository code.
      for (const bp of facts.backendPath) {
        const r = resolvePyModule(backendModule, join(dir, bp), input.tree);
        if (r) inTreeFiles.push(r);
      }
      kind = inTreeFiles.length > 0 ? 'in_tree_custom' : 'external_custom';
      if (kind === 'external_custom')
        notes.push('backend-path is declared but the backend module was not found in the git tree');
    } else if (known) kind = 'known_declarative';
    else kind = 'external_custom';
    inTreeFiles = [...new Set(inTreeFiles)];
    const family = known?.family;
    const hints = new Set(facts?.hints ?? []);

    // ---- which repository files execute ----------------------------------------------------------------------------
    // An in-tree backend that wraps setuptools (very common) still ends up executing setup.py.
    const delegatesToSetuptools = inTreeFiles.some((f) =>
      /setuptools/.test(api.byPath.get(f)?.content ?? ''),
    );
    const setupRuns =
      hasSetupPy &&
      (family === 'setuptools' ||
        !declared ||
        delegatesToSetuptools ||
        (family === 'pdm' && hints.has('pdm-run-setuptools')));
    if (hasSetupPy && !setupRuns) {
      if (kind === 'external_custom')
        notes.push(
          `${setupPy} exists and the external custom backend (${clean(effective, 60)}) may or may not call it; not reported as a hook`,
        );
      else
        bypassed.push(
          `${setupPy} is not run: the declared build backend (${clean(effective, 60)}) does not call setuptools`,
        );
    }
    const buildScripts = (facts?.buildScripts ?? [])
      .map((s) => join(dir, s))
      .filter((p) => input.tree.has(p));
    const customHookPresent = buildScripts.length > 0;
    const setupText = setupFile?.content ?? '';
    const setupExt = setupRuns && SETUP_EXT.test(setupText);

    // ---- native build systems --------------------------------------------------------------------------------------
    if (family === 'maturin' || hints.has('maturin') || hints.has('setuptools-rust'))
      nativeSystems.add('rust (cargo)');
    if (family === 'meson' || hints.has('meson-python') || input.tree.has(join(dir, 'meson.build')))
      if (family === 'meson' || hints.has('meson-python')) nativeSystems.add('meson');
    if (family === 'scikit-build' || hints.has('scikit-build') || hints.has('cmake'))
      nativeSystems.add('cmake');
    const setuptoolsLike = family === 'setuptools' || !declared || delegatesToSetuptools;
    if (setupExt || hints.has('setuptools-ext-modules'))
      nativeSystems.add(
        hints.has('cython') || /cythonize/.test(setupText)
          ? 'c-extension (Cython/setuptools)'
          : 'c-extension (setuptools)',
      );
    else if (hints.has('cython'))
      nativeSystems.add(setuptoolsLike ? 'c-extension (Cython/setuptools)' : 'cython');
    if (hints.has('cffi') || /cffi_modules/.test(setupText)) nativeSystems.add('cffi');

    const repoCode =
      setupRuns || kind === 'in_tree_custom' || customHookPresent || nativeSystems.size > 0;

    // ---- graph + hooks ---------------------------------------------------------------------------------------------
    const pipNode = api.addNode({
      kind: 'command',
      label: `pip install (build from source) ${dir || '.'}`.trim(),
      analyzed: true,
    });
    const hookNodes: string[] = [];
    const evidence = (extra: string[] = []): string[] =>
      [pyproject?.file ?? setupPy, ...extra].slice(0, 4);
    const edge = (
      from: string,
      to: string,
      relation: ExecEdge['relation'],
      stage: ExecEdge['stage'],
      confidence: number,
      ev: string[],
    ): void =>
      api.addEdge({
        from,
        to,
        relation,
        stage,
        trigger_kind: 'BUILD_TOOL_INVOKED',
        confidence,
        evidence: ev,
      });

    const backendNode = api.addNode({
      kind: 'backend',
      label: `PEP 517 backend ${clean(effective, 80)}`,
      ...(pyproject ? { file: pyproject.file } : {}),
      analyzed: true,
    });
    edge(
      pipNode,
      backendNode,
      'SELECTS_BACKEND',
      'BUILD_BACKEND',
      declared ? 0.95 : 0.7,
      evidence(),
    );
    hookNodes.push(backendNode);

    const detailsBase: Detail = {
      backend: clean(effective, 80),
      backend_kind: kind,
      ...(facts && facts.requires.length > 0
        ? {
            build_requires: facts.requires
              .slice(0, 8)
              .map((r) => clean(r, 50))
              .join(', '),
          }
        : {}),
    };

    // (1) the backend hook
    {
      const visited = new Set<string>();
      let unanalyzed = 0;
      for (const f of inTreeFiles) {
        const r = api.followFile(f, backendNode, 'install', visited, 0);
        unanalyzed += r.unanalyzed;
      }
      api.finishHook(
        {
          id: api.nextHookId(),
          ecosystem: 'pypi',
          name: `pep517:${clean(known?.id ?? backendModule, 60)}`,
          trigger:
            'pip install of a source distribution or VCS URL (the PEP 517 backend is imported and its hooks called)',
          runs_for_dependents:
            kind === 'in_tree_custom' || kind === 'external_custom'
              ? kind === 'in_tree_custom'
              : false,
          context: 'install',
          stage: 'BUILD_BACKEND',
          trigger_kind: 'BUILD_TOOL_INVOKED',
          environment: 'BUILD_ENVIRONMENT',
          details: {
            ...detailsBase,
            hooks_modelled:
              'get_requires_for_build_wheel, prepare_metadata_for_build_wheel, build_wheel, build_sdist (not every install path calls each)',
          },
          unanalyzed_commands: 0,
          node_ids: [pipNode, backendNode],
        },
        [...visited],
        unanalyzed,
        true,
      );
    }

    // (2) legacy setup.py
    if (setupRuns) {
      const visited = new Set<string>();
      // setup.py and the local helper modules it imports (they run as part of the same build).
      const followed = api.followFile(setupPy, backendNode, 'install', visited, 0, {
        stage: 'LEGACY_SETUP',
        trigger_kind: 'BUILD_TOOL_INVOKED',
        confidence: declared ? 0.85 : 0.8,
        evidence: evidence([setupPy]),
      });
      const setupNode = followed.node ?? backendNode;
      const unanalyzed = setupFile ? followed.unanalyzed : 1;
      const cmd: string[] = [];
      const cmdclassBody = /cmdclass\s*=\s*\{([^}]{0,800})\}/.exec(setupText)?.[1] ?? '';
      CMDCLASS_BASE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      let guard = 0;
      while ((cm = CMDCLASS_BASE.exec(setupText)) && guard++ < 20) {
        const registered = new RegExp(`\\b${cm[1] as string}\\b`).test(cmdclassBody);
        const cn = api.addNode({
          kind: 'command',
          label: `custom command ${clean(cm[1] as string, 40)} (${clean(cm[2] as string, 20)})`,
          file: setupPy,
          analyzed: true,
        });
        edge(setupNode, cn, 'CONFIGURES', 'LEGACY_SETUP', registered ? 0.7 : 0.4, [setupPy]);
        cmd.push(
          `${cm[1] as string}(${cm[2] as string})${registered ? '' : ' [not seen in cmdclass]'}`,
        );
      }
      api.finishHook(
        {
          id: api.nextHookId(),
          ecosystem: 'pypi',
          name: 'setup.py',
          trigger:
            'pip install of a source distribution or `pip install .` (setuptools executes setup.py)',
          runs_for_dependents: true,
          context: 'install',
          stage: 'LEGACY_SETUP',
          trigger_kind: 'BUILD_TOOL_INVOKED',
          environment: 'BUILD_ENVIRONMENT',
          details: {
            ...detailsBase,
            ...(cmd.length > 0 ? { custom_commands: cmd.slice(0, 8).join(', ') } : {}),
            ...(setupExt ? { extension_modules: 'yes' } : {}),
          },
          unanalyzed_commands: 0,
          node_ids: [pipNode, backendNode, setupNode],
        },
        [...visited],
        unanalyzed,
        !!setupFile,
      );
    }

    // (3) custom build hooks / scripts of declarative backends
    for (const script of buildScripts) {
      const label = hints.has('hatch-custom-hook')
        ? 'hatch:custom-build-hook'
        : hints.has('poetry-build-script')
          ? 'poetry:build-script'
          : 'pdm:setup-script';
      const node = api.addNode({
        kind: 'file',
        label: script,
        file: script,
        analyzed: api.byPath.has(script),
      });
      edge(backendNode, node, 'EXECUTES', 'BUILD_BACKEND', 0.9, evidence([script]));
      const visited = new Set<string>();
      const r = api.followFile(script, backendNode, 'install', visited, 0);
      api.finishHook(
        {
          id: api.nextHookId(),
          ecosystem: 'pypi',
          name: label,
          trigger: 'the declared backend runs this repository script while building from source',
          runs_for_dependents: true,
          context: 'install',
          stage: 'BUILD_BACKEND',
          trigger_kind: 'BUILD_TOOL_INVOKED',
          environment: 'BUILD_ENVIRONMENT',
          details: { ...detailsBase, script: clean(script, 100) },
          unanalyzed_commands: 0,
          node_ids: [pipNode, backendNode, node],
        },
        [...visited],
        r.unanalyzed,
        api.byPath.has(script),
      );
    }

    // (4) native builds
    for (const system of nativeSystems) {
      const nativeFiles: string[] = [];
      for (const f of ['meson.build', 'CMakeLists.txt', 'Cargo.toml', 'build.rs'])
        if (input.tree.has(join(dir, f))) nativeFiles.push(join(dir, f));
      const node = api.addNode({
        kind: 'extension',
        label: `native build: ${system}`,
        analyzed: true,
      });
      edge(backendNode, node, 'BUILDS', 'NATIVE_BUILD', 0.8, evidence(nativeFiles));
      api.finishHook(
        {
          id: api.nextHookId(),
          ecosystem: 'pypi',
          name: `native:${system}`,
          trigger:
            'building from source invokes the native toolchain (compiler, cargo, meson, cmake)',
          runs_for_dependents: true,
          context: 'install',
          stage: 'NATIVE_BUILD',
          trigger_kind: 'BUILD_TOOL_INVOKED',
          environment: 'BUILD_ENVIRONMENT',
          details: {
            ...detailsBase,
            system,
            ...(nativeFiles.length > 0 ? { files: nativeFiles.slice(0, 4).join(', ') } : {}),
          },
          unanalyzed_commands: 0,
          node_ids: [pipNode, backendNode, node],
        },
        nativeFiles.filter((f) => api.byPath.has(f)),
        0,
        true,
      );
      // Native build descriptions are not covered by the language detectors: record what they can do from their text.
      const last = api.hooks[api.hooks.length - 1];
      if (last) {
        const text = nativeFiles.map((f) => api.byPath.get(f)?.content ?? '').join('\n');
        const extra = new Set<Capability>(['PROCESS_EXEC']); // a compiler or build tool is spawned by definition
        if (
          /\b(?:file\s*\(\s*DOWNLOAD|FetchContent_|ExternalProject_Add|subproject\s*\(|wrap-file)/i.test(
            text,
          )
        )
          extra.add('REMOTE_DOWNLOAD');
        addHookCapabilities(last, [...extra]);
        if (last.risk === 'none') last.risk = 'low';
      }
    }

    // ---- entry points (installed launchers; run when the USER invokes them) --------------------------------------
    const addEntry = (
      name: string,
      target: string,
      kindName: Entrypoint['kind'],
      manifest: string,
      trigger: Entrypoint['trigger_kind'],
    ): void => {
      if (entrypoints.length >= 200) return;
      // `module:callable [extras]`: strip the optional extras suffix before resolving.
      const bare = target.replace(/\s*\[[^\]]*\]\s*$/, '');
      const modPath = bare.split(':')[0] ?? '';
      const callable = (bare.split(':')[1] ?? '').split('.')[0] ?? '';
      const file = modPath ? resolvePyModule(modPath, dir, input.tree) : undefined;
      const f = file ? api.byPath.get(file) : undefined;
      const found =
        f && /^[A-Za-z_]\w*$/.test(callable)
          ? new RegExp(
              `^\\s*(?:async\\s+)?(?:def|class)\\s+${callable}\\b|^${callable}\\s*=`,
              'm',
            ).test(f.content)
          : undefined;
      const node = api.addNode({
        kind: 'entrypoint',
        label: `${clean(name, 40)} = ${clean(target, 80)}`,
        ...(file ? { file } : {}),
        analyzed: !!f,
      });
      api.addEdge({
        from: node,
        to: node,
        relation: 'DEFINES',
        stage: 'INSTALL_GENERATED_ENTRYPOINT',
        trigger_kind: trigger,
        confidence: file ? 0.85 : 0.5,
        evidence: [manifest],
      });
      entrypoints.push({
        ecosystem: 'pypi',
        name: clean(name, 60),
        kind: kindName,
        target: clean(target, 120),
        ...(file ? { file } : {}),
        ...(found !== undefined ? { callable_found: found } : {}),
        stage: 'INSTALL_GENERATED_ENTRYPOINT',
        trigger_kind: trigger,
        environment: 'VIRTUAL_ENV',
        automatic: false,
        manifest,
        capabilities: file ? api.scanCapabilities(file) : [],
      });
    };
    if (facts) {
      for (const [n, t] of Object.entries(facts.scripts).slice(0, 40))
        addEntry(n, t, 'console_script', pyproject?.file ?? dir, 'USER_INVOKED');
      for (const [n, t] of Object.entries(facts.guiScripts).slice(0, 20))
        addEntry(n, t, 'gui_script', pyproject?.file ?? dir, 'USER_INVOKED');
      for (const [g, entries] of Object.entries(facts.entryPointGroups).slice(0, 10)) {
        if (g === 'console_scripts' || g === 'gui_scripts') {
          for (const [n, t] of Object.entries(entries).slice(0, 40))
            addEntry(
              n,
              t,
              g === 'gui_scripts' ? 'gui_script' : 'console_script',
              pyproject?.file ?? dir,
              'USER_INVOKED',
            );
        } else
          for (const [n, t] of Object.entries(entries).slice(0, 10))
            addEntry(`${g}:${n}`, t, 'plugin_group', pyproject?.file ?? dir, 'RUNTIME');
      }
    }
    for (const src of [setupFile, setupCfg]) {
      if (!src) continue;
      const text = src.content;
      SETUP_ENTRY.lastIndex = 0;
      let m: RegExpExecArray | null;
      let g = 0;
      while ((m = SETUP_ENTRY.exec(text)) && g++ < 6)
        for (const item of (m[2] as string).split(/[,\n]/)) {
          const em = /^\s*['"]?\s*([\w.-]+)\s*=\s*([\w.]+:[\w.]+)/.exec(item);
          if (em)
            addEntry(
              em[1] as string,
              em[2] as string,
              m[1] === 'gui_scripts' ? 'gui_script' : 'console_script',
              src.path,
              'USER_INVOKED',
            );
        }
      if (src === setupCfg) {
        // setup.cfg: [options.entry_points] console_scripts =\n    name = pkg.mod:func
        const block =
          /console_scripts[ \t]*=[ \t]*\r?\n((?:[ \t]+[\w.-]+[ \t]*=[ \t]*[\w.]+:[\w.]+[ \t]*\r?\n?){1,40})/.exec(
            text,
          );
        for (const line of (block?.[1] ?? '').split('\n')) {
          const em = /^\s*([\w.-]+)\s*=\s*([\w.]+:[\w.]+)/.exec(line);
          if (em)
            addEntry(em[1] as string, em[2] as string, 'console_script', src.path, 'USER_INVOKED');
        }
      }
    }

    const hookIds = api.hooks.slice(hookStart).map((h) => h.id);
    projects.push({
      id: `PROJ-PY-${String(projects.length + 1).padStart(2, '0')}`,
      ecosystem: 'pypi',
      dir: dir || '.',
      build_system: clean(effective, 80),
      kind:
        kind === 'known_declarative' && (customHookPresent || nativeSystems.size > 0 || setupRuns)
          ? 'known_with_repository_code'
          : kind,
      repository_code_runs: repoCode,
      native_build_systems: [...nativeSystems].sort(),
      bypassed,
      requires: (facts?.requires ?? []).map((r) => clean(r, 60)),
      hook_ids: hookIds,
      notes,
    });
    void hookNodes;
  }
  return { projects, entrypoints };
}
