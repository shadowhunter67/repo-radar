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
