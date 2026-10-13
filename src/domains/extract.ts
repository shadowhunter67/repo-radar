import { domainToUnicode } from 'node:url';
import type { Hook } from '../analysis/execution.js';
import type { Detection, ScannedFile } from '../analysis/types.js';
import { fileKind } from '../analysis/detectors.js';
import { LIMITS } from '../limits.js';
import {
  ACTIVE_CONTEXTS,
  NON_EXTERNAL,
  contextRank,
  type DomainCategory,
  type DomainContext,
  type DomainObservation,
  type ExternalDomain,
  type ExternalDomains,
} from './model.js';

/**
 * Static extraction of the hostnames a repository's own files refer to. Everything read here is attacker-controlled text:
 * lines are cut before any regex runs, every pattern has bounded repetition, the number of observations is capped, and no
 * observed host is ever resolved or contacted.
 */

// ---- extraction ----------------------------------------------------------------------------------------------------
const URL_RE = /\b(?:https?|wss?|ftps?|sftp|ssh|git):\/\/[^\s'"`<>(){}\\|^]{1,300}/gi;
const SCP_RE = /\bgit@([a-z0-9][a-z0-9.-]{0,250}\.[a-z]{2,24}):[\w./~-]{1,200}/gi;
const FETCHER_RE =
  /(?:^|[\s;&|(`$])(?:curl|wget|fetch|Invoke-WebRequest|iwr|irm)\b([^\n|;&]{0,400})/gi;
const BARE_RE =
  /^(['"]?)([a-z0-9][a-z0-9.-]{0,250}\.[a-z][a-z0-9-]{1,23})(?::(\d{1,5}))?(\/[^\s'"]{0,200})?\1$/i;

const SLASH_COMMENT =
  /\.(?:[cm]?[jt]sx?|go|rs|java|kt|kts|scala|groovy|gradle|cs|swift|c|cc|cpp|h|hpp|php)$/i;
const HASH_COMMENT =
  /(?:\.(?:py|pyw|sh|bash|zsh|ksh|ps1|rb|ya?ml|toml|mk|conf|cfg|ini|cmake|tf)|(?:^|\/)(?:Dockerfile[\w.-]*|Makefile|GNUmakefile|CMakeLists\.txt|Gemfile|Rakefile))$/i;
const BLOCK_COMMENT = SLASH_COMMENT;

/** Index where a line comment starts, or Infinity. A `//` that belongs to `scheme://` is not a comment. */
function lineCommentStart(line: string, path: string): number {
  if (SLASH_COMMENT.test(path)) {
    for (let i = line.indexOf('//'); i >= 0; i = line.indexOf('//', i + 2)) {
      if (i === 0 || line[i - 1] !== ':') return i;
    }
    return Infinity;
  }
  if (HASH_COMMENT.test(path)) {
    for (let i = line.indexOf('#'); i >= 0; i = line.indexOf('#', i + 1)) {
      if (i === 0 || /\s/.test(line[i - 1] as string)) return i;
    }
  }
  return Infinity;
}

// ---- classification ------------------------------------------------------------------------------------------------
const DOC_EXAMPLE_EXACT = new Set([
  'example.com',
  'example.net',
  'example.org',
  'yourdomain.com',
  'your-domain.com',
  'yourcompany.com',
  'mydomain.com',
  'example.local',
]);
const DOC_EXAMPLE_SUFFIX = [
  '.example',
  '.test',
  '.invalid',
  '.example.com',
  '.example.net',
  '.example.org',
];
const LOCAL_NET_SUFFIX = [
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.intranet',
  '.corp',
  '.localdomain',
];
const GITHUB_EXACT = new Set([
  'github.com',
  'api.github.com',
  'gist.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'ghcr.io',
]);
const REGISTRY_EXACT = new Set([
  'registry.npmjs.org',
  'npmjs.org',
  'www.npmjs.com',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'pypi.python.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'pkg.go.dev',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  'rubygems.org',
  'api.nuget.org',
  'www.nuget.org',
  'hub.docker.com',
  'registry-1.docker.io',
  'registry.hub.docker.com',
  'quay.io',
  'packagist.org',
  'repo.packagist.org',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
]);
const TELEMETRY_SUFFIX = [
  'google-analytics.com',
  'googletagmanager.com',
  'segment.io',
  'segment.com',
  'sentry.io',
  'mixpanel.com',
  'amplitude.com',
  'datadoghq.com',
  'posthog.com',
  'plausible.io',
  'hotjar.com',
  'bugsnag.com',
  'newrelic.com',
  'scarf.sh',
  'stats.g.doubleclick.net',
  'telemetry.vercel.com',
];
const TELEMETRY_LABEL = /^(?:telemetry|analytics|metrics|tracking|stats|beacon)\b/;

const matchesSuffix = (host: string, suffixes: readonly string[]): boolean =>
  suffixes.some(
    (s) => host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`),
  );

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number) as number[];
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** Category of a normalized host. Pure; no resolution. */
export function classifyHost(host: string): { category: DomainCategory; notes: string[] } {
  const notes: string[] = [];
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 127 || host === '0.0.0.0') return { category: 'localhost', notes };
    if (host === '169.254.169.254' || host === '100.100.100.200') {
      return { category: 'private_address', notes: ['cloud_metadata_endpoint'] };
    }
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      return { category: 'private_address', notes };
    return { category: 'ip_literal', notes };
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return { category: 'localhost', notes };
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host))
      return { category: 'private_address', notes };
    if (/^fd00:ec2::254$/.test(host))
      return { category: 'private_address', notes: ['cloud_metadata_endpoint'] };
    return { category: 'ip_literal', notes };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return { category: 'localhost', notes };
  if (DOC_EXAMPLE_EXACT.has(host) || matchesSuffix(host, DOC_EXAMPLE_SUFFIX))
    return { category: 'documentation_example', notes };
  if (!host.includes('.')) return { category: 'private_address', notes: ['single_label_host'] };
  if (matchesSuffix(host, LOCAL_NET_SUFFIX))
    return { category: 'private_address', notes: ['local_network_name'] };
  if (GITHUB_EXACT.has(host) || host.endsWith('.githubusercontent.com'))
    return { category: 'github', notes };
  if (REGISTRY_EXACT.has(host)) return { category: 'registry', notes };
  if (matchesSuffix(host, TELEMETRY_SUFFIX) || TELEMETRY_LABEL.test(host))
    return { category: 'telemetry', notes };
  return { category: 'generic_external', notes };
}

// ---- host parsing --------------------------------------------------------------------------------------------------
interface ParsedHost {
  hostname: string;
  display: string;
  port: number | null;
  scheme: string;
  ambiguity: ExternalDomain['ambiguity'];
  credentials: boolean;
}

const SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Han}/u,
  /\p{Script=Arabic}/u,
];

function ambiguityOf(hostname: string, raw: string): ExternalDomain['ambiguity'] {
  const unicode = (() => {
    try {
      return domainToUnicode(hostname);
    } catch {
      return hostname;
    }
  })();
  const hasNonAscii = [...raw].some((c) => c.charCodeAt(0) > 127);
  const mixed = unicode
    .split('.')
    .some((label) => SCRIPTS.filter((re) => re.test(label)).length >= 2);
  if (mixed) return 'mixed_script';
  if (hasNonAscii) return 'unicode';
  if (/(?:^|\.)xn--/.test(hostname)) return 'punycode';
  return 'none';
}

const LABEL = /^[a-z0-9_-]{1,63}$/;

/** Parse the host of a URL-like string. Returns null for template variables and anything malformed. */
export function parseHost(urlText: string): ParsedHost | null {
  const trimmed = urlText.replace(/[.,;:!?'"`)\]}>]+$/, '').slice(0, LIMITS.maxUrlChars);
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd < 1) return null;
  const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
  const rest = trimmed.slice(schemeEnd + 3);
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (!authority || /[$%{}*]/.test(authority)) return null; // template variables, printf, globs
  const credentials = authority.includes('@');
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const rawHost = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : hostPort.replace(/:\d*$/, '');
  let url: URL;
  try {
    url = new URL(`${scheme}://${hostPort}`);
  } catch {
    return null;
  }
  let hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  if (!hostname || hostname.length > 253) return null;
  const isIp = ipv4(hostname) !== null || hostname.includes(':');
  if (!isIp && !hostname.split('.').every((l) => LABEL.test(l))) return null;
  const port = url.port ? Number(url.port) : null;
  return {
    hostname,
    display: [...rawHost]
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join('')
      .slice(0, 253),
    port: port !== null && port > 0 && port <= 65535 ? port : null,
    scheme,
    ambiguity: isIp ? 'none' : ambiguityOf(hostname, rawHost),
    credentials,
  };
}

// ---- context -------------------------------------------------------------------------------------------------------
const BASE_CONFIDENCE: Record<DomainContext, number> = {
  install: 0.85,
  build: 0.7,
  release: 0.65,
  ci: 0.65,
  container: 0.65,
  runtime: 0.6,
  unknown: 0.4,
  metadata: 0.3,
  test: 0.2,
  docs: 0.2,
  comment: 0.1,
};

const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|testdata|e2e|mocks?|__mocks__)\/|\.(?:test|spec)\.[a-z]+$/i;
const DOCS_PATH =
  /(?:^|\/)(?:docs?|documentation|website|examples?|samples?|demos?)\/|\.(?:md|mdx|rst|txt|adoc)$/i;
const RELEASE_PATH = /(?:^|\/)[\w.-]*(?:release|publish|deploy|ship)[\w.-]*$/i;

export interface ContextInputs {
  installFiles: ReadonlySet<string>;
  buildFiles: ReadonlySet<string>;
}

export function fileContext(file: ScannedFile, c: ContextInputs): DomainContext {
  const p = file.path;
  if (c.installFiles.has(p)) return 'install';
  if (file.role === 'workflow') return 'ci';
  if (TEST_PATH.test(p)) return 'test';
  if (DOCS_PATH.test(p)) return 'docs';
  if (fileKind(p) === 'docker') return 'container';
  if (c.buildFiles.has(p)) return 'build';
  if (file.role === 'manifest') return 'metadata';
  if (RELEASE_PATH.test(p)) return 'release';
  if (file.role === 'build' || fileKind(p) === 'make') return 'build';
  if (file.role === 'script') return 'build';
  if (file.role === 'source') return 'runtime';
  return 'unknown';
}

// ---- aggregation ---------------------------------------------------------------------------------------------------
interface Agg {
  hostname: string;
  display: string;
  ports: Set<number>;
  schemes: Set<string>;
  ambiguity: ExternalDomain['ambiguity'];
  credentials: boolean;
  category: DomainCategory;
  notes: string[];
  obs: DomainObservation[];
  total: number;
}

export interface ExtractInput {
  files: ScannedFile[];
  hooks: Hook[];
  detections: Detection[];
}

export function extractDomains(input: ExtractInput): ExternalDomains {
  const installFiles = new Set<string>();
  const buildFiles = new Set<string>();
  for (const h of input.hooks)
    for (const f of h.files) (h.context === 'install' ? installFiles : buildFiles).add(f);
  for (const d of input.detections) if (d.contexts.includes('install')) installFiles.add(d.file);
  const ctx: ContextInputs = { installFiles, buildFiles };

  const aggs = new Map<string, Agg>();
  const limits: string[] = [];
  let observations = 0;
  let unparsed = 0;
  const filtered: Record<string, number> = {};
  const seenFiltered = new Set<string>();

  const add = (
    parsed: ParsedHost,
    context: DomainContext,
    file: string,
    line: number,
    bare: boolean,
    inComment: boolean,
  ): void => {
    if (observations >= LIMITS.maxDomainObservations) {
      if (!limits.includes('observation limit reached')) limits.push('observation limit reached');
      return;
    }
    observations++;
    const { category, notes } = classifyHost(parsed.hostname);
    if (NON_EXTERNAL.has(category)) {
      if (!seenFiltered.has(parsed.hostname)) {
        seenFiltered.add(parsed.hostname);
        filtered[category] = (filtered[category] ?? 0) + 1;
      }
      return;
    }
    const eff: DomainContext = inComment ? 'comment' : context;
    const conf = Math.max(0, Math.min(1, BASE_CONFIDENCE[eff] - (bare ? 0.1 : 0)));
    let a = aggs.get(parsed.hostname);
    if (!a) {
      if (aggs.size >= LIMITS.maxDomainsTracked) {
        if (!limits.includes('distinct host limit reached'))
          limits.push('distinct host limit reached');
        return;
      }
      a = {
        hostname: parsed.hostname,
        display: parsed.display,
        ports: new Set(),
        schemes: new Set(),
        ambiguity: parsed.ambiguity,
        credentials: false,
        category,
        notes,
        obs: [],
        total: 0,
      };
      aggs.set(parsed.hostname, a);
    }
    a.total++;
    if (parsed.port) a.ports.add(parsed.port);
    if (parsed.scheme) a.schemes.add(parsed.scheme);
    if (parsed.credentials) a.credentials = true;
    if (!a.obs.some((o) => o.context === eff && o.file === file && o.line === line))
      a.obs.push({ context: eff, file: file.slice(0, 300), line, confidence: conf, bare });
  };

  const scanText = (
    path: string,
    text: string,
    context: DomainContext,
    role: ScannedFile['role'],
  ): void => {
    let inBlock = false;
    const lines = text.split(/\r?\n/, LIMITS.maxLinesPerFile);
    let perFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] as string;
      const line = raw.length > LIMITS.maxLineChars ? raw.slice(0, LIMITS.maxLineChars) : raw;
      if (line.length < 4) continue;
      const lineComment = lineCommentStart(line, path);
      // block comments of C-like languages, tracked line by line (strings containing /* are not modelled)
      const blockRanges: [number, number][] = [];
      if (BLOCK_COMMENT.test(path)) {
        let pos = 0;
        let open = inBlock ? 0 : -1;
        for (;;) {
          if (open < 0) {
            const s = line.indexOf('/*', pos);
            if (s < 0) break;
            open = s;
            pos = s + 2;
          }
          const e = line.indexOf('*/', pos);
          if (e < 0) {
            blockRanges.push([open, Infinity]);
            inBlock = true;
            break;
          }
          blockRanges.push([open, e + 2]);
          inBlock = false;
          pos = e + 2;
          open = -1;
        }
      }
      const commentAt = (idx: number): boolean =>
        idx >= lineComment || blockRanges.some(([a, b]) => idx >= a && idx < b);
      // markdown/HTML comments in docs are just docs; role-based context already covers them
      if (
        !line.includes('/') &&
        !line.includes('@') &&
        !/\b(?:curl|wget|fetch|iwr|irm|Invoke-WebRequest)\b/.test(line)
      )
        continue;

      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(line)) !== null) {
        if (perFile >= LIMITS.maxDomainsPerFile) break;
        const parsed = parseHost(m[0]);
        if (!parsed) {
          unparsed++;
          continue;
        }
        perFile++;
        add(parsed, context, path, i + 1, false, commentAt(m.index));
      }
      SCP_RE.lastIndex = 0;
      while ((m = SCP_RE.exec(line)) !== null) {
        if (perFile >= LIMITS.maxDomainsPerFile) break;
        const parsed = parseHost(`ssh://${m[1]}`);
        if (!parsed) continue;
        perFile++;
        add(parsed, context, path, i + 1, false, commentAt(m.index));
      }
      // `curl example.org/install.sh | sh`: a bare host after a fetch command (the scheme defaults to http)
      if (role !== 'source' || /\b(?:curl|wget)\b/.test(line)) {
        FETCHER_RE.lastIndex = 0;
        while ((m = FETCHER_RE.exec(line)) !== null) {
          for (const tok of (m[1] ?? '').trim().split(/\s+/, 12)) {
            if (!tok || tok.startsWith('-') || tok.includes('://')) continue;
            const b = BARE_RE.exec(tok);
            if (!b || !(b[3] || b[4])) continue; // a path or a port is required: `install.sh` alone is a file name
            if (perFile >= LIMITS.maxDomainsPerFile) break;
            const parsed = parseHost(`http://${b[2]}${b[3] ? ':' + b[3] : ''}`);
            if (!parsed) continue;
            perFile++;
            add(parsed, context, path, i + 1, true, commentAt(m.index));
          }
        }
      }
    }
    if (perFile >= LIMITS.maxDomainsPerFile && !limits.includes('per-file reference limit reached'))
      limits.push('per-file reference limit reached');
  };

  for (const f of input.files) scanText(f.path, f.content, fileContext(f, ctx), f.role);
  // the lifecycle command strings (package.json scripts and the like) are not separate files
  for (const h of input.hooks)
    if (h.script)
      scanText(h.files[0] ?? `${h.ecosystem}:${h.name}`, h.script, h.context, 'manifest');

  const domains: ExternalDomain[] = [...aggs.values()].map((a) => {
    const obs = [...a.obs].sort(
      (x, y) => contextRank(x.context) - contextRank(y.context) || y.confidence - x.confidence,
    );
    const contexts = [...new Set(obs.map((o) => o.context))].sort(
      (x, y) => contextRank(x) - contextRank(y),
    );
    const strongest = (contexts[0] ?? 'unknown') as DomainContext;
    return {
      hostname: a.hostname,
      display: a.display === a.hostname ? a.hostname : a.display,
      ports: [...a.ports].sort((x, y) => x - y).slice(0, 5),
      schemes: [...a.schemes].sort().slice(0, 6),
      category: a.category,
      ambiguity: a.ambiguity,
      strongest_context: strongest,
      contexts,
      confidence: Math.max(...obs.filter((o) => o.context === strongest).map((o) => o.confidence)),
      observations: obs.slice(0, 6),
      observations_total: a.total,
      credentials_in_url: a.credentials,
      notes: a.notes.slice(0, 3),
    };
  });
  domains.sort(
    (a, b) =>
      Number(ACTIVE_CONTEXTS.has(b.strongest_context)) -
        Number(ACTIVE_CONTEXTS.has(a.strongest_context)) ||
      contextRank(a.strongest_context) - contextRank(b.strongest_context) ||
      (a.hostname < b.hostname ? -1 : 1),
  );
  return {
    version: '1',
    status: 'analyzed',
    domains: domains.slice(0, LIMITS.maxDomainsReported),
    domains_total: domains.length,
    filtered,
    files_scanned: input.files.length,
    unparsed,
    limits_hit: limits.slice(0, 10),
    not_available: [
      'only fetched files are read (workflows, manifests, scripts, build files, a source sample): a host in an unread file is unknown, not absent',
      'a hostname in a file means the file refers to it; no connection is observed and no host is resolved or contacted',
    ],
  };
}
