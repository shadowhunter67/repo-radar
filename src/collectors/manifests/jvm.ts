import { parse as parseToml } from 'smol-toml';
import { child, children, parseXml, textOf, type XmlNode } from '../../util/xml.js';
import type { ParsedManifest, RawDependency, RawRelationship } from './parse.js';

/**
 * Static reading of Maven POMs, Gradle build scripts (text only, never evaluated), settings files and version catalogs.
 * Gradle scripts are programs: everything extracted from them is a bounded, heuristic reading with explicit confidence,
 * and anything that cannot be resolved without running Gradle stays unresolved.
 */

export interface JvmPlugin {
  group: string;
  artifact: string;
  version?: string;
  executions: { id?: string; phase?: string; goals: string[] }[];
  /** Flattened plugin configuration text (bounded), scanned for commands and URLs. */
  config: string;
  /** Declared under pluginManagement (configuration only: not executed unless also used in build/plugins). */
  managed: boolean;
  /** Profile id when declared inside a profile. */
  profile?: string;
  profileActiveByDefault?: boolean;
}

export interface GradleTask {
  name: string;
  /** `Exec`, `JavaExec`, `Download`, ... when the task is created with an explicit type. */
  type?: string;
  /** configuration: runs while Gradle evaluates the build; execution: only when the task runs; unknown: not decidable. */
  phase: 'configuration' | 'execution' | 'unknown';
  /** Another task / lifecycle task depends on or is finalized by it (so it runs as part of a normal build). */
  wired: boolean;
  line: number;
  snippet: string;
}

export interface JvmFacts {
  tool: 'maven' | 'gradle' | 'gradle-settings' | 'version-catalog';
  coordinates?: { group?: string; artifact?: string; version?: string; packaging?: string };
  parent?: string;
  modules: string[];
  repositories: { url: string; kind: 'repository' | 'plugin_repository'; insecure: boolean }[];
  plugins: JvmPlugin[];
  profiles: { id: string; activeByDefault: boolean }[];
  /** Maven extensions (.mvn/extensions.xml) load code into the build itself. */
  extensions: string[];
  gradlePlugins: string[];
  gradleTasks: GradleTask[];
  /** `apply from: "<remote url>"`: a remote script executed by the build. */
  remoteScripts: string[];
  /** Version-catalog aliases (dots normalized) -> `group:artifact:version`. */
  catalog: Record<string, string>;
  /** `${property}` references that could not be resolved from the POM's own properties. */
  unresolvedProperties: number;
  includedBuilds: string[];
}

const MAX_LINES = 6000;
const MAX_LINE = 2000;
const MAX_DEPS = 2000;
const GROUP_DEFAULT = 'org.apache.maven.plugins';

const flat = (n: XmlNode | undefined, depth = 0): string => {
  if (!n || depth > 8) return '';
  const own = n.text ? `${n.name}=${n.text}` : '';
  return [own, ...n.children.map((c) => flat(c, depth + 1))].filter(Boolean).join('\n');
};

const relationshipForMaven = (scope: string | undefined): RawRelationship =>
  scope === 'test' ? 'test' : scope === 'provided' || scope === 'import' ? 'build' : 'runtime';

/** Maven POM -> manifest. Returns undefined when the document is not a safely readable POM. */
export function parsePom(file: string, text: string): ParsedManifest | undefined {
  const r = parseXml(text);
  if (!r.ok || r.root.name !== 'project') return undefined;
  const p = r.root;
  const props: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const c of child(p, 'properties')?.children ?? []) if (c.text) props[c.name] = c.text;
  const groupId = textOf(p, 'groupId') ?? textOf(child(p, 'parent'), 'groupId');
  const version = textOf(p, 'version') ?? textOf(child(p, 'parent'), 'version');
  const artifactId = textOf(p, 'artifactId');
  if (artifactId) props['project.artifactId'] = artifactId;
  if (groupId) props['project.groupId'] = groupId;
  if (version) props['project.version'] = version;
  let unresolved = 0;
  const sub = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    let out = s;
    for (let i = 0; i < 3 && out.includes('${'); i++)
      out = out.replace(/\$\{([^}]{1,100})\}/g, (m, k: string) => props[k] ?? m);
    if (out.includes('${')) unresolved++;
    return out;
  };

  const raw: RawDependency[] = [];
  const addDeps = (list: XmlNode | undefined, managed: boolean): void => {
    for (const d of children(list, 'dependency').slice(0, MAX_DEPS)) {
      const g = sub(textOf(d, 'groupId'));
      const a = sub(textOf(d, 'artifactId'));
      if (!g || !a) continue;
      const scope = textOf(d, 'scope');
      // dependencyManagement entries only constrain versions; import-scope BOMs are build-time inputs.
      if (managed && scope !== 'import') continue;
      raw.push({
        name: `${g}:${a}`,
        spec: sub(textOf(d, 'version')) ?? '',
        relationship: textOf(d, 'optional') === 'true' ? 'optional' : relationshipForMaven(scope),
        direct: true,
      });
    }
  };
  addDeps(child(p, 'dependencies'), false);
  addDeps(child(child(p, 'dependencyManagement'), 'dependencies'), true);

  const facts: JvmFacts = {
    tool: 'maven',
    coordinates: {
      ...(groupId ? { group: groupId } : {}),
      ...(artifactId ? { artifact: artifactId } : {}),
      ...(version ? { version } : {}),
      ...(textOf(p, 'packaging') ? { packaging: textOf(p, 'packaging') as string } : {}),
    },
    ...(child(p, 'parent')
      ? {
          parent: `${textOf(child(p, 'parent'), 'groupId') ?? '?'}:${textOf(child(p, 'parent'), 'artifactId') ?? '?'}:${textOf(child(p, 'parent'), 'version') ?? '?'}`,
        }
      : {}),
    modules: children(child(p, 'modules'), 'module')
      .map((m) => m.text)
      .filter(Boolean)
      .slice(0, 200),
    repositories: [],
    plugins: [],
    profiles: [],
    extensions: [],
    gradlePlugins: [],
    gradleTasks: [],
    remoteScripts: [],
    catalog: {},
    unresolvedProperties: 0,
    includedBuilds: [],
  };
  const addRepos = (
    parent: XmlNode | undefined,
    kind: 'repository' | 'plugin_repository',
  ): void => {
    for (const rep of [
      ...children(parent, 'repository'),
      ...children(parent, 'pluginRepository'),
    ].slice(0, 50)) {
      const url = sub(textOf(rep, 'url'));
      if (url)
        facts.repositories.push({
          url: url.slice(0, 300),
          kind,
          insecure: /^http:\/\//i.test(url),
        });
    }
  };
  addRepos(child(p, 'repositories'), 'repository');
  addRepos(child(p, 'pluginRepositories'), 'plugin_repository');

  const readPlugins = (
    build: XmlNode | undefined,
    profile?: { id: string; activeByDefault: boolean },
  ): void => {
    const collect = (list: XmlNode | undefined, managed: boolean): void => {
      for (const pl of children(list, 'plugin').slice(0, 100)) {
        const artifact = sub(textOf(pl, 'artifactId'));
        if (!artifact) continue;
        const executions = children(child(pl, 'executions'), 'execution')
          .slice(0, 30)
          .map((e) => ({
            ...(textOf(e, 'id') ? { id: textOf(e, 'id') as string } : {}),
            ...(textOf(e, 'phase') ? { phase: textOf(e, 'phase') as string } : {}),
            goals: children(child(e, 'goals'), 'goal')
              .map((g) => g.text)
              .filter(Boolean)
              .slice(0, 20),
          }));
        facts.plugins.push({
          group: sub(textOf(pl, 'groupId')) ?? GROUP_DEFAULT,
          artifact,
          ...(sub(textOf(pl, 'version')) ? { version: sub(textOf(pl, 'version')) as string } : {}),
          executions,
          config: sub(flat(child(pl, 'configuration')))?.slice(0, 4000) ?? '',
          managed,
          ...(profile
            ? { profile: profile.id, profileActiveByDefault: profile.activeByDefault }
            : {}),
        });
      }
    };
    collect(child(build, 'plugins'), false);
    collect(child(child(build, 'pluginManagement'), 'plugins'), true);
  };
  readPlugins(child(p, 'build'));
  for (const prof of children(child(p, 'profiles'), 'profile').slice(0, 40)) {
    const id = textOf(prof, 'id') ?? '(unnamed)';
    const act = child(prof, 'activation');
    const meta = { id, activeByDefault: textOf(act, 'activeByDefault') === 'true' };
    facts.profiles.push(meta);
    readPlugins(child(prof, 'build'), meta);
    addDeps(child(prof, 'dependencies'), false);
    for (const m of children(child(prof, 'modules'), 'module'))
      if (m.text) facts.modules.push(m.text);
  }
  facts.unresolvedProperties = unresolved;

  const m: ParsedManifest = {
    file,
    ecosystem: 'Maven',
    keywords: [],
    dependencies: raw
      .filter((d) => d.relationship === 'runtime')
      .map((d) => ({ name: d.name, spec: d.spec })),
    devDependencyCount: raw.filter((d) => d.relationship === 'test').length,
    devDependencyNames: raw.filter((d) => d.relationship === 'test').map((d) => d.name),
    entrypoints: [],
    isPrivate: false,
    rawDeps: raw.slice(0, MAX_DEPS),
    jvm: facts,
  };
  const name = textOf(p, 'name') ?? artifactId;
  const description = textOf(p, 'description');
  if (name) m.name = name;
  if (description) m.description = description;
  return m;
}

/** `.mvn/extensions.xml`: extensions are loaded into Maven itself. */
export function parseMavenExtensions(text: string): string[] {
  const r = parseXml(text);
  if (!r.ok) return [];
  return children(r.root, 'extension')
    .map(
      (e) =>
        `${textOf(e, 'groupId') ?? '?'}:${textOf(e, 'artifactId') ?? '?'}:${textOf(e, 'version') ?? '?'}`,
    )
    .slice(0, 50);
}

/* ---- Gradle ------------------------------------------------------------------------------------------------------ */

const CONFIG_REL: [RegExp, RawRelationship][] = [
  [/^classpath$/, 'build'],
  [/^(?:test|androidTest|integrationTest|functionalTest)\w*$/i, 'test'],
  [/^(?:compileOnly|annotationProcessor|kapt|ksp|testAnnotationProcessor)$/, 'build'],
  [/^developmentOnly$/, 'development'],
  [
    /^(?:implementation|api|runtimeOnly|compile|runtime|\w*Implementation|\w*Api|\w*RuntimeOnly)$/,
    'runtime',
  ],
];
const DEP_CONFIG =
  /^\s*(classpath|(?:test|androidTest|integrationTest|functionalTest)\w*|compileOnly|annotationProcessor|kapt|ksp|developmentOnly|implementation|api|runtimeOnly|compile|runtime|\w*Implementation|\w*Api|\w*RuntimeOnly)\b\s*[( ]\s*(.{0,400})$/;
const COORD = /["']([\w.-]+:[\w.-]+(?::[^"':\s]+)?)(?::[\w.-]+)?["']/;
const NAMED_DEP =
  /group\s*[=:]\s*["']([\w.-]+)["'][^)]{0,200}?name\s*[=:]\s*["']([\w.-]+)["'](?:[^)]{0,200}?version\s*[=:]\s*["']([^"']+)["'])?/;
const GRADLE_PLUGIN_ID =
  /(?:^|\s)id\s*[( ]\s*["']([\w.:-]+)["']|apply\s+plugin\s*:\s*["']([\w.:-]+)["']|apply\s*\(\s*plugin\s*=\s*["']([\w.:-]+)["']/;
const TASK_TYPES =
  /\b(Exec|JavaExec|Download|Copy|Delete|Sync|Zip|Tar|Jar|Test|GradleBuild|AntBuilder|SshTask)\b/;

export function stripGradleComments(line: string): string {
  // Remove `// ...` that is not part of a URL scheme or inside the string; good enough for a heuristic reading.
  return line.replace(/(^|[\s;{(])\/\/.{0,2000}$/, '$1');
}

export function parseGradle(file: string, text: string): ParsedManifest | undefined {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const isSettings = /^settings\.gradle/.test(base);
  const raw: RawDependency[] = [];
  const facts: JvmFacts = {
    tool: isSettings ? 'gradle-settings' : 'gradle',
    modules: [],
    repositories: [],
    plugins: [],
    profiles: [],
    extensions: [],
    gradlePlugins: [],
    gradleTasks: [],
    remoteScripts: [],
    catalog: {},
    unresolvedProperties: 0,
    includedBuilds: [],
  };
  const lines = text.split(/\r?\n/, MAX_LINES);
  // Brace-depth tracking decides configuration time vs. task-execution time (heuristic).
  const stack: ('task' | 'action' | 'buildscript' | 'repos' | 'deps' | 'block')[] = [];
  const taskNames = new Set<string>();
  const wiredNames = new Set<string>();
  let inBlockComment = false;
  const pendingTasks: GradleTask[] = [];
  let pluginBlockRepos: 'repository' | 'plugin_repository' = 'repository';

  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] as string).slice(0, MAX_LINE);
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('/*');
    if (open >= 0) {
      const end = line.indexOf('*/', open + 2);
      if (end < 0) {
        line = line.slice(0, open);
        inBlockComment = true;
      } else line = line.slice(0, open) + line.slice(end + 2);
    }
    line = stripGradleComments(line);
    if (!line.trim()) continue;
    const top = stack[stack.length - 1];
    const inAction = stack.includes('action');
    const inTask = stack.includes('task');

    // block openers
    let opener: (typeof stack)[number] | undefined;
    if (/\b(?:doLast|doFirst)\b[^{]{0,40}\{/.test(line)) opener = 'action';
    else if (/^\s*buildscript\s*\{/.test(line)) opener = 'buildscript';
    else if (/^\s*pluginManagement\s*\{/.test(line)) pluginBlockRepos = 'plugin_repository';
    else if (/^\s*repositories\s*\{/.test(line)) opener = 'repos';
    else if (/^\s*dependencies\s*\{/.test(line)) opener = 'deps';
    else if (/(?:^|\s)(?:tasks\.(?:register|create|named)|task)\b[^{]{0,200}\{\s*$/.test(line))
      opener = 'task';

    const taskDecl =
      /(?:^|\s)task(?=[\s(])\s*\(?\s*["']?([\w:-]+)["']?(?:\s*,?\s*type\s*[:=]\s*(\w+))?|tasks\.(?:register|create)(?:<(\w+)>)?\s*\(\s*["']([\w:-]+)["'](?:\s*,\s*(\w+)(?:::class\.java|\.class)?)?/.exec(
        line,
      );
    if (taskDecl && !inAction) {
      const name = (taskDecl[1] ?? taskDecl[4]) as string;
      const type = taskDecl[2] ?? taskDecl[3] ?? taskDecl[5];
      const typed = type && TASK_TYPES.test(type) ? type : undefined;
      taskNames.add(name);
      pendingTasks.push({
        name,
        ...(typed ? { type: typed } : {}),
        phase: 'execution',
        wired: false,
        line: i + 1,
        snippet: line.trim().slice(0, 160),
      });
    }

    // dependsOn / finalizedBy wiring (either direction)
    for (const w of line.matchAll(
      /(?:dependsOn|finalizedBy|mustRunAfter)\s*[( ]\s*([^\n)]{1,200})/g,
    ))
      for (const t of (w[1] as string).matchAll(/["']:?([\w:-]+)["']|\b([A-Za-z_]\w*)\b/g))
        wiredNames.add((t[1] ?? t[2]) as string);
    const wiringOwner =
      /^\s*(?:tasks\.(?:named|getByName)\s*[(<]?\s*["']?(?:build|assemble|check|test|compileJava|jar|classes|processResources|prepareKotlinBuildScriptModel)["']?|(?:build|assemble|check|jar|compileJava)\s*\.\s*(?:dependsOn|finalizedBy))/.test(
        line,
      );
    if (wiringOwner)
      for (const t of line.matchAll(/(?:dependsOn|finalizedBy)\s*[( ]\s*["']?:?([\w:-]+)["']?/g))
        wiredNames.add(t[1] as string);

    // execution-capable calls: configuration time unless inside a task action / typed Exec task
    const execCall =
      /(?:^|[^\w.])(?:project\.)?exec\s*[({]|\.execute\s*\(|\bProcessBuilder\s*\(|Runtime\.getRuntime\(\)\.exec|\bcommandLine\s*[( ]/.test(
        line,
      );
    const urlRead =
      /\bURL\s*\(\s*["'][^"']+["']\s*\)\s*\.(?:text|bytes|openStream|readText)|\buri\s*\(\s*["']https?:/.test(
        line,
      );
    if (execCall || urlRead) {
      const phase: GradleTask['phase'] =
        inAction || (inTask && /commandLine/.test(line)) ? 'execution' : 'configuration';
      const owner = [...pendingTasks].reverse().find((t) => t.line <= i + 1 && inTask);
      if (owner && phase === 'execution') {
        owner.snippet = `${owner.snippet} | ${line.trim().slice(0, 100)}`;
        if (!owner.type) owner.type = execCall ? 'Exec' : 'Download';
      } else
        facts.gradleTasks.push({
          name: `(${phase === 'configuration' ? 'configuration-time' : 'script'} ${execCall ? 'process execution' : 'remote read'})`,
          type: execCall ? 'Exec' : 'Download',
          phase,
          wired: phase === 'configuration',
          line: i + 1,
          snippet: line.trim().slice(0, 160),
        });
    }

    const applyFrom = /apply\s*(?:\(\s*)?from\s*[:=]\s*["'](https?:\/\/[^"']{1,300})["']/.exec(
      line,
    );
    if (applyFrom) facts.remoteScripts.push(applyFrom[1] as string);

    // plugins
    const pid = GRADLE_PLUGIN_ID.exec(line);
    if (pid && !inAction) {
      const id = (pid[1] ?? pid[2] ?? pid[3]) as string;
      if (!facts.gradlePlugins.includes(id) && facts.gradlePlugins.length < 100)
        facts.gradlePlugins.push(id);
    }
    const kts = /^\s*(?:kotlin|`)?([\w-]+)`?\s*$/.exec(line);
    if (
      kts &&
      top === undefined &&
      ['java', 'java-library', 'application', 'war', 'maven-publish'].includes(kts[1] as string)
    )
      facts.gradlePlugins.push(kts[1] as string);

    // repositories
    if (
      top === 'repos' ||
      /^\s*(?:mavenCentral|google|gradlePluginPortal|jcenter|mavenLocal)\s*\(/.test(line)
    ) {
      const std = /^\s*(mavenCentral|google|gradlePluginPortal|jcenter|mavenLocal)\s*\(/.exec(line);
      if (std) {
        // Symbolic names, not URLs: these are the build tool's built-in repositories (all https, or local).
        facts.repositories.push({
          url: `standard:${std[1] as string}`,
          kind: pluginBlockRepos,
          insecure: false,
        });
      }
      const u =
        /(?:url\s*[=(]?\s*(?:uri\s*\(\s*)?|maven\s*\(\s*(?:url\s*=\s*)?(?:uri\s*\(\s*)?)["']([^"']{1,300})["']/.exec(
          line,
        );
      if (u) {
        const allowInsecure = /allowInsecureProtocol\s*=?\s*true/.test(text);
        facts.repositories.push({
          url: u[1] as string,
          kind: pluginBlockRepos,
          insecure:
            /^http:\/\//i.test(u[1] as string) && !allowInsecure
              ? true
              : /^http:\/\//i.test(u[1] as string),
        });
      }
    }

    // dependencies
    const dm = !isSettings ? DEP_CONFIG.exec(line) : undefined;
    if (dm && (top === 'deps' || stack.includes('deps')) && raw.length < MAX_DEPS) {
      const conf = dm[1] as string;
      const rel = CONFIG_REL.find(([re]) => re.test(conf))?.[1] ?? 'runtime';
      const relationship: RawRelationship =
        stack.includes('buildscript') && conf === 'classpath' ? 'build' : rel;
      const args = dm[2] as string;
      const cm = COORD.exec(args);
      const nm = NAMED_DEP.exec(args);
      if (cm) {
        const parts = (cm[1] as string).split(':');
        if (parts.length >= 2)
          raw.push({
            name: `${parts[0]}:${parts[1]}`,
            spec: parts[2] ?? '',
            relationship,
            direct: true,
          });
      } else if (nm)
        raw.push({ name: `${nm[1]}:${nm[2]}`, spec: nm[3] ?? '', relationship, direct: true });
      else if (/project\s*\(\s*["'](:?[\w:-]+)["']/.test(args))
        raw.push({
          name: `project:${/project\s*\(\s*["'](:?[\w:-]+)["']/.exec(args)?.[1] as string}`,
          spec: 'workspace',
          relationship,
          direct: true,
        });
      else if (/^\s*(?:platform\(|enforcedPlatform\()?\s*libs\.([\w.]+)/.test(args))
        raw.push({
          name: `catalog:libs.${/libs\.([\w.]+)/.exec(args)?.[1] as string}`,
          spec: '',
          relationship,
          direct: true,
        });
    }

    // settings
    if (isSettings) {
      for (const inc of line.matchAll(/include\s*\(?\s*((?:["'][:\w./-]+["']\s*,?\s*)+)/g))
        for (const mm of (inc[1] as string).matchAll(/["']([:\w./-]+)["']/g))
          if (facts.modules.length < 200) facts.modules.push((mm[1] as string).replace(/^:/, ''));
      for (const ib of line.matchAll(/includeBuild\s*\(\s*["']([^"']+)["']/g))
        facts.includedBuilds.push(ib[1] as string);
    }

    // brace accounting
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    for (let k = 0; k < opens; k++) stack.push(k === 0 && opener ? opener : 'block');
    for (let k = 0; k < closes; k++) stack.pop();
    if (stack.length === 0) pluginBlockRepos = 'repository';
  }

  for (const t of pendingTasks) {
    t.wired = wiredNames.has(t.name);
    facts.gradleTasks.push(t);
  }
  void taskNames;
  const m: ParsedManifest = {
    file,
    ecosystem: 'Maven',
    keywords: [],
    dependencies: raw
      .filter((d) => d.relationship === 'runtime' && d.spec !== 'workspace')
      .map((d) => ({ name: d.name, spec: d.spec })),
    devDependencyCount: raw.filter((d) => d.relationship === 'test').length,
    devDependencyNames: raw.filter((d) => d.relationship === 'test').map((d) => d.name),
    entrypoints: [],
    isPrivate: false,
    rawDeps: raw,
    jvm: facts,
  };
  return m;
}

/** `gradle/libs.versions.toml` -> catalog aliases. */
export function parseVersionCatalog(file: string, text: string): ParsedManifest | undefined {
  let t: Record<string, unknown>;
  try {
    t = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const versions = (t['versions'] ?? {}) as Record<string, unknown>;
  const libs = (t['libraries'] ?? {}) as Record<string, unknown>;
  const catalog: Record<string, string> = Object.create(null) as Record<string, string>;
  let n = 0;
  const ver = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['ref'] === 'string' && typeof versions[o['ref']] === 'string')
        return versions[o['ref']] as string;
      if (typeof o['require'] === 'string') return o['require'];
      if (typeof o['strictly'] === 'string') return o['strictly'];
    }
    return '';
  };
  for (const [alias, v] of Object.entries(libs)) {
    if (n++ >= MAX_DEPS) break;
    const key = alias.replace(/[-_]/g, '.');
    if (typeof v === 'string') {
      const p = v.split(':');
      if (p.length >= 2) catalog[key] = `${p[0]}:${p[1]}:${p[2] ?? ''}`;
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const mod =
        typeof o['module'] === 'string'
          ? (o['module'] as string)
          : typeof o['group'] === 'string' && typeof o['name'] === 'string'
            ? `${o['group'] as string}:${o['name'] as string}`
            : undefined;
      if (mod) catalog[key] = `${mod}:${ver(o['version'])}`;
    }
  }
  return {
    file,
    ecosystem: 'Maven',
    keywords: [],
    dependencies: [],
    devDependencyCount: 0,
    devDependencyNames: [],
    entrypoints: [],
    rawDeps: [],
    jvm: {
      tool: 'version-catalog',
      modules: [],
      repositories: [],
      plugins: [],
      profiles: [],
      extensions: [],
      gradlePlugins: [],
      gradleTasks: [],
      remoteScripts: [],
      catalog,
      unresolvedProperties: 0,
      includedBuilds: [],
    },
  };
}

/** Rewrite `libs.x.y` references in Gradle manifests with the coordinates of the nearest version catalog. */
export function applyVersionCatalogs(manifests: ParsedManifest[]): void {
  const catalogs = manifests.filter((m) => m.jvm?.tool === 'version-catalog');
  if (catalogs.length === 0) return;
  for (const m of manifests) {
    if (m.jvm?.tool !== 'gradle' || !m.rawDeps) continue;
    const dir = m.file.includes('/') ? m.file.slice(0, m.file.lastIndexOf('/')) : '';
    const catalog =
      catalogs.find(
        (c) => c.file === (dir ? `${dir}/gradle/libs.versions.toml` : 'gradle/libs.versions.toml'),
      ) ??
      catalogs.find((c) => c.file === 'gradle/libs.versions.toml') ??
      catalogs[0];
    if (!catalog?.jvm) continue;
    for (const d of m.rawDeps) {
      if (!d.name.startsWith('catalog:libs.')) continue;
      const alias = d.name.slice('catalog:libs.'.length);
      const hit = catalog.jvm.catalog[alias];
      if (!hit) continue;
      const [g, a, v] = hit.split(':');
      d.name = `${g}:${a}`;
      d.spec = v ?? '';
    }
  }
}
