import { z } from 'zod';
import type { RepoSnapshot } from '../collectors/types.js';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import { AUXILIARY_DIR } from '../util/scope.js';
import { round } from '../util/text.js';
import type { SemanticIdentity } from './types.js';

/**
 * Identity v2: several independent axes instead of one class label. A workspace layout says how the repository is
 * PACKAGED, not what it IS; a CLI that also exports a library is both, and the model says so instead of picking one.
 * Everything here is derived from structural evidence (manifests, entry points, build files, tree layout, observed
 * capabilities). The repository name, README prose and topics are never inputs of this model.
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
    /** Runner-up candidates with their own confidence; the sum of all candidates is not forced to 1. */
    alternatives: z.array(Scored(z.enum(PRIMARY_ARTIFACTS))),
  }),
  secondary_roles: z.array(z.enum(SECONDARY_ROLES)),
  packaging: z.object({
    value: z.enum(PACKAGING),
    /** Primary manifests found (examples, tests, docs and vendored manifests excluded). */
    package_count: z.number().int().min(0),
    published_packages: z.number().int().min(0),
  }),
  interfaces: z.array(z.enum(INTERFACES)),
  deployment_form: Scored(z.enum(DEPLOYMENT_FORMS)),
  domain: z.string(),
  purpose: z.string(),
  /** Counts of structural evidence only; no repository name or README keyword is among them. */
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
  /** A scanned Go file declares `package main` (a program, not a library). */
  goPackageMain?: boolean;
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
const SERVER = new Set([
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
const FRAMEWORK_LEGACY = new Set(['framework']);

const isNoise = (p: string): boolean =>
  AUXILIARY_DIR.test(p) || /(?:^|\/)(?:vendor|third[_-]party|node_modules)\//i.test(p);

/** Candidate scores are evidence weights, not probabilities. Every contribution is appended to `evidence`. */
export function classifyIdentityV2(input: IdentityV2Input): IdentityV2 {
  const { snapshot: s, legacy } = input;
  const evidence: string[] = [];
  const score = new Map<PrimaryArtifact, number>();
  const add = (t: PrimaryArtifact, w: number, why: string): void => {
    score.set(t, (score.get(t) ?? 0) + w);
    if (evidence.length < 24) evidence.push(`${t} +${w}: ${why}`);
  };
  const manifests = s.manifests.filter(
    (m) =>
      !isNoise(m.file) && m.jvm?.tool !== 'gradle-settings' && m.jvm?.tool !== 'version-catalog',
  );
  const root = manifests.find((m) => !m.file.includes('/'));
  const paths = s.treePaths;
  const has = (re: RegExp): boolean => paths.some((p) => re.test(p) && !isNoise(p));
  const deps = new Set(manifests.flatMap((m) => m.dependencies.map((d) => d.name.toLowerCase())));
  const anyDep = (set: Set<string>): boolean => [...deps].some((d) => set.has(d));
  const caps = new Set(input.observedCapabilities ?? []);

  const published = manifests.filter((m) => !m.isPrivate);
  const withCli = (m: ParsedManifest): boolean =>
    m.entrypoints.length > 0 || Object.keys(m.bins ?? {}).length > 0;
  const rootCli = !!root && withCli(root);
  const nestedCli = manifests.filter(
    (m) => m.file.includes('/') && !m.isPrivate && withCli(m),
  ).length;

  // --- interfaces --------------------------------------------------------------------------------------------------
  const ifaces = new Set<(typeof INTERFACES)[number]>();
  const cargoBin =
    has(/^src\/main\.rs$/) || has(/^src\/bin\/[^/]+\.rs$/) || has(/(?:^|\/)src\/main\.rs$/);
  const goMain = input.goPackageMain === true || has(/^main\.go$/) || has(/^cmd\/[^/]+\/main\.go$/);
  const shCount = paths.filter((p) => /.sh$/.test(p) && !isNoise(p)).length;
  const srcCount = paths.filter(
    (p) => /.(?:go|rs|py|js|jsx|ts|tsx|java|kt|c|cc|cpp|cs)$/.test(p) && !isNoise(p),
  ).length;
  const shellRoot = has(/^[^/]+.sh$/) && shCount > srcCount;
  const phpRoot = s.treePaths.filter((p) => /^[^/]+\.php$/.test(p)).length >= 3;
  const rubyApp = has(/^config\/routes\.rb$/);
  const webAssets = has(/^(?:views|templates|public|static|assets|app\/views)\//);
  const springApp = manifests.some(
    (m) =>
      m.jvm?.plugins.some((pl) => pl.artifact === 'spring-boot-maven-plugin') ||
      m.jvm?.gradlePlugins.some((g) => g.startsWith('org.springframework.boot')) ||
      m.dependencies.some((d) => /spring-boot-starter-web/.test(d.name)),
  );
  const pyMain = has(/(?:^|\/)__main__\.py$/);
  const cliEvidence =
    rootCli ||
    nestedCli > 0 ||
    cargoBin ||
    goMain ||
    pyMain ||
    shellRoot ||
    (input.entrypointCount ?? 0) > 0;
  if (cliEvidence) ifaces.add('cli');
  const libraryEvidence =
    published.some((m) => m.ecosystem !== 'Go') ||
    has(/^src\/lib\.rs$/) ||
    (manifests.some((m) => m.ecosystem === 'Go') && !goMain) ||
    published.some((m) => m.ecosystem === 'Go' && !goMain);
  if (libraryEvidence) ifaces.add('library_api');
  const serverDeps = anyDep(SERVER);
  if (serverDeps || caps.has('NETWORK_SERVER')) ifaces.add('http_server');
  if (has(RPC) || [...deps].some((d) => /grpc|tonic|thrift/.test(d))) ifaces.add('rpc');
  const frontend = anyDep(FRONTEND);
  const desktop = anyDep(DESKTOP);
  const mobile = anyDep(MOBILE) || (has(/^android\//) && has(/^ios\//));
  if ((frontend && root?.isPrivate !== false) || desktop || mobile) ifaces.add('gui');
  if (s.hasActionYml) ifaces.add('plugin_interface');
  if (
    manifests.some(
      (m) => m.python?.entryPointGroups && Object.keys(m.python.entryPointGroups).length > 0,
    )
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
  if (s.hasDockerfile && (cliEvidence || serverDeps || caps.has('NETWORK_SERVER')))
    ifaces.add('container_entrypoint');
  if (caps.has('BACKGROUND_PROCESS') && (serverDeps || caps.has('NETWORK_SERVER')))
    ifaces.add('background_service');

  // --- primary artifact --------------------------------------------------------------------------------------------
  if (s.hasActionYml) add('plugin', 5, 'action.yml present');
  if (rootCli) add('cli', 3.5, 'root package declares executable entry points');
  if (nestedCli > 0)
    add('cli', Math.min(2, nestedCli), `${nestedCli} nested package(s) declare executables`);
  if (cargoBin && !rootCli) add('cli', 3, 'Rust binary target (src/main.rs or src/bin)');
  if (goMain && !serverDeps) add('cli', 2.5, 'Go main package');
  if (shellRoot && !rootCli)
    add('cli', 2.5, 'repository ships top-level shell scripts and no package source tree');
  if (pyMain) add('cli', 1, 'python -m entry (__main__.py)');
  if (springApp) add('application', 3, 'Spring Boot application');
  if (phpRoot || rubyApp) add('application', 3, 'PHP/Rails web application sources');
  if (libraryEvidence && !(goMain || cargoBin || springApp || shellRoot))
    add('library', 3, 'publishable package without an executable target');
  else if (libraryEvidence)
    add('library', 1.5, 'publishable package that also exposes a library surface');
  if (has(/^src\/lib\.rs$/)) add('library', 1, 'Rust library target (src/lib.rs)');
  const serverWithUi =
    (serverDeps || caps.has('NETWORK_SERVER')) && webAssets && root?.isPrivate !== false;
  if (serverWithUi) add('application', 3, 'web server with views/static assets');
  if (serverDeps && !serverWithUi && (s.hasDockerfile || root?.isPrivate || goMain || cargoBin))
    add('service', 3, 'server framework dependency with a deployable entry');
  if (
    caps.has('NETWORK_SERVER') &&
    !serverWithUi &&
    (goMain || cargoBin || rootCli || s.hasDockerfile)
  )
    add(
      'service',
      cliEvidence ? 1 : 2.5,
      'network server capability observed in a runnable program',
    );
  if (frontend && root?.isPrivate !== false && !libraryEvidence)
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
  if (s.hasDockerfile && manifests.length === 0 && !has(/\.tf$/) && !phpRoot)
    add('container', 3, 'Dockerfile and no package manifest');
  if (has(/^(?:cookiecutter\.json|copier\.ya?ml)$/))
    add('template', 4, 'project template descriptor');
  // The legacy classifier's keyword/domain hint is a weak tie-breaker, never decisive (and "monorepo" is a packaging fact).
  const hint = legacy.artifact_type;
  const hintMap: Partial<Record<string, PrimaryArtifact>> = {
    library: 'library',
    cli: 'cli',
    application: 'application',
    service: 'service',
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
    container: 'container',
  };
  // Structure decides library/cli/application/service/container; the taxonomy hint only helps for kinds that structure
  // cannot reveal (framework, sdk, driver, tooling, ...). It is a keyword-derived signal and never the sole decider.
  const STRUCTURAL = new Set<PrimaryArtifact>([
    'library',
    'cli',
    'application',
    'service',
    'container',
  ]);
  const hinted = hintMap[hint];
  if (hinted && !STRUCTURAL.has(hinted))
    add(hinted, FRAMEWORK_LEGACY.has(hinted) ? 2 : 1.5, `taxonomy hint (${hint})`);
  if (hinted === 'documentation' && manifests.length === 0)
    add('documentation', 2, 'no code manifests');

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = ranked[0];
  const second = ranked[1];
  let primary: PrimaryArtifact = 'unknown';
  let primaryConf = 0.15;
  if (top && top[1] >= 2) {
    primary = top[0];
    const margin = (top[1] - (second?.[1] ?? 0)) / top[1];
    primaryConf = round(Math.min(0.9, (1 - Math.exp(-top[1] / 4)) * (0.45 + 0.55 * margin)), 2);
  }
  const alternatives = ranked
    .filter(([t, w]) => t !== primary && w >= 1)
    .slice(0, 3)
    .map(([t, w]) => ({
      value: t,
      confidence: round(Math.min(0.9, (1 - Math.exp(-w / 4)) * 0.6), 2),
    }));

  // --- packaging ---------------------------------------------------------------------------------------------------
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

  // --- deployment form ---------------------------------------------------------------------------------------------
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
  else if (primary === 'service')
    setDep(s.hasDockerfile ? 'container' : 'server_service', s.hasDockerfile ? 0.55 : 0.5);
  else if (primary === 'cli') setDep('local_executable', 0.6);
  else if (primary === 'container') setDep('container', 0.55);
  else if (['library', 'sdk', 'framework', 'driver'].includes(primary))
    setDep('library_dependency', 0.6);
  else if (primary === 'application') setDep(frontend ? 'package' : 'unknown', 0.3);

  // --- secondary roles ---------------------------------------------------------------------------------------------
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
    primary_artifact: { value: primary, confidence: primaryConf, alternatives },
    secondary_roles: [...roles].sort(),
    packaging: { value: packaging, package_count: n, published_packages: publishedCount },
    interfaces: [...ifaces].sort(),
    deployment_form: { value: deployment, confidence: round(depConf, 2) },
    domain: legacy.domain,
    purpose: legacy.purpose_summary,
    evidence: evidence.slice(0, 24),
    confidence_semantics: 'heuristic_uncalibrated',
  };
}
