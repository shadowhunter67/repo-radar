import { z } from 'zod';
import type { ScannedFile } from '../analysis/types.js';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import type { RepoSnapshot } from '../collectors/types.js';
import { round } from '../util/text.js';
import { isNoisePath, structuralSignals, type Strength } from './signals.js';
import type { SemanticIdentity } from './types.js';

/**
 * Identity v2: several independent axes instead of one class label. A workspace layout says how the repository is
 * PACKAGED, not what it IS; a CLI that also exports a library is both, and the model says so instead of picking one.
 *
 * Evidence hierarchy (see signals.ts): STRONG structural facts (executable targets, program entry points, server bootstrap,
 * extension-point vocabulary used with a server, published export shape, plugin contracts) decide. WEAK signals (a bare
 * Dockerfile, the keyword hint of the legacy classifier) can only break ties: their total contribution is capped, so a
 * candidate supported by weak evidence alone can never beat one with strong evidence. The repository name, README prose and
 * topics are never inputs of this model.
 */
export const PRIMARY_ARTIFACTS = [
  'library',
  'cli',
  'application',
  'service',
  'framework',
  'plugin',
  'extension',
  'sdk',
  'driver',
  'infrastructure',
  'dataset',
  'model',
  'documentation',
  'template',
  'tooling',
  'container',
  'unknown',
] as const;
export const SECONDARY_ROLES = [
  'library_api',
  'cli_interface',
  'service_component',
  'plugin_host',
  'plugin',
  'workspace_root',
  'developer_tool',
  'build_tool',
  'test_tool',
  'code_generator',
] as const;
export const PACKAGING = [
  'single_package',
  'workspace',
  'multi_package',
  'monorepo',
  'multi_module',
  'mixed',
  'unknown',
] as const;
export const INTERFACES = [
  'cli',
  'library_api',
  'http_server',
  'rpc',
  'gui',
  'plugin_interface',
  'build_interface',
  'package_manager_hook',
  'container_entrypoint',
  'background_service',
] as const;
export const DEPLOYMENT_FORMS = [
  'local_executable',
  'library_dependency',
  'server_service',
  'container',
  'browser_extension',
  'mobile_app',
  'desktop_app',
  'build_plugin',
  'ci_action',
  'package',
  'unknown',
] as const;
export type PrimaryArtifact = (typeof PRIMARY_ARTIFACTS)[number];

const Scored = <T extends z.ZodTypeAny>(v: T) =>
  z.object({ value: v, confidence: z.number().min(0).max(1) });

export const IdentityV2Schema = z.object({
  version: z.literal('2'),
  primary_artifact: z.object({
    value: z.enum(PRIMARY_ARTIFACTS),
    confidence: z.number().min(0).max(1),
    /** `clear`: a lead over the runner-up; `ambiguous`: top candidates are close; `unknown`: no usable structural evidence. */
    status: z.enum(['clear', 'ambiguous', 'unknown']),
    /** Runner-up candidates with their own confidence; the sum of all candidates is not forced to 1. */
    alternatives: z.array(Scored(z.enum(PRIMARY_ARTIFACTS))),
    /** Evidence weight behind the winner, split by strength. Weak evidence alone can never produce a `clear` answer. */
    evidence_strength: z.object({ strong: z.number(), weak: z.number() }),
  }),
  secondary_roles: z.array(z.enum(SECONDARY_ROLES)),
  packaging: z.object({
    value: z.enum(PACKAGING),
    /** Primary manifests found (examples, tests, docs and vendored manifests excluded). */
    package_count: z.number().int().min(0),
    published_packages: z.number().int().min(0),
  }),
  interfaces: z.array(z.enum(INTERFACES)),
  deployment_form: z.object({
    value: z.enum(DEPLOYMENT_FORMS),
    confidence: z.number().min(0).max(1),
    /** Other ways the product can be deployed (a Dockerfile makes `container` supported, not the product's identity). */
    supported: z.array(z.enum(DEPLOYMENT_FORMS)),
  }),
  domain: z.string(),
  purpose: z.string(),
  /** Structural evidence only; no repository name or README keyword is among them. */
  evidence: z.array(z.string()),
  confidence_semantics: z.literal('heuristic_uncalibrated'),
});
export type IdentityV2 = z.infer<typeof IdentityV2Schema>;

export interface IdentityV2Input {
  snapshot: RepoSnapshot;
  legacy: Pick<
    SemanticIdentity,
    'artifact_type' | 'artifact_confidence' | 'domain' | 'purpose_summary'
  >;
  /** Capabilities observed by the static scan (may be empty when scanning is off). */
  observedCapabilities?: string[];
  /** Execution entrypoints found by the scan (console scripts, bins, [[bin]]). */
  entrypointCount?: number;
  /** Files fetched for scanning (source sample, build files, Dockerfiles). Used for structural signals only. */
  files?: ScannedFile[];
}

const FRONTEND = new Set([
  'react',
  'vue',
  'svelte',
  'solid-js',
  '@angular/core',
  'preact',
  'next',
  'nuxt',
  'astro',
  'lit',
]);
const SERVER_FRAMEWORK_DEPS = new Set([
  'express',
  'fastify',
  'koa',
  'hono',
  '@nestjs/core',
  'flask',
  'fastapi',
  'django',
  'starlette',
  'aiohttp',
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/gofiber/fiber',
  'github.com/go-chi/chi',
  'github.com/gorilla/mux',
  'actix-web',
  'axum',
  'rocket',
  'warp',
  'org.springframework.boot:spring-boot-starter-web',
]);
const DESKTOP = new Set(['electron', 'tauri', '@tauri-apps/api']);
const MOBILE = new Set(['react-native', 'expo', 'flutter']);
const RPC = /(?:^|\/)[^/]+\.proto$/i;

const HINT_MAP: Partial<Record<string, PrimaryArtifact>> = {
  framework: 'framework',
  plugin: 'plugin',
  extension: 'extension',
  sdk: 'sdk',
  driver: 'driver',
  infrastructure: 'infrastructure',
  dataset: 'dataset',
  model: 'model',
  documentation: 'documentation',
  template: 'template',
  tooling: 'tooling',
};
/** Weak evidence is capped: it breaks ties, it never decides. */
const WEAK_CAP = 1.5;

export function classifyIdentityV2(input: IdentityV2Input): IdentityV2 {
  const { snapshot: s, legacy } = input;
  const evidence: string[] = [];
  const strong = new Map<PrimaryArtifact, number>();
  const weak = new Map<PrimaryArtifact, number>();
  const add = (t: PrimaryArtifact, w: number, why: string, strength: Strength = 'strong'): void => {
    const m = strength === 'strong' ? strong : weak;
    m.set(t, (m.get(t) ?? 0) + w);
    if (evidence.length < 28) evidence.push(`${t} +${w} (${strength}): ${why}`);
  };
  const total = (t: PrimaryArtifact): number =>
    (strong.get(t) ?? 0) + Math.min(WEAK_CAP, weak.get(t) ?? 0);

  const manifests = s.manifests.filter(
    (m) =>
      !isNoisePath(m.file) &&
      m.jvm?.tool !== 'gradle-settings' &&
      m.jvm?.tool !== 'version-catalog',
  );
  const root = manifests.find((m) => !m.file.includes('/'));
  const paths = s.treePaths;
  const has = (re: RegExp): boolean => paths.some((p) => re.test(p) && !isNoisePath(p));
  const deps = new Set(manifests.flatMap((m) => m.dependencies.map((d) => d.name.toLowerCase())));
  const anyDep = (set: Set<string>): boolean => [...deps].some((d) => set.has(d));
  const caps = new Set(input.observedCapabilities ?? []);
  const sig = structuralSignals(s.treePaths, manifests, input.files ?? []);

  const published = manifests.filter((m) => !m.isPrivate);
  const withCli = (m: ParsedManifest): boolean =>
    m.entrypoints.length > 0 || Object.keys(m.bins ?? {}).length > 0;
  const rootCli = !!root && withCli(root);
  const nestedCli = manifests.filter(
    (m) => m.file.includes('/') && !m.isPrivate && withCli(m),
  ).length;

  // ---- signals --------------------------------------------------------------------------------------------------
  const goMain = sig.executables.some((e) => e.kind.startsWith('go'));
  const cargoBin = sig.executables.some((e) => e.kind.startsWith('cargo'));
  const nativeMain = sig.executables.some((e) => /^(?:native|cmake|meson)/.test(e.kind));
  const pyMain = sig.executables.some((e) => e.kind === 'python -m entry');
  const shCount = paths.filter((p) => /\.sh$/.test(p) && !isNoisePath(p)).length;
  const shellRoot = has(/^[^/]+\.sh$/) && shCount > sig.sourceFileCount;
  // `python -m` (__main__.py) alone is a demo/entry module, not a product executable.
  const realExecutables = sig.executables.filter((e) => e.kind !== 'python -m entry');
  const programEntry = rootCli || nestedCli > 0 || realExecutables.length > 0 || shellRoot;
  const hasCode = sig.sourceFileCount > 0;
  const serverBootstrap = sig.serverBootstrap.length > 0;
  const serverDeps = anyDep(SERVER_FRAMEWORK_DEPS);
  const serverCap = caps.has('NETWORK_SERVER');
  const webAssets = has(/^(?:views|templates|public|static|assets|app\/views)\//);
  const frontend =
    anyDep(FRONTEND) ||
    manifests.some((m) => m.devDependencyNames.some((d) => FRONTEND.has(d.toLowerCase())));
  const desktop = anyDep(DESKTOP);
  const mobile = anyDep(MOBILE) || (has(/^android\//) && has(/^ios\//));
  const springApp = manifests.some(
    (m) =>
      m.jvm?.plugins.some((pl) => pl.artifact === 'spring-boot-maven-plugin') ||
      m.jvm?.gradlePlugins.some((g) => g.startsWith('org.springframework.boot')) ||
      m.dependencies.some((d) => /spring-boot-starter-web/.test(d.name)),
  );
  const phpApp =
    paths.filter((p) => /^[^/]+\.php$/.test(p)).length >= 3 || has(/^config\/routes\.rb$/);
  // A published library surface: a publishable package with an export shape, or a library target.
  const librarySurface =
    published.some(
      (m) =>
        m.ecosystem !== 'Go' &&
        (m.entryFiles?.length ?? 0) + (m.entrypoints.length === 0 ? 1 : 0) > 0,
    ) ||
    sig.libraryTargets.length > 0 ||
    (manifests.some((m) => m.ecosystem === 'Go') && !goMain);
  // A framework exposes an extension surface: several families of extension-point vocabulary AND a server/app bootstrap.
  // A framework is a REUSABLE, published package: an application that merely uses routing/middleware words is not one.
  const frameworkEvidence =
    sig.extensionFamilies.length >= 3 &&
    (serverBootstrap || serverCap || serverDeps) &&
    published.length > 0 &&
    root?.isPrivate !== true &&
    !frontend &&
    !(webAssets && root?.isPrivate !== false);

  // ---- interfaces ------------------------------------------------------------------------------------------------
  const ifaces = new Set<(typeof INTERFACES)[number]>();
  if (programEntry || pyMain || sig.nativeEntryFiles.some((f) => /cli/.test(f))) ifaces.add('cli');
  if (librarySurface) ifaces.add('library_api');
  if (serverBootstrap || serverCap || serverDeps) ifaces.add('http_server');
  if (has(RPC) || [...deps].some((d) => /grpc|tonic|thrift/.test(d))) ifaces.add('rpc');
  if ((frontend && root?.isPrivate !== false) || desktop || mobile) ifaces.add('gui');
  if (s.hasActionYml) ifaces.add('plugin_interface');
  if (
    manifests.some(
      (m) => m.python?.entryPointGroups && Object.keys(m.python.entryPointGroups).length > 0,
    ) ||
    frameworkEvidence
  )
    ifaces.add('plugin_interface');
  if (
    manifests.some((m) => m.jvm?.coordinates?.packaging === 'maven-plugin') ||
    has(/(?:^|\/)buildSrc\//)
  )
    ifaces.add('build_interface');
  if (
    root?.scripts &&
    ['install', 'postinstall', 'preinstall'].some((k) => root.scripts?.[k]) &&
    !root.isPrivate
  )
    ifaces.add('package_manager_hook');
  if (s.hasDockerfile && (sig.dockerEntrypoints.length > 0 || programEntry || serverBootstrap))
    ifaces.add('container_entrypoint');
  if (caps.has('BACKGROUND_PROCESS') && (serverBootstrap || serverCap))
    ifaces.add('background_service');

  // ---- primary artifact: strong evidence --------------------------------------------------------------------------
  if (s.hasActionYml) add('plugin', 5, 'action.yml present');
  if (rootCli)
    add(
      'cli',
      frameworkEvidence ? 1.5 : 3.5,
      frameworkEvidence
        ? 'root package declares a helper command (framework with extension surface)'
        : 'root package declares executable entry points',
    );
  if (nestedCli > 0)
    add('cli', Math.min(2, nestedCli), `${nestedCli} nested package(s) declare executables`);
  const bin = realExecutables.find((e) => e.kind.startsWith('cargo') || e.kind.startsWith('go'));
  if (bin && !rootCli) add('cli', 3, `executable target (${bin.kind}: ${bin.path})`);
  if (nativeMain) add('cli', 2.5, 'native program entry (main translation unit / add_executable)');
  if (shellRoot && !rootCli) add('cli', 2.5, 'top-level shell scripts and no package source tree');
  if (pyMain) add('cli', 1, 'python -m entry (__main__.py)');
  if (sig.cliParser.length > 0 && programEntry)
    add('cli', 1, `command-line parser in a program (${sig.cliParser[0]})`);
  if (springApp) add('application', 3, 'Spring Boot application');
  if (phpApp) add('application', 3, 'PHP/Rails web application sources');
  if (librarySurface && !programEntry)
    add('library', 3, 'publishable package or library target without an executable target');
  else if (librarySurface)
    add('library', 1.5, 'library surface that coexists with an executable target (secondary role)');
  if (sig.libraryTargets.length > 0) add('library', 1, 'library target (src/lib.rs, add_library)');
  // Dedicated server bootstrap (ListenAndServe, createServer, uvicorn.run, ...) decides; a bare listen()/net.Listen is common in CLIs.
  const dedicatedServer = sig.serverBootstrap.some(
    (t) => t !== 'listen()' && t !== 'go net.Listen',
  );
  const serverEvidence = serverBootstrap || serverCap;
  const serverWithUi =
    (serverEvidence || (serverDeps && root?.isPrivate === true)) &&
    webAssets &&
    root?.isPrivate !== false;
  if (serverWithUi) add('application', 3, 'web server with views/static assets');
  if (serverBootstrap && !dedicatedServer && !serverWithUi && !frameworkEvidence)
    add('service', 1.5, `generic listener in a program (${sig.serverBootstrap[0]})`);
  if (
    dedicatedServer &&
    !serverWithUi &&
    !frameworkEvidence &&
    (programEntry || s.hasDockerfile || root?.isPrivate)
  )
    add(
      'service',
      sig.cliParser.length > 0 ? 1.5 : 3,
      `server bootstrap in a runnable program (${sig.serverBootstrap[0]})`,
    );
  else if (
    serverCap &&
    !serverWithUi &&
    !frameworkEvidence &&
    programEntry &&
    !sig.cliParser.length
  )
    add('service', 1, 'network server capability observed in a runnable program');
  if (serverDeps && root?.isPrivate && !serverWithUi && !frameworkEvidence)
    add('service', 1.5, 'private package built on a server framework');
  if (sig.dockerEntrypoints.length > 0 && !librarySurface && !programEntry)
    add('service', 2, `container ENTRYPOINT/CMD starts the product (${sig.dockerEntrypoints[0]})`);
  if (sig.nativeEntryFiles.some((f) => /server|daemon/.test(f)) && !librarySurface)
    add(
      'service',
      2.5,
      `native server entry (${sig.nativeEntryFiles.find((f) => /server|daemon/.test(f))})`,
    );
  if (sig.nativeEntryFiles.some((f) => /(?:-|_|\/)cli\./.test(f)))
    add('cli', 1, 'native command-line client entry');
  if (frameworkEvidence && !programEntry)
    add(
      'framework',
      4,
      `extension surface (${sig.extensionFamilies.join(', ')}) with an application/server bootstrap`,
    );
  else if (frameworkEvidence)
    add(
      'framework',
      3.5,
      `extension surface (${sig.extensionFamilies.join(', ')}) with an application/server bootstrap`,
    );
  if (frontend && root?.isPrivate !== false && !librarySurface)
    add('application', 3, 'private package with a UI framework');
  if (
    frontend &&
    manifests.filter((m) => m.isPrivate && m.file.includes('/')).length >= 1 &&
    root?.isPrivate !== false
  )
    add('application', 1.5, 'nested private UI package(s)');
  if (desktop || mobile) add('application', 3, 'desktop or mobile application framework');
  if (has(/\.tf$/) && manifests.length === 0)
    add('infrastructure', 4, 'Terraform files and no package manifest');
  if (has(/^(?:cookiecutter\.json|copier\.ya?ml)$/))
    add('template', 4, 'project template descriptor');
  // A Dockerfile is a deployment form. It is the identity only when the repository has no code at all: it exists to define
  // an image.
  if (s.hasDockerfile && manifests.length === 0 && !hasCode && !has(/\.tf$/))
    add(
      'container',
      3,
      'Dockerfile and no code or package manifest: the repository defines an image',
    );
  else if (s.hasDockerfile)
    add('service', 0.5, 'Dockerfile present (deployment form, not identity)', 'weak');

  // ---- weak evidence: the keyword hint of the legacy classifier, only for kinds structure cannot reveal ---------------
  const hinted = HINT_MAP[legacy.artifact_type];
  if (hinted) add(hinted, 1.5, `taxonomy hint (${legacy.artifact_type})`, 'weak');
  if (legacy.artifact_type === 'documentation' && manifests.length === 0)
    add('documentation', 2, 'no code manifests');

  const candidates = [...new Set([...strong.keys(), ...weak.keys()])];
  const ranked = candidates
    .map((t) => [t, total(t)] as const)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = ranked[0];
  const second = ranked[1];
  let primary: PrimaryArtifact = 'unknown';
  let primaryConf = 0.15;
  let status: IdentityV2['primary_artifact']['status'] = 'unknown';
  if (top && top[1] >= 2 && (strong.get(top[0]) ?? 0) >= 1.5) {
    primary = top[0];
    const margin = (top[1] - (second?.[1] ?? 0)) / top[1];
    primaryConf = round(Math.min(0.9, (1 - Math.exp(-top[1] / 4)) * (0.45 + 0.55 * margin)), 2);
    status = margin < 0.25 ? 'ambiguous' : 'clear';
  }
  const alternatives = ranked
    .filter(([t, w]) => t !== primary && w >= 1)
    .slice(0, 3)
    .map(([t, w]) => ({
      value: t,
      confidence: round(Math.min(0.9, (1 - Math.exp(-w / 4)) * 0.6), 2),
    }));

  // ---- packaging -------------------------------------------------------------------------------------------------
  const ecosystems = new Set(manifests.map((m) => m.ecosystem));
  const n = manifests.length;
  let packaging: (typeof PACKAGING)[number] = 'unknown';
  if (n === 1) packaging = 'single_package';
  else if (n > 1) {
    const jvm = manifests.every((m) => m.ecosystem === 'Maven');
    if (ecosystems.size > 1 && n > 2) packaging = 'mixed';
    else if (jvm) packaging = 'multi_module';
    else if ((root?.workspaces?.length ?? 0) > 0) packaging = n >= 6 ? 'monorepo' : 'workspace';
    else packaging = n >= 6 ? 'monorepo' : n >= 3 ? 'multi_package' : 'workspace';
  }
  const publishedCount = published.length;
  if (packaging !== 'unknown' && packaging !== 'single_package')
    evidence.push(`packaging: ${n} primary manifests (${publishedCount} publishable)`);

  // ---- deployment form -------------------------------------------------------------------------------------------
  const supported = new Set<(typeof DEPLOYMENT_FORMS)[number]>();
  if (s.hasDockerfile && primary !== 'container') supported.add('container');
  let deployment: (typeof DEPLOYMENT_FORMS)[number] = 'unknown';
  let depConf = 0.2;
  const setDep = (d: typeof deployment, c: number): void => {
    deployment = d;
    depConf = c;
  };
  if (s.hasActionYml) setDep('ci_action', 0.9);
  else if (desktop) setDep('desktop_app', 0.6);
  else if (mobile) setDep('mobile_app', 0.6);
  else if (ifaces.has('build_interface') && primary === 'plugin') setDep('build_plugin', 0.5);
  else if (primary === 'service' || primary === 'application')
    setDep(frontend && !serverEvidence ? 'package' : 'server_service', 0.5);
  else if (primary === 'cli') setDep('local_executable', 0.6);
  else if (primary === 'container') setDep('container', 0.55);
  else if (['library', 'sdk', 'framework', 'driver'].includes(primary))
    setDep('library_dependency', 0.6);

  // ---- secondary roles -------------------------------------------------------------------------------------------
  const roles = new Set<(typeof SECONDARY_ROLES)[number]>();
  if (
    ifaces.has('library_api') &&
    primary !== 'library' &&
    primary !== 'sdk' &&
    primary !== 'framework'
  )
    roles.add('library_api');
  if (ifaces.has('cli') && primary !== 'cli') roles.add('cli_interface');
  if (ifaces.has('http_server') && primary !== 'service') roles.add('service_component');
  if (['workspace', 'monorepo', 'multi_package', 'multi_module'].includes(packaging))
    roles.add('workspace_root');
  if (ifaces.has('plugin_interface') && primary !== 'plugin') roles.add('plugin_host');
  if (
    primary === 'tooling' ||
    (primary === 'cli' && /developer|tooling|build|lint|format|test/.test(legacy.domain))
  )
    roles.add('developer_tool');

  return {
    version: '2',
    primary_artifact: {
      value: primary,
      confidence: primaryConf,
      status,
      alternatives,
      evidence_strength: {
        strong: round(strong.get(primary) ?? 0, 2),
        weak: round(Math.min(WEAK_CAP, weak.get(primary) ?? 0), 2),
      },
    },
    secondary_roles: [...roles].sort(),
    packaging: { value: packaging, package_count: n, published_packages: publishedCount },
    interfaces: [...ifaces].sort(),
    deployment_form: {
      value: deployment,
      confidence: round(depConf, 2),
      supported: [...supported],
    },
    domain: legacy.domain,
    purpose: legacy.purpose_summary,
    evidence: evidence.slice(0, 28),
    confidence_semantics: 'heuristic_uncalibrated',
  };
}
