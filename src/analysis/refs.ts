import { posix } from 'node:path';
import { LIMITS } from '../limits.js';

/**
 * Finds repository-local files that a script or source file refers to. Used to follow install-time
 * execution paths (script -> file -> file). Everything is resolved inside the git tree: references that
 * escape the repository root or do not exist in the tree are ignored, and nothing is ever executed.
 */
const RUN_REF =
  /(?:^|[\s;&|(])(?:node|nodejs|bun|tsx|ts-node|sh|bash|zsh|python3?|ruby|perl|php|pwsh|source|\.)\s+(?:-[A-Za-z-]+\s+)*["']?(\.{0,2}\/?[\w@~+-][\w@./~+-]{0,200})/g;
const DIRECT_PATH = /(?:^|[\s;&|(])(\.\/[\w@./~+-]{1,200})/g;
const JS_IMPORT = /(?:require\(\s*|from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"\n]{1,200})['"]/g;

const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.sh', '.py', '/index.js', '/index.ts'];

export function resolveRef(
  ref: string,
  fromDir: string,
  tree: ReadonlySet<string>,
): string | undefined {
  const cleaned = ref.replace(/[;,)"'`]+$/g, '');
  if (!cleaned || cleaned.startsWith('/') || cleaned.includes('\\') || /^[a-z]+:/i.test(cleaned))
    return undefined;
  const joined = posix.normalize(posix.join(fromDir, cleaned));
  if (joined.startsWith('..') || joined === '.') return undefined;
  for (const ext of EXTENSIONS) {
    const candidate = joined + ext;
    if (tree.has(candidate)) return candidate;
  }
  return undefined;
}

const PY_FROM = /^\s*from\s+(\.{0,5})([A-Za-z_][\w.]{0,200})?\s+import\s+([\w*, ()]+)/;
const PY_IMPORT =
  /^\s*import\s+([A-Za-z_][\w.]{0,200}(?:\s{0,4},\s{0,4}[A-Za-z_][\w.]{0,200}){0,10})/;

/** Resolve `a.b.c` against first-party locations only (the importing directory, the repository root, `src/`). */
export function resolvePyModule(
  dotted: string,
  fromDir: string,
  tree: ReadonlySet<string>,
  relativeLevel = 0,
): string | undefined {
  const rel = dotted.split('.').join('/');
  let bases = [fromDir, '', 'src'];
  if (relativeLevel > 0) {
    let d = fromDir;
    for (let i = 1; i < relativeLevel; i++) d = posix.dirname(d) === '.' ? '' : posix.dirname(d);
    bases = [d];
  }
  for (const base of bases) {
    const root = base ? `${base}/` : '';
    for (const c of [`${root}${rel}.py`, `${root}${rel}/__init__.py`]) {
      const n = posix.normalize(c);
      if (!n.startsWith('..') && tree.has(n)) return n;
    }
  }
  return undefined;
}

function pythonImports(line: string, fromDir: string, tree: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const f = PY_FROM.exec(line);
  if (f) {
    const level = (f[1] ?? '').length;
    const mod = f[2] ?? '';
    const direct = mod ? resolvePyModule(mod, fromDir, tree, level) : undefined;
    if (direct) out.push(direct);
    // `from . import x` / `from pkg import x`: x may itself be a module
    for (const name of (f[3] ?? '').split(',').map((x) => x.trim().replace(/[()]/g, ''))) {
      if (!/^[A-Za-z_]\w*$/.test(name)) continue;
      const r = resolvePyModule(mod ? `${mod}.${name}` : name, fromDir, tree, level);
      if (r) out.push(r);
    }
  }
  const i = PY_IMPORT.exec(line);
  if (i)
    for (const m of (i[1] ?? '').split(',')) {
      const r = resolvePyModule(m.trim(), fromDir, tree);
      if (r) out.push(r);
    }
  return out;
}

export function extractLocalRefs(
  content: string,
  fromPath: string,
  tree: ReadonlySet<string>,
): string[] {
  const fromDir = posix.dirname(fromPath) === '.' ? '' : posix.dirname(fromPath);
  const found: string[] = [];
  const lines = content.split('\n', LIMITS.maxLinesPerFile);
  for (const raw of lines) {
    const line = raw.slice(0, LIMITS.maxLineChars);
    if (fromPath.endsWith('.py'))
      for (const r of pythonImports(line, fromDir, tree))
        if (r !== fromPath && !found.includes(r)) found.push(r);
    for (const re of [RUN_REF, DIRECT_PATH, JS_IMPORT]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(line)) && guard++ < 20) {
        const r = resolveRef(m[1] as string, fromDir, tree);
        if (r && r !== fromPath && !found.includes(r)) found.push(r);
      }
    }
    if (found.length >= LIMITS.maxRefsPerRound * 4) break;
  }
  return found;
}
