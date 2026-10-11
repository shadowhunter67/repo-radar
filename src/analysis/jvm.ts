import type { ParsedManifest } from '../collectors/manifests/parse.js';
import { AUXILIARY_DIR } from '../util/scope.js';
import { sanitizeForTerminal } from '../util/text.js';
import { children, parseXml, textOf } from '../util/xml.js';
import type { ExecApi } from './exec-api.js';
import { addHookCapabilities, type BuildProject } from './exec-model.js';
import type { Capability, ScannedFile } from './types.js';

/**
 * JVM build-time execution model (Maven and Gradle). Static and conservative: POMs are read with a safe XML reader and
 * Gradle scripts are read as text, never evaluated.
 *
 * Semantics worth stating once:
 *  - Consumers of a published JVM library receive compiled artifacts, so nothing here runs for dependents
 *    (`runs_for_dependents` is false); these hooks describe what building THIS repository from source can execute.
 *  - Maven/Gradle run directly on the host JVM (no PEP 517-style isolation): environment HOST.
 *  - A plugin merely being present is not suspicious. Only plugins known to run commands, download content, execute
 *    scripts, generate code or drive native toolchains are reported, with the capabilities they imply.
 */

interface PluginKind {
  match: RegExp;
  category: 'exec' | 'script' | 'download' | 'native' | 'codegen' | 'scm' | 'dependency';
  caps: Capability[];
}

/** Maven plugins by `groupId:artifactId`. Anything else (compiler, surefire, jar, ...) is ordinary build tooling. */
const MAVEN_PLUGINS: PluginKind[] = [
  { match: /:exec-maven-plugin$/, category: 'exec', caps: ['PROCESS_EXEC'] },
  {
    match: /:maven-antrun-plugin$/,
    category: 'script',
    caps: ['PROCESS_EXEC', 'FILESYSTEM_WRITE'],
  },
  {
    match: /:(?:gmavenplus-plugin|groovy-maven-plugin|gmaven-plugin|maven-groovy-plugin)$/,
    category: 'script',
    caps: ['DYNAMIC_CODE_LOAD', 'PROCESS_EXEC'],
  },
  {
    match: /:frontend-maven-plugin$/,
    category: 'download',
    caps: ['REMOTE_DOWNLOAD', 'PROCESS_EXEC'],
  },
  { match: /:download-maven-plugin$/, category: 'download', caps: ['REMOTE_DOWNLOAD'] },
  { match: /:maven-invoker-plugin$/, category: 'exec', caps: ['PROCESS_EXEC'] },
  {
    match: /:(?:protobuf-maven-plugin|protoc-jar-maven-plugin|maven-protoc-plugin)$/,
    category: 'codegen',
    caps: ['REMOTE_DOWNLOAD', 'PROCESS_EXEC', 'FILESYSTEM_WRITE'],
  },
  {
    match:
      /:(?:native-maven-plugin|nar-maven-plugin|maven-nar-plugin|cmake-maven-plugin|native-image-maven-plugin|native-maven-plugin)$/,
    category: 'native',
    caps: ['PROCESS_EXEC'],
  },
  {
    match:
      /:(?:openapi-generator-maven-plugin|swagger-codegen-maven-plugin|jaxb2-maven-plugin|maven-jaxb2-plugin|antlr4-maven-plugin|jooq-codegen-maven|avro-maven-plugin|xjc-maven-plugin)$/,
    category: 'codegen',
    caps: ['FILESYSTEM_WRITE'],
  },
  {
    match:
      /:(?:git-commit-id-maven-plugin|git-commit-id-plugin|buildnumber-maven-plugin|maven-scm-plugin)$/,
    category: 'scm',
    caps: ['PROCESS_EXEC'],
  },
  {
    match: /:maven-dependency-plugin$/,
    category: 'dependency',
    caps: ['FILESYSTEM_WRITE', 'REMOTE_DOWNLOAD'],
  },
];

/** Gradle task types that execute commands or fetch content. */
const GRADLE_TYPE_CAPS: Record<string, Capability[]> = {
  Exec: ['PROCESS_EXEC'],
  JavaExec: ['PROCESS_EXEC'],
  Download: ['REMOTE_DOWNLOAD', 'NETWORK_CLIENT'],
  AntBuilder: ['PROCESS_EXEC'],
  GradleBuild: [],
  SshTask: ['NETWORK_CLIENT', 'PROCESS_EXEC'],
};

const CORE_GRADLE_PLUGIN =
  /^(?:java|java-library|application|war|ear|maven-publish|publishing|signing|jacoco|checkstyle|pmd|idea|eclipse|base|distribution|groovy|scala|kotlin|java-platform|jvm-test-suite|version-catalog|antlr|cpp-\w+|org\.jetbrains\.kotlin\.[\w.]+|com\.android\.[\w.]+|org\.gradle\.[\w.]+)$/;

const clean = (s: string, n = 120): string => sanitizeForTerminal(s, n);
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export interface JvmInput {
  manifests: ParsedManifest[];
  files: ScannedFile[];
  tree: ReadonlySet<string>;
}

export function analyzeJvm(api: ExecApi, input: JvmInput): { projects: BuildProject[] } {
  const projects: BuildProject[] = [];
  const jvm = input.manifests.filter(
    (m) =>
      m.jvm && (m.jvm.tool === 'maven' || m.jvm.tool === 'gradle') && !AUXILIARY_DIR.test(m.file),
  );

  // Maven extensions are loaded into Maven itself.
  const extensionFile = input.files.find((f) => f.path.endsWith('.mvn/extensions.xml'));
  const extParsed = extensionFile ? parseXml(extensionFile.content) : undefined;
  const extensions = extParsed?.ok
    ? children(extParsed.root, 'extension').map(
        (e) => `${textOf(e, 'groupId') ?? '?'}:${textOf(e, 'artifactId') ?? '?'}`,
      )
    : [];

  for (const m of jvm.slice(0, 20)) {
    const f = m.jvm;
    if (!f) continue;
    const dir = dirOf(m.file);
    const tool = f.tool === 'maven' ? 'maven' : 'gradle';
    const hookStart = api.hooks.length;
    const notes: string[] = [];
    const native = new Set<string>();
    let repoCode = false;

    const buildNode = api.addNode({
      kind: 'command',
      label: `${tool === 'maven' ? 'mvn' : 'gradle'} build ${dir || '.'}`.trim(),
      analyzed: true,
    });
    const projectNode = api.addNode({
      kind: 'backend',
      label: `${tool} build ${clean(m.file, 80)}`,
      file: m.file,
      analyzed: true,
    });
    api.addEdge({
      from: buildNode,
      to: projectNode,
      relation: 'SELECTS_BACKEND',
      stage: 'SOURCE_BUILD',
      trigger_kind: 'BUILD_TOOL_INVOKED',
      confidence: 0.95,
      evidence: [m.file],
    });

    if (f.tool === 'maven') {
      for (const pl of f.plugins) {
        if (pl.managed) continue;
        const key = `${pl.group}:${pl.artifact}`;
        const kind = MAVEN_PLUGINS.find((k) => k.match.test(key));
        if (!kind) continue;
        const pseudo = `${m.file}#plugin.${pl.artifact}`;
        const configCaps = api.scanPseudo(pseudo, pl.config);
        const gated = !!pl.profile && !pl.profileActiveByDefault;
        const phases = [...new Set(pl.executions.map((e) => e.phase).filter(Boolean))] as string[];
        const goals = [...new Set(pl.executions.flatMap((e) => e.goals))];
        if (kind.category === 'native') native.add(pl.artifact);
        if (
          kind.category !== 'dependency' &&
          kind.category !== 'scm' &&
          kind.category !== 'codegen'
        )
          repoCode = true;
        const node = api.addNode({
          kind: 'extension',
          label: `maven plugin ${clean(pl.artifact, 50)}${pl.profile ? ` (profile ${clean(pl.profile, 30)})` : ''}`,
          file: m.file,
          analyzed: true,
        });
        api.addEdge({
          from: projectNode,
          to: node,
          relation: 'BUILDS',
          stage: kind.category === 'native' ? 'NATIVE_BUILD' : 'SOURCE_BUILD',
          trigger_kind: 'BUILD_TOOL_INVOKED',
          confidence: gated ? 0.45 : phases.length > 0 ? 0.85 : 0.6,
          evidence: [m.file],
        });
        api.finishHook(
          {
            id: api.nextHookId(),
            ecosystem: 'maven',
            name: clean(pl.artifact, 60),
            trigger:
              phases.length > 0
                ? `mvn ${phases[0]} (and every later phase) runs this execution`
                : "bound to the goal's default phase when the plugin is configured with executions",
            runs_for_dependents: false,
            context: 'build',
            stage: kind.category === 'native' ? 'NATIVE_BUILD' : 'SOURCE_BUILD',
            trigger_kind: 'BUILD_TOOL_INVOKED',
            environment: 'HOST',
            details: {
              plugin: clean(key, 100),
              category: kind.category,
              ...(phases.length > 0 ? { phases: phases.join(', ') } : {}),
              ...(goals.length > 0 ? { goals: goals.slice(0, 8).join(', ') } : {}),
              ...(pl.profile
                ? {
                    profile: clean(pl.profile, 40),
                    profile_active_by_default: String(!!pl.profileActiveByDefault),
                  }
                : {}),
            },
            unanalyzed_commands: 0,
            node_ids: [buildNode, projectNode, node],
          },
          [pseudo],
          0,
          true,
        );
        const last = api.hooks[api.hooks.length - 1];
        if (last) {
          addHookCapabilities(last, [...kind.caps, ...configCaps]);
          if (gated) last.confidence = Math.round(last.confidence * 0.6 * 100) / 100;
        }
      }
      for (const ext of extensions) {
        repoCode = true;
        notes.push(`.mvn/extensions.xml loads ${clean(ext, 80)} into Maven itself`);
      }
      if (f.parent)
        notes.push(
          `parent POM ${clean(f.parent, 100)} is not resolved: inherited versions, managed dependencies and plugins are not visible`,
        );
      if (f.unresolvedProperties > 0)
        notes.push(
          `${f.unresolvedProperties} property reference(s) could not be resolved from the POM itself`,
        );
    } else {
      // Gradle: tasks and configuration-time code.
      const third = f.gradlePlugins.filter((p) => !CORE_GRADLE_PLUGIN.test(p));
      if (third.length > 0)
        notes.push(
          `${third.length} third-party Gradle plugin(s) run inside the build (${third
            .slice(0, 4)
            .map((p) => clean(p, 40))
            .join(', ')}${third.length > 4 ? ', ...' : ''})`,
        );
      for (const t of f.gradleTasks) {
        const caps = [...(t.type ? (GRADLE_TYPE_CAPS[t.type] ?? []) : [])];
        const wantHook =
          t.phase === 'configuration' ||
          (t.type && t.type in GRADLE_TYPE_CAPS && t.type !== 'GradleBuild');
        if (!wantHook) continue;
        const pseudo = `${m.file}#task.${t.name.replace(/[^\w.-]/g, '_')}`;
        const snippetCaps = api.scanPseudo(pseudo, t.snippet.replace(/\s*\|\s*/g, '\n'));
        repoCode = true;
        const automatic = t.phase === 'configuration' || t.wired;
        const node = api.addNode({
          kind: 'command',
          label: `gradle ${t.phase === 'configuration' ? 'configuration-time code' : `task ${clean(t.name, 40)}`}`,
          file: m.file,
          analyzed: true,
        });
        api.addEdge({
          from: projectNode,
          to: node,
          relation: 'RUNS',
          stage: 'SOURCE_BUILD',
          trigger_kind: automatic ? 'BUILD_TOOL_INVOKED' : 'USER_INVOKED',
          confidence: t.phase === 'configuration' ? 0.65 : t.wired ? 0.7 : 0.5,
          evidence: [`${m.file}:${t.line}`],
        });
        api.finishHook(
          {
            id: api.nextHookId(),
            ecosystem: 'gradle',
            name: t.phase === 'configuration' ? 'configuration-time' : `task:${clean(t.name, 50)}`,
            trigger:
              t.phase === 'configuration'
                ? 'runs while Gradle evaluates the build script, for every gradle invocation (any task)'
                : t.wired
                  ? 'a lifecycle or other task depends on / is finalized by this task, so a normal build runs it'
                  : 'runs when the task is requested explicitly (`gradle <task>`)',
            runs_for_dependents: false,
            context: 'build',
            stage: 'SOURCE_BUILD',
            trigger_kind: automatic ? 'BUILD_TOOL_INVOKED' : 'USER_INVOKED',
            environment: 'HOST',
            details: {
              ...(t.type ? { task_type: t.type } : {}),
              line: String(t.line),
              wired: String(t.wired),
              phase: t.phase,
            },
            unanalyzed_commands: 0,
            node_ids: [buildNode, projectNode, node],
          },
          [pseudo],
          0,
          true,
        );
        const last = api.hooks[api.hooks.length - 1];
        if (last) {
          addHookCapabilities(last, [...caps, ...snippetCaps]);
        }
      }
      for (const url of f.remoteScripts) {
        repoCode = true;
        const node = api.addNode({
          kind: 'command',
          label: `apply from ${clean(url, 80)}`,
          file: m.file,
          analyzed: true,
        });
        api.addEdge({
          from: projectNode,
          to: node,
          relation: 'DOWNLOADS',
          stage: 'SOURCE_BUILD',
          trigger_kind: 'BUILD_TOOL_INVOKED',
          confidence: 0.9,
          evidence: [m.file],
        });
        api.finishHook(
          {
            id: api.nextHookId(),
            ecosystem: 'gradle',
            name: 'remote-script',
            trigger:
              'the build script applies a script downloaded from the network on every gradle invocation',
            runs_for_dependents: false,
            context: 'build',
            stage: 'SOURCE_BUILD',
            trigger_kind: 'BUILD_TOOL_INVOKED',
            environment: 'HOST',
            details: { url: clean(url, 120) },
            unanalyzed_commands: 0,
            node_ids: [buildNode, projectNode, node],
          },
          [],
          0,
          true,
        );
        const last = api.hooks[api.hooks.length - 1];
        if (last) {
          addHookCapabilities(last, ['DYNAMIC_CODE_LOAD', 'NETWORK_CLIENT', 'REMOTE_DOWNLOAD']);
          last.risk = 'high'; // a script fetched from the network and executed on every invocation
        }
      }
      // buildSrc and local applied scripts are repository build logic.
      const buildSrc = [...input.tree].filter(
        (p) =>
          p.startsWith(dir ? `${dir}/buildSrc/` : 'buildSrc/') &&
          /\.(?:kt|kts|groovy|java|gradle)$/.test(p),
      );
      if (buildSrc.length > 0) {
        repoCode = true;
        const visited = new Set<string>();
        let unanalyzed = 0;
        for (const p of buildSrc.slice(0, 8))
          unanalyzed += api.followFile(p, projectNode, 'build', visited, 0, {
            stage: 'SOURCE_BUILD',
            trigger_kind: 'BUILD_TOOL_INVOKED',
            confidence: 0.8,
            evidence: [p],
          }).unanalyzed;
        api.finishHook(
          {
            id: api.nextHookId(),
            ecosystem: 'gradle',
            name: 'buildSrc',
            trigger: 'buildSrc is compiled and loaded into every Gradle build of this repository',
            runs_for_dependents: false,
            context: 'build',
            stage: 'SOURCE_BUILD',
            trigger_kind: 'BUILD_TOOL_INVOKED',
            environment: 'HOST',
            details: { files: String(buildSrc.length) },
            unanalyzed_commands: 0,
            node_ids: [buildNode, projectNode],
          },
          [...visited],
          unanalyzed,
          true,
        );
      }
      notes.push(
        'Gradle dependency versions come from the script text; dynamic logic, plugins, conventions and version catalogs without a lockfile are not resolved',
      );
    }

    // Repositories (build + plugin resolution).
    const insecure = f.repositories.filter((r) => r.insecure);
    for (const r of insecure)
      notes.push(
        `${r.kind === 'plugin_repository' ? 'plugin ' : ''}repository over plain HTTP: ${clean(r.url, 100)}`,
      );
    const custom = f.repositories.filter(
      (r) =>
        !/^standard:|repo\.maven\.apache\.org|repo1\.maven\.org|plugins\.gradle\.org|maven\.google\.com|file:/.test(
          r.url,
        ),
    );
    if (custom.length > 0)
      notes.push(
        `${custom.length} additional repositor${custom.length === 1 ? 'y' : 'ies'} besides the standard ones (${custom
          .slice(0, 2)
          .map((r) => clean(r.url, 60))
          .join(', ')})`,
      );

    // Wrapper properties: the wrapper downloads the build tool itself, so its URL and checksum matter.
    for (const wf of input.files.filter(
      (x) =>
        (x.path.endsWith('maven-wrapper.properties') ||
          x.path.endsWith('gradle-wrapper.properties')) &&
        (dir === '' ? true : x.path.startsWith(`${dir}/`)),
    )) {
      const url = /^distributionUrl\s*=\s*(\S+)/m.exec(wf.content)?.[1]?.replace(/\\:/g, ':');
      const hasSum = /^distributionSha256Sum\s*=\s*\S+/m.test(wf.content);
      if (url && /^http:\/\//i.test(url))
        notes.push(`${wf.path}: build tool is downloaded over plain HTTP (${clean(url, 80)})`);
      if (url && !hasSum)
        notes.push(
          `${wf.path}: the wrapper downloads the build tool without a distributionSha256Sum checksum`,
        );
    }

    projects.push({
      id: `PROJ-${tool === 'maven' ? 'MVN' : 'GRD'}-${String(projects.length + 1).padStart(2, '0')}`,
      ecosystem: tool,
      dir: dir || '.',
      build_system: tool,
      kind: repoCode ? 'known_with_repository_code' : 'known_declarative',
      repository_code_runs: repoCode,
      native_build_systems: [...native].sort(),
      bypassed: [],
      requires: [],
      hook_ids: api.hooks.slice(hookStart).map((h) => h.id),
      notes,
    });
  }
  return { projects };
}
