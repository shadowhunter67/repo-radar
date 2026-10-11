import type { ScannedFile } from '../analysis/types.js';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import { AUXILIARY_DIR } from '../util/scope.js';

/**
 * Structural signals for identity v2, with an explicit evidence hierarchy.
 *
 * STRONG: facts about what the repository builds or exposes - executable targets, program entry points, server bootstrap,
 * published package export shape, extension-point vocabulary used together with a server, plugin contracts, a Dockerfile
 * ENTRYPOINT/CMD of the product itself.
 * WEAK: things that say little about what the product is - a bare Dockerfile, README keywords, topics, the repository name,
 * examples, tests, benchmarks, development tooling. Weak signals only break ties and are capped.
 *
 * Nothing here executes or evaluates repository content; file bodies are read as text under the scan limits.
 */
export type Strength = 'strong' | 'weak';

export const isNoisePath = (p: string): boolean =>
  AUXILIARY_DIR.test(p) || /(?:^|\/)(?:vendor|third[_-]party|node_modules|deps)\//i.test(p);

const SRC_EXT = /\.(?:go|rs|py|js|jsx|mjs|cjs|ts|tsx|java|kt|c|cc|cpp|cxx|cs|rb|php|swift|zig)$/i;
const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|testdata|fixtures?|benchmarks?|bench|examples?|samples?|docs?)\/|(?:_test\.go|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.py)$/i;

export interface StructuralSignals {
  /** Executable targets found by file layout (no build system is run). */
  executables: { kind: string; path: string }[];
  /** Library targets found by file layout or manifest. */
  libraryTargets: string[];
  /** Server bootstrap tokens seen in non-test source (listen/serve/bind). */
  serverBootstrap: string[];
  /** Families of extension-point vocabulary seen in non-test source (routing, middleware, plugin, hooks, lifecycle). */
  extensionFamilies: string[];
  /** Command-line parser usage seen in non-test source. */
  cliParser: string[];
  /** Dockerfile ENTRYPOINT/CMD lines (scanned Dockerfiles only). */
  dockerEntrypoints: string[];
  sourceFileCount: number;
  /** Names of C/C++ translation units that are conventionally program entry points (main.c, *-server.c, *-cli.c). */
  nativeEntryFiles: string[];
}

const SERVER_TOKENS: [RegExp, string][] = [
  [/\bhttp\.ListenAndServe(?:TLS)?\s*\(|\.ListenAndServe\s*\(/, 'go ListenAndServe'],
  [/\bnet\.Listen\s*\(/, 'go net.Listen'],
  [/\bapp\.listen\s*\(|\bserver\.listen\s*\(|\.listen\s*\(\s*\{?\s*port/i, 'listen()'],
  [
    /\bhttp\.createServer\s*\(|\bhttps\.createServer\s*\(|\bnet\.createServer\s*\(/,
    'createServer()',
  ],
  [
    /\buvicorn\.run\s*\(|\bapp\.run\s*\(|\bserve_forever\s*\(|\bHTTPServer\s*\(/,
    'python server run',
  ],
  [
    /\bTcpListener::bind\s*\(|\bHttpServer::new\s*\(|\baxum::serve\s*\(|\bwarp::serve\s*\(/,
    'rust server bind',
  ],
  [/\bSpringApplication\.run\s*\(|@SpringBootApplication\b/, 'spring boot application'],
  [
    /\blisten\s*\(\s*(?:fd|sockfd|server_fd)\b|\baccept\s*\(\s*(?:fd|sockfd|server_fd)\b|\bbind\s*\(\s*(?:fd|sockfd|server_fd)\b/,
    'c socket server',
  ],
  [/\baeMain\b|\bserverCron\b|\binitServer\s*\(/, 'event-loop server'],
];
const EXT_FAMILIES: [string, RegExp][] = [
  [
    'routing',
    /\b(?:router|route|routes|add_url_rule|Router\(|\.Group\(|\.GET\(|\.POST\(|\.get\(\s*['"`]\/|\.post\(\s*['"`]\/)/,
  ],
  [
    'middleware',
    /\b(?:middleware|HandlerFunc|\.Use\(|\.use\(|before_request|after_request|onRequest|preHandler)\b|\.Use\(|\.use\(/,
  ],
  ['plugin', /\b(?:register|plugin|plugins|decorate|addHook|blueprint|extension)\b/i],
  ['hooks', /\b(?:hooks?|addHook|onClose|onReady|lifecycle|before_first|teardown)\b/i],
  [
    'bootstrap',
    /\b(?:createApp|create_app|new Engine|gin\.New|gin\.Default|fastify\s*\(|Flask\s*\(|Application\s*\(|bootstrap)\b|gin\.New\(|gin\.Default\(/,
  ],
];
const CLI_PARSERS: [RegExp, string][] = [
  [/\bclap::|\buse clap\b|\bstructopt\b|#\[derive\(\s*Parser/, 'clap'],
  [/\bcobra\.Command\b|\bflag\.Parse\s*\(|\bpflag\b|urfave\/cli/, 'go cli parser'],
  [/\bargparse\b|\bimport click\b|\btyper\.run\b|\bfire\.Fire\b/, 'python cli parser'],
  [/\byargs\b|\bcommander\b|\bmeow\b|\bprocess\.argv\b/, 'node cli parser'],
  [/\bgetopt(?:_long)?\s*\(|\bargc\b[\s\S]{0,200}\bargv\b|int\s+main\s*\(\s*int\s+argc/, 'c argv'],
];
const GENERIC_SOURCE = (f: ScannedFile): boolean =>
  (f.role === 'source' || f.role === 'script' || f.role === 'ref') &&
  SRC_EXT.test(f.path) &&
  !TEST_FILE.test(f.path) &&
  !isNoisePath(f.path);

export function structuralSignals(
  treePaths: string[],
  manifests: ParsedManifest[],
  files: ScannedFile[],
): StructuralSignals {
  const paths = treePaths.filter((p) => !isNoisePath(p));
  const code = paths.filter((p) => SRC_EXT.test(p) && !TEST_FILE.test(p));
  const executables: StructuralSignals['executables'] = [];
  const addExe = (kind: string, path: string): void => {
    if (executables.length < 20) executables.push({ kind, path });
  };
  const libraryTargets: string[] = [];
  for (const p of paths) {
    if (/(?:^|\/)src\/main\.rs$/.test(p)) addExe('cargo bin (src/main.rs)', p);
    else if (/(?:^|\/)src\/bin\/[^/]+\.rs$/.test(p)) addExe('cargo bin (src/bin/*.rs)', p);
    else if (/(?:^|\/)src\/bin\/[^/]+\/main\.rs$/.test(p))
      addExe('cargo bin (src/bin/*/main.rs)', p);
    else if (/^(?:cmd\/[^/]+\/)?main\.go$/.test(p)) addExe('go main package', p);
    else if (/(?:^|\/)__main__\.py$/.test(p)) addExe('python -m entry', p);
    else if (/^(?:src\/)?main\.(?:c|cc|cpp|cxx)$/.test(p))
      addExe('native main translation unit', p);
    else if (/^bin\/[^/]+$/.test(p) && !/\.(?:md|txt|json)$/.test(p)) addExe('bin/ script', p);
    if (/(?:^|\/)src\/lib\.rs$/.test(p)) libraryTargets.push(p);
    if (/(?:^|\/)lib[^/]*\.(?:pc\.in|la)$|(?:^|\/)lib[^/]+\.pc\.in$/.test(p))
      libraryTargets.push(p);
  }
  for (const f of files) {
    if (
      f.path.endsWith('.go') &&
      !f.path.endsWith('_test.go') &&
      /^package main(?:\s|$)/m.test(f.content)
    )
      addExe('go package main', f.path);
    if (/(?:^|\/)CMakeLists\.txt$/.test(f.path) && /\badd_executable\s*\(/.test(f.content))
      addExe('cmake add_executable', f.path);
    if (/(?:^|\/)CMakeLists\.txt$/.test(f.path) && /\badd_library\s*\(/.test(f.content))
      libraryTargets.push(f.path);
    if (/(?:^|\/)meson\.build$/.test(f.path) && /\bexecutable\s*\(/.test(f.content))
      addExe('meson executable', f.path);
  }
  for (const m of manifests) {
    if (m.ecosystem === 'crates.io' && m.entrypoints.length > 0) addExe('cargo [[bin]]', m.file);
  }
  const serverBootstrap = new Set<string>();
  const families = new Set<string>();
  const parsers = new Set<string>();
  const docker: string[] = [];
  for (const f of files) {
    if (/(?:^|\/)Dockerfile[\w.-]*$/.test(f.path) && !isNoisePath(f.path)) {
      for (const line of f.content.split('\n').slice(0, 400))
        if (/^\s*(?:ENTRYPOINT|CMD)\b/i.test(line) && docker.length < 5)
          docker.push(line.trim().slice(0, 120));
      continue;
    }
    if (!GENERIC_SOURCE(f)) continue;
    const text = f.content.slice(0, 60_000);
    for (const [re, label] of SERVER_TOKENS) if (re.test(text)) serverBootstrap.add(label);
    for (const [fam, re] of EXT_FAMILIES) if (re.test(text)) families.add(fam);
    for (const [re, label] of CLI_PARSERS) if (re.test(text)) parsers.add(label);
  }
  const native = code
    .filter((p) => /\.(?:c|cc|cpp|cxx)$/.test(p) && p.split('/').length <= 3)
    .filter((p) =>
      /(?:^|[/_-])(?:main|server|daemon|cli)\.(?:c|cc|cpp|cxx)$|-(?:server|cli|benchmark)\.c$/.test(
        p,
      ),
    );
  return {
    executables,
    libraryTargets: [...new Set(libraryTargets)].slice(0, 10),
    serverBootstrap: [...serverBootstrap],
    extensionFamilies: [...families],
    cliParser: [...parsers],
    dockerEntrypoints: docker,
    sourceFileCount: code.length,
    nativeEntryFiles: native.slice(0, 10),
  };
}
