import { parse as parseToml } from 'smol-toml';

/** Static manifest parsing only. Nothing here runs a package manager or evaluates code. */
export type Ecosystem = 'npm' | 'PyPI' | 'Go' | 'crates.io';

export interface Dependency {
  name: string;
  spec: string;
}

export interface ParsedManifest {
  file: string;
  ecosystem: Ecosystem;
  name?: string;
  description?: string;
  keywords: string[];
  /** Direct runtime dependencies. */
  dependencies: Dependency[];
  devDependencyCount: number;
  devDependencyNames: string[];
  /** Executable entry points (bin names, console scripts, `[[bin]]`). */
  entrypoints: string[];
  isPrivate?: boolean;
  /** PEP 517 `[build-system] build-backend` (pyproject.toml), when declared. */
  buildBackend?: string;
  /** npm `scripts` (name -> command), bounded in count and length; never executed. */
  scripts?: Record<string, string>;
  /** Files the manifest names as entry points (npm main/bin/exports string). */
  entryFiles?: string[];
}

export interface LockedPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

export const MANIFEST_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
] as const;

export const LOCK_FILES = [
  'package-lock.json',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function safeToml(text: string): Record<string, unknown> | undefined {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function depsFromObject(o: unknown): Dependency[] {
  if (!isObj(o)) return [];
  return Object.entries(o).map(([name, spec]) => ({
    name,
    spec: typeof spec === 'string' ? spec : JSON.stringify(spec ?? ''),
  }));
}

export function parseManifest(file: string, text: string): ParsedManifest | undefined {
  const base = file.split('/').pop() ?? file;
  switch (base) {
    case 'package.json':
      return parsePackageJson(file, text);
    case 'pyproject.toml':
      return parsePyproject(file, text);
    case 'requirements.txt':
      return parseRequirements(file, text);
    case 'go.mod':
      return parseGoMod(file, text);
    case 'Cargo.toml':
      return parseCargoToml(file, text);
    default:
      return undefined;
  }
}

function boundedScripts(v: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!isObj(v)) return out;
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n >= 100) break;
    if (typeof val === 'string' && k.length <= 100) {
      out[k] = val.slice(0, 4000);
      n++;
    }
  }
  return out;
}

function npmEntryFiles(j: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of [j['main'], j['module'], j['bin']]) {
    if (typeof v === 'string') out.push(v);
    else if (isObj(v)) for (const x of Object.values(v)) if (typeof x === 'string') out.push(x);
  }
  return out.slice(0, 20);
}

function parsePackageJson(file: string, text: string): ParsedManifest | undefined {
  const j = safeJson(text);
  if (!isObj(j)) return undefined;
  const bin = j['bin'];
  const entrypoints =
    typeof bin === 'string' ? [str(j['name']) ?? 'bin'] : isObj(bin) ? Object.keys(bin) : [];
  const m: ParsedManifest = {
    file,
    ecosystem: 'npm',
    keywords: strArr(j['keywords']),
    dependencies: depsFromObject(j['dependencies']),
    devDependencyCount: isObj(j['devDependencies']) ? Object.keys(j['devDependencies']).length : 0,
    devDependencyNames: isObj(j['devDependencies']) ? Object.keys(j['devDependencies']) : [],
    entrypoints,
    isPrivate: j['private'] === true,
    scripts: boundedScripts(j['scripts']),
    entryFiles: npmEntryFiles(j),
  };
  const name = str(j['name']);
  const description = str(j['description']);
  if (name) m.name = name;
  if (description) m.description = description;
  return m;
}

function pep508Name(spec: string): { name: string; spec: string } | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;#]*)/.exec(spec);
  if (!m || !m[1]) return undefined;
  return { name: m[1], spec: (m[2] ?? '').trim() };
}

function parsePyproject(file: string, text: string): ParsedManifest | undefined {
  const t = safeToml(text);
  if (!t) return undefined;
  const project = isObj(t['project']) ? t['project'] : undefined;
  const tool = isObj(t['tool']) ? t['tool'] : undefined;
  const poetry = tool && isObj(tool['poetry']) ? tool['poetry'] : undefined;
  const m: ParsedManifest = {
    file,
    ecosystem: 'PyPI',
    keywords: [],
    dependencies: [],
    devDependencyCount: 0,
    devDependencyNames: [],
    entrypoints: [],
  };
  if (project) {
    const name = str(project['name']);
    const description = str(project['description']);
    if (name) m.name = name;
    if (description) m.description = description;
    m.keywords = strArr(project['keywords']);
    m.dependencies = strArr(project['dependencies'])
      .map(pep508Name)
      .filter((d): d is Dependency => !!d);
    if (isObj(project['scripts'])) m.entrypoints = Object.keys(project['scripts']);
  }
  if (poetry) {
    m.name ??= str(poetry['name']);
    m.description ??= str(poetry['description']);
    if (m.keywords.length === 0) m.keywords = strArr(poetry['keywords']);
    if (m.dependencies.length === 0) {
      m.dependencies = depsFromObject(poetry['dependencies']).filter((d) => d.name !== 'python');
    }
    if (isObj(poetry['scripts'])) m.entrypoints.push(...Object.keys(poetry['scripts']));
  }
  if (!project && !poetry) return undefined;
  const backend = isObj(t['build-system']) ? str(t['build-system']['build-backend']) : undefined;
  if (backend) m.buildBackend = backend;
  return m;
}

function parseRequirements(file: string, text: string): ParsedManifest {
  const deps: Dependency[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-') || line.includes('://')) continue;
    const d = pep508Name(line);
    if (d) deps.push(d);
  }
  return {
    file,
    ecosystem: 'PyPI',
    keywords: [],
    dependencies: deps,
    devDependencyCount: 0,
    devDependencyNames: [],
    entrypoints: [],
  };
}

interface GoMod {
  module?: string;
  requires: { name: string; version: string; indirect: boolean }[];
}
function readGoMod(text: string): GoMod {
  const out: GoMod = { requires: [] };
  let inBlock = false;
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    const indirect = /\/\/\s*indirect/.test(raw);
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const [name, version] = line.split(/\s+/);
      if (name && version) out.requires.push({ name, version, indirect });
      continue;
    }
    const mod = /^module\s+(\S+)/.exec(line);
    if (mod) {
      out.module = mod[1]?.replace(/^"|"$/g, '');
      continue;
    }
    if (/^require\s*\(\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (single && single[1] && single[2]) {
      out.requires.push({ name: single[1], version: single[2], indirect });
    }
  }
  return out;
}

function parseGoMod(file: string, text: string): ParsedManifest {
  const g = readGoMod(text);
  const m: ParsedManifest = {
    file,
    ecosystem: 'Go',
    keywords: [],
    dependencies: g.requires
      .filter((r) => !r.indirect)
      .map((r) => ({ name: r.name, spec: r.version })),
    devDependencyCount: 0,
    devDependencyNames: [],
    entrypoints: [],
  };
  if (g.module) m.name = g.module;
  return m;
}

function parseCargoToml(file: string, text: string): ParsedManifest | undefined {
  const t = safeToml(text);
  if (!t) return undefined;
  const pkg = isObj(t['package']) ? t['package'] : undefined;
  const m: ParsedManifest = {
    file,
    ecosystem: 'crates.io',
    keywords: strArr(pkg?.['keywords']),
    dependencies: depsFromObject(t['dependencies']),
    devDependencyCount: isObj(t['dev-dependencies'])
      ? Object.keys(t['dev-dependencies']).length
      : 0,
    devDependencyNames: isObj(t['dev-dependencies']) ? Object.keys(t['dev-dependencies']) : [],
    entrypoints: [],
  };
  const name = str(pkg?.['name']);
  const description = str(pkg?.['description']);
  if (name) m.name = name;
  if (description) m.description = description;
  if (Array.isArray(t['bin'])) {
    for (const b of t['bin']) if (isObj(b) && str(b['name'])) m.entrypoints.push(String(b['name']));
  }
  return m;
}

const MAX_LOCKED = 1000;

/** Extract exact (name, version) pairs suitable for OSV lookups. */
export function parseLockedPackages(file: string, text: string): LockedPackage[] {
  const base = file.split('/').pop() ?? file;
  const out: LockedPackage[] = [];
  const push = (p: LockedPackage): void => {
    if (out.length < MAX_LOCKED) out.push(p);
  };
  switch (base) {
    case 'package-lock.json': {
      const j = safeJson(text);
      if (!isObj(j) || !isObj(j['packages'])) return [];
      for (const [path, v] of Object.entries(j['packages'])) {
        if (!path.includes('node_modules/') || !isObj(v)) continue;
        const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const version = str(v['version']);
        if (name && version && !v['link']) push({ ecosystem: 'npm', name, version });
      }
      return out;
    }
    case 'Cargo.lock':
    case 'poetry.lock':
    case 'uv.lock': {
      const t = safeToml(text);
      if (!t || !Array.isArray(t['package'])) return [];
      const eco: Ecosystem = base === 'Cargo.lock' ? 'crates.io' : 'PyPI';
      for (const p of t['package']) {
        if (!isObj(p)) continue;
        const name = str(p['name']);
        const version = str(p['version']);
        // Cargo path/workspace crates have no `source`; skip them (not on crates.io).
        if (name && version && (base !== 'Cargo.lock' || str(p['source']))) {
          push({ ecosystem: eco, name, version });
        }
      }
      return out;
    }
    case 'go.mod':
      for (const r of readGoMod(text).requires)
        push({ ecosystem: 'Go', name: r.name, version: r.version });
      return out;
    case 'requirements.txt':
      for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
        const m =
          /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.+!_-]+)/.exec(raw);
        if (m && m[1] && m[2]) push({ ecosystem: 'PyPI', name: m[1], version: m[2] });
      }
      return out;
    default:
      return [];
  }
}
