import { isSafeTreePath } from './tree.js';

/**
 * Static structural hints for the targeted tree walk. A workspace or build manifest that sits near the root names the
 * directories that matter ("members = [crates/*]", "add_subdirectory(src)", "include ':app'"), so the walk can follow
 * what the project itself declares instead of treating every directory alike. Files are read as text and pattern-matched;
 * nothing is evaluated, no build tool runs, and every produced path passes the tree path safety check.
 */
export const HINT_FILE_RE =
  /^(?:package\.json|pnpm-workspace\.yaml|lerna\.json|Cargo\.toml|go\.work|settings\.gradle(?:\.kts)?|pom\.xml|CMakeLists\.txt|Makefile\.am|meson\.build|Makefile)$/;

export interface HintDirs {
  /** Directories named exactly (relative to the repository root). */
  exact: string[];
  /** Parents of a glob (`packages glob` -> `packages`): their direct children are named. */
  parents: string[];
}

const MAX_HINT_DIRS = 200;
const MAX_HINT_TEXT = 256 * 1024;

function norm(base: string, rel: string): string | undefined {
  const cleaned = rel
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!cleaned || cleaned.startsWith('/') || cleaned.startsWith('!') || cleaned.includes('${'))
    return undefined;
  const full = base ? `${base}/${cleaned}` : cleaned;
  return isSafeTreePath(full) ? full : undefined;
}

/** A glob such as packages-star or crates-star-star -> the directory before the first wildcard segment. */
function globToHint(base: string, glob: string, out: HintDirs): void {
  const parts = glob.trim().replace(/^\.\//, '').split('/');
  const idx = parts.findIndex((p) => /[*?[{]/.test(p));
  if (idx === -1) {
    const n = norm(base, parts.join('/'));
    if (n) out.exact.push(n);
    return;
  }
  const prefix = parts.slice(0, idx).join('/');
  const n = prefix ? norm(base, prefix) : base || undefined;
  if (n !== undefined) out.parents.push(n);
}

/** `dirOf` is the directory containing the file (empty for the repository root). */
export function extractHints(fileName: string, dirOf: string, text: string): HintDirs {
  const out: HintDirs = { exact: [], parents: [] };
  const t = text.slice(0, MAX_HINT_TEXT);
  const quoted = (s: string): string[] =>
    [...s.matchAll(/["']([^"'\n]{1,200})["']/g)].map((m) => m[1] as string);
  switch (fileName) {
    case 'package.json': {
      try {
        const j = JSON.parse(t) as { workspaces?: unknown };
        const ws = Array.isArray(j.workspaces)
          ? j.workspaces
          : Array.isArray((j.workspaces as { packages?: unknown } | undefined)?.packages)
            ? ((j.workspaces as { packages: unknown[] }).packages as unknown[])
            : [];
        for (const g of ws.slice(0, 50)) if (typeof g === 'string') globToHint(dirOf, g, out);
      } catch {
        /* not JSON: no hints */
      }
      break;
    }
    case 'pnpm-workspace.yaml':
    case 'lerna.json':
      for (const m of t.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm))
        globToHint(dirOf, m[1] as string, out);
      for (const g of quoted(t)) if (/[*/]/.test(g)) globToHint(dirOf, g, out);
      break;
    case 'Cargo.toml': {
      const ws = /\[workspace\][\s\S]*?\bmembers\s*=\s*\[([\s\S]*?)\]/.exec(t);
      if (ws) for (const g of quoted(ws[1] as string)) globToHint(dirOf, g, out);
      break;
    }
    case 'go.work':
      for (const m of t.matchAll(/^\s*(?:use\s+)?(\.\/[^\s()]+)\s*$/gm))
        globToHint(dirOf, m[1] as string, out);
      break;
    case 'settings.gradle':
    case 'settings.gradle.kts':
      for (const m of t.matchAll(/\binclude(?:Build)?\s*\(?([^\n)]*)/g))
        for (const q of quoted(m[1] as string)) {
          const p = q.replace(/^:/, '').replace(/:/g, '/');
          globToHint(dirOf, p, out);
        }
      break;
    case 'pom.xml':
      for (const m of t.matchAll(/<module>\s*([^<\s]{1,200})\s*<\/module>/g))
        globToHint(dirOf, m[1] as string, out);
      break;
    case 'CMakeLists.txt':
      for (const m of t.matchAll(/\badd_subdirectory\s*\(\s*([^\s)]+)/gi))
        globToHint(dirOf, m[1] as string, out);
      break;
    case 'Makefile.am':
      for (const m of t.matchAll(/^\s*SUBDIRS\s*=\s*(.+)$/gm))
        for (const d of (m[1] as string).split(/\s+/))
          if (/^[\w./-]+$/.test(d)) globToHint(dirOf, d, out);
      break;
    case 'Makefile':
      // Kbuild-style lists (core-y += kernel/ mm/ fs/): only entries that end in a slash are directories.
      for (const m of t.matchAll(/^[\w-]+-y\s*[:+]?=\s*([^\n\\]+)/gm))
        for (const d of (m[1] as string).split(/\s+/))
          if (/^[\w.-]+\/$/.test(d)) globToHint(dirOf, d.slice(0, -1), out);
      break;
    case 'meson.build':
      for (const m of t.matchAll(/\bsubdir\s*\(\s*['"]([^'"]+)['"]/g))
        globToHint(dirOf, m[1] as string, out);
      break;
  }
  out.exact = [...new Set(out.exact)].slice(0, MAX_HINT_DIRS);
  out.parents = [...new Set(out.parents)].slice(0, MAX_HINT_DIRS);
  return out;
}
