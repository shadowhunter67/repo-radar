import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { sanitizeForTerminal } from '../util/text.js';
import { type DepEcosystem, normalizeName } from './model.js';
import { satisfies } from './semver.js';

/**
 * Lockfile readers. Static text parsing only; nothing here runs a package manager.
 * A lockfile is evidence about the revision it is committed in, which makes it the strongest source for
 * "which exact version does THIS revision use".
 */

export const MAX_LOCK_ENTRIES = 10_000;

export type LockFormat =
  | 'package-lock.json'
  | 'yarn.lock'
  | 'pnpm-lock.yaml'
  | 'Cargo.lock'
  | 'poetry.lock'
  | 'uv.lock'
  | 'go.sum';

export interface LockedEntry {
  name: string;
  version: string;
  /** npm: install path (`node_modules/a/node_modules/b`); '' otherwise. */
  path: string;
  dev?: boolean;
  optional?: boolean;
  /** Cargo path/workspace crates carry no registry source. */
  local?: boolean;
}

export interface LockResolution {
  /** Exact versions the lockfile records for the request (0 = not in the lockfile). */
  versions: string[];
  /** How the match was made, for the derived_from trail. */
  via: string;
}

export interface LockIndex {
  path: string;
  format: LockFormat;
  ecosystem: DepEcosystem;
  entries: LockedEntry[];
  truncated: boolean;
  /** Directory the lockfile lives in ('' = repository root). */
  dir: string;
  resolve(importerDir: string, name: string, spec: string): LockResolution;
  /** go.sum: is `module@version` listed? undefined for other formats. */
  lists?(name: string, version: string): boolean;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export const LOCK_BASENAMES: readonly LockFormat[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
];
export const isLockPath = (p: string): boolean =>
  (LOCK_BASENAMES as readonly string[]).includes(base(p)) || base(p) === 'npm-shrinkwrap.json';

function byNameIndex(entries: LockedEntry[]): Map<string, LockedEntry[]> {
  const m = new Map<string, LockedEntry[]>();
  for (const e of entries) {
    const l = m.get(e.name);
    if (l) l.push(e);
    else m.set(e.name, [e]);
  }
  return m;
}

const uniq = (a: string[]): string[] => [...new Set(a)];

/** `importerDir` relative to the lockfile's directory, or undefined when the lockfile does not cover it. */
function relTo(lockDir: string, importerDir: string): string | undefined {
  if (importerDir === lockDir) return '';
  if (lockDir === '') return importerDir;
  return importerDir.startsWith(`${lockDir}/`) ? importerDir.slice(lockDir.length + 1) : undefined;
}

export function parseLock(path: string, text: string): LockIndex | undefined {
  const b = base(path) === 'npm-shrinkwrap.json' ? 'package-lock.json' : base(path);
  const dir = dirOf(path);
  try {
    switch (b) {
      case 'package-lock.json':
        return parsePackageLock(path, dir, text);
      case 'yarn.lock':
        return parseYarnLock(path, dir, text);
      case 'pnpm-lock.yaml':
        return parsePnpmLock(path, dir, text);
      case 'Cargo.lock':
        return parseTomlLock(path, dir, text, 'Cargo.lock', 'crates.io');
      case 'poetry.lock':
        return parseTomlLock(path, dir, text, 'poetry.lock', 'PyPI');
      case 'uv.lock':
        return parseTomlLock(path, dir, text, 'uv.lock', 'PyPI');
      case 'go.sum':
        return parseGoSum(path, dir, text);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/* ---- package-lock.json (lockfileVersion 1, 2, 3) ------------------------------------------------------------ */

function parsePackageLock(path: string, dir: string, text: string): LockIndex | undefined {
  const j: unknown = JSON.parse(text);
  if (!isObj(j)) return undefined;
  const entries: LockedEntry[] = [];
  let truncated = false;
  const push = (e: LockedEntry): void => {
    if (entries.length >= MAX_LOCK_ENTRIES) truncated = true;
    else entries.push(e);
  };
  if (isObj(j['packages'])) {
    for (const [p, v] of Object.entries(j['packages'])) {
      if (!p.includes('node_modules/') || !isObj(v) || v['link'] === true) continue;
      const name = p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const version = str(v['version']);
      if (name && version)
        push({
          name,
          version,
          path: p,
          ...(v['dev'] === true ? { dev: true } : {}),
          ...(v['optional'] === true ? { optional: true } : {}),
        });
    }
  } else if (isObj(j['dependencies'])) {
    // lockfileVersion 1: nested `dependencies` trees.
    const walk = (deps: unknown, prefix: string, depth: number): void => {
      if (!isObj(deps) || depth > 12) return;
      for (const [name, v] of Object.entries(deps)) {
        if (!isObj(v)) continue;
        const version = str(v['version']);
        const here = `${prefix}node_modules/${name}`;
        if (version && !/^(?:file:|git|https?:)/.test(version))
          push({
            name,
            version,
            path: here,
            ...(v['dev'] === true ? { dev: true } : {}),
            ...(v['optional'] === true ? { optional: true } : {}),
          });
        walk(v['dependencies'], `${here}/`, depth + 1);
      }
    };
    walk(j['dependencies'], '', 0);
  } else return undefined;
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return {
    path,
    dir,
    format: 'package-lock.json',
    ecosystem: 'npm',
    entries,
    truncated,
    resolve(importerDir, name) {
      // Node resolution: the importer's own node_modules, then each ancestor's, then the root.
      let d = relTo(dir, importerDir);
      if (d === undefined) return { versions: [], via: path };
      for (let i = 0; i < 20; i++) {
        const hit = byPath.get(`${d ? `${d}/` : ''}node_modules/${name}`);
        if (hit) return { versions: [hit.version], via: `${path}#${hit.path}` };
        if (!d) break;
        d = dirOf(d);
      }
      return { versions: [], via: path };
    },
  };
}

/* ---- yarn.lock (v1 classic and berry headers) ---------------------------------------------------------------- */

function parseYarnLock(path: string, dir: string, text: string): LockIndex {
  const entries: LockedEntry[] = [];
  const bySpec = new Map<string, string>();
  let truncated = false;
  let headers: string[] = [];
  const seenEntry = new Set<string>();
  for (const raw of text.split(/\r?\n/, 400_000)) {
    if (raw === '' || raw.startsWith('#')) continue;
    if (!raw.startsWith(' ') && raw.endsWith(':')) {
      headers = raw
        .slice(0, -1)
        .split(/,\s*/)
        .map((h) => h.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      continue;
    }
    const m = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(raw);
    if (m && m[1] && headers.length > 0) {
      for (const h of headers) {
        const at = h.lastIndexOf('@');
        if (at <= 0) continue;
        const name = h.slice(0, at);
        const spec = h.slice(at + 1).replace(/^npm:/, '');
        if (/^(?:workspace:|patch:|file:|link:|portal:|exec:)/.test(spec)) continue;
        bySpec.set(`${name}@${spec}`, m[1]);
        if (entries.length >= MAX_LOCK_ENTRIES) truncated = true;
        else if (!seenEntry.has(`${name}@${m[1]}`)) {
          seenEntry.add(`${name}@${m[1]}`);
          entries.push({ name, version: m[1], path: '' });
        }
      }
      headers = [];
    }
  }
  const idx = byNameIndex(entries);
  return {
    path,
    dir,
    format: 'yarn.lock',
    ecosystem: 'npm',
    entries,
    truncated,
    resolve(_importer, name, spec) {
      const exact = bySpec.get(`${name}@${spec}`);
      if (exact) return { versions: [exact], via: `${path}#${name}@${spec}` };
      // Request not listed verbatim (e.g. `^1.0.0` merged with other specs): fall back only if unambiguous.
      const all = uniq((idx.get(name) ?? []).map((e) => e.version));
      return all.length === 1
        ? { versions: all, via: `${path}#${name}` }
        : { versions: all, via: path };
    },
  };
}

/* ---- pnpm-lock.yaml ------------------------------------------------------------------------------------------ */

const stripPeers = (v: string): string => v.replace(/\(.*$/, '').replace(/_.*$/, '');

function parsePnpmLock(path: string, dir: string, text: string): LockIndex | undefined {
  const doc: unknown = parseYaml(text, { schema: 'core', maxAliasCount: 50, strict: false });
  if (!isObj(doc)) return undefined;
  const entries: LockedEntry[] = [];
  let truncated = false;
  const seen = new Set<string>();
  const push = (name: string, version: string, extra: Partial<LockedEntry> = {}): void => {
    const k = `${name}@${version}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (entries.length >= MAX_LOCK_ENTRIES) truncated = true;
    else entries.push({ name, version, path: '', ...extra });
  };
  for (const section of ['packages', 'snapshots']) {
    const pk = doc[section];
    if (!isObj(pk)) continue;
    for (const key of Object.keys(pk).slice(0, MAX_LOCK_ENTRIES * 2)) {
      // v9: `name@1.2.3(peer@1)`; v6: `/name@1.2.3(peer@1)`; v5: `/name/1.2.3_peer`
      const k = key.replace(/^\//, '');
      const at = k.indexOf('@', 1);
      if (at > 0) push(k.slice(0, at), stripPeers(k.slice(at + 1)));
      else {
        const slash = k.lastIndexOf('/');
        if (slash > 0) push(k.slice(0, slash), stripPeers(k.slice(slash + 1)));
      }
    }
  }
  const importers = new Map<string, Map<string, string>>();
  const readImporter = (id: string, o: unknown): void => {
    if (!isObj(o)) return;
    const m = importers.get(id) ?? new Map<string, string>();
    for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = o[sec];
      if (!isObj(deps)) continue;
      for (const [n, v] of Object.entries(deps)) {
        const ver = isObj(v) ? str(v['version']) : str(v);
        if (ver && !/^(?:link:|file:|workspace:)/.test(ver)) m.set(n, stripPeers(ver));
      }
    }
    importers.set(id, m);
  };
  if (isObj(doc['importers']))
    for (const [id, o] of Object.entries(doc['importers'])) readImporter(id === '.' ? '' : id, o);
  else readImporter('', doc);
  const idx = byNameIndex(entries);
  return {
    path,
    dir,
    format: 'pnpm-lock.yaml',
    ecosystem: 'npm',
    entries,
    truncated,
    resolve(importerDir, name) {
      const rel = relTo(dir, importerDir);
      if (rel === undefined) return { versions: [], via: path };
      const v = importers.get(rel)?.get(name);
      if (v) return { versions: [v], via: `${path}#importers.${rel || '.'}` };
      const all = uniq((idx.get(name) ?? []).map((e) => e.version));
      return all.length === 1
        ? { versions: all, via: `${path}#packages` }
        : { versions: all, via: path };
    },
  };
}

/* ---- Cargo.lock / poetry.lock / uv.lock ---------------------------------------------------------------------- */

function parseTomlLock(
  path: string,
  dir: string,
  text: string,
  format: 'Cargo.lock' | 'poetry.lock' | 'uv.lock',
  ecosystem: DepEcosystem,
): LockIndex | undefined {
  const t = parseToml(text) as Record<string, unknown>;
  if (!Array.isArray(t['package'])) return undefined;
  const entries: LockedEntry[] = [];
  let truncated = false;
  for (const p of t['package']) {
    if (!isObj(p)) continue;
    const name = str(p['name']);
    const version = str(p['version']);
    if (!name || !version) continue;
    // Cargo workspace/path crates have no `source`; uv marks local packages with source.editable/virtual/directory.
    const src = p['source'];
    const local =
      format === 'Cargo.lock'
        ? !str(src)
        : isObj(src) && ('editable' in src || 'virtual' in src || 'directory' in src);
    if (entries.length >= MAX_LOCK_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name, version, path: '', ...(local ? { local: true } : {}) });
  }
  const idx = byNameIndex(entries);
  const key = (n: string): string => normalizeName(ecosystem, n);
  const norm = new Map<string, LockedEntry[]>();
  for (const [n, l] of idx) norm.set(key(n), [...(norm.get(key(n)) ?? []), ...l]);
  return {
    path,
    dir,
    format,
    ecosystem,
    entries,
    truncated,
    resolve(_importer, name, spec) {
      const all = (norm.get(key(name)) ?? []).filter((e) => !e.local);
      const versions = uniq(all.map((e) => e.version));
      if (versions.length > 1 && format === 'Cargo.lock') {
        // Several semver-incompatible copies are normal in Cargo; narrow by the requirement when it parses.
        const fit = versions.filter((v) => satisfies(spec || '*', v, 'cargo') === true);
        if (fit.length >= 1) return { versions: fit, via: `${path}#${name}` };
      }
      return { versions, via: `${path}#${name}` };
    },
  };
}

/* ---- go.sum -------------------------------------------------------------------------------------------------- */

function parseGoSum(path: string, dir: string, text: string): LockIndex {
  const set = new Set<string>();
  const entries: LockedEntry[] = [];
  let truncated = false;
  for (const raw of text.split(/\r?\n/, 200_000)) {
    const [mod, ver] = raw.trim().split(/\s+/);
    if (!mod || !ver) continue;
    const v = ver.replace(/\/go\.mod$/, '');
    const k = `${mod}@${v}`;
    if (set.has(k)) continue;
    set.add(k);
    if (entries.length >= MAX_LOCK_ENTRIES) truncated = true;
    else entries.push({ name: mod, version: v, path: '' });
  }
  return {
    path,
    dir,
    format: 'go.sum',
    ecosystem: 'Go',
    entries,
    truncated,
    // go.sum lists every module version ever needed (not the build list); it confirms presence, nothing more.
    resolve: () => ({ versions: [], via: path }),
    lists: (name, version) => set.has(`${name}@${version}`),
  };
}

export const safeLockName = (s: string): string => sanitizeForTerminal(s, 214);
