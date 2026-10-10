import { posix } from 'node:path';
import { extractLocalRefs } from '../../analysis/refs.js';
import type { FileRole } from '../../analysis/types.js';
import { LIMITS } from '../../limits.js';
import type { ParsedManifest } from '../manifests/parse.js';
import { isSafeTreePath, isSourcePath, type TreeEntry } from './tree.js';

export interface Candidate {
  path: string;
  role: FileRole;
  priority: number;
}

const ENTRY_NAMES =
  /^(?:src\/)?(?:index|main|cli|app|server|__main__|lib|mod)\.(?:[cm]?[jt]sx?|py|rs|go)$|^cmd\/[^/]+\/main\.go$|^src\/bin\/[^/]+\.rs$/;
const COMPOSE = /^(?:docker-)?compose[\w.-]*\.ya?ml$|^docker-compose[\w.-]*\.ya?ml$/i;
const SCRIPT_EXT = /\.(?:sh|bash|ps1|bat|cmd)$/i;
const NPM_HOOK_NAMES = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'preprepare',
  'postprepare',
  'prepublish',
];

export interface SelectionResult {
  candidates: Candidate[];
  skippedTooLarge: number;
}

/**
 * Chooses which files to fetch for static scanning, most security-relevant first:
 * install/build roots, files named by npm lifecycle scripts, compose files, entry points, shell scripts,
 * then a shallow sample of source files. Pure function over the git tree: nothing is fetched here.
 */
export function selectScanCandidates(
  entries: TreeEntry[],
  manifests: ParsedManifest[],
): SelectionResult {
  const blobs = entries
    .filter((e) => e.type === 'blob' && isSafeTreePath(e.path))
    .slice(0, 100_000);
  const treeSet = new Set(blobs.map((e) => e.path));
  const sizeOf = new Map(blobs.map((e) => [e.path, e.size ?? 0]));
  const picked = new Map<string, Candidate>();
  let skippedTooLarge = 0;

  const add = (path: string, role: FileRole, priority: number): void => {
    if (picked.has(path) || !treeSet.has(path)) return;
    if ((sizeOf.get(path) ?? 0) > LIMITS.maxScanFileBytes) {
      skippedTooLarge++;
      return;
    }
    picked.set(path, { path, role, priority });
  };

  for (const e of blobs) {
    const base = e.path.slice(e.path.lastIndexOf('/') + 1);
    const depth = e.path.split('/').length - 1;
    if (depth > 1) continue;
    if (
      base === 'setup.py' ||
      base === 'build.rs' ||
      /^Dockerfile(?:\.[\w.-]+)?$/i.test(base) ||
      /^(?:GNUmakefile|Makefile|makefile)$/.test(base)
    )
      add(e.path, 'build', 0);
    else if (/^(?:install|setup|bootstrap)\.(?:sh|ps1|bat)$/i.test(base) || base === 'configure')
      add(e.path, 'script', 0);
  }

  for (const m of manifests.filter((x) => x.ecosystem === 'npm')) {
    for (const hook of NPM_HOOK_NAMES) {
      const body = m.scripts?.[hook];
      if (body) for (const r of extractLocalRefs(body, m.file, treeSet)) add(r, 'script', 1);
    }
    // Scripts reachable through `npm run <name>` are resolved by the analyzer; fetch their file targets too.
    for (const [name, body] of Object.entries(m.scripts ?? {})) {
      if (NPM_HOOK_NAMES.includes(name)) continue;
      if (/^(?:build|test|lint|start|dev)/.test(name)) continue;
      for (const r of extractLocalRefs(body, m.file, treeSet)) add(r, 'ref', 3);
    }
    for (const f of m.entryFiles ?? []) {
      const joined = posix.normalize(
        posix.join(posix.dirname(m.file) === '.' ? '' : posix.dirname(m.file), f),
      );
      add(joined, 'source', 2);
    }
  }

  for (const e of blobs) {
    const base = e.path.slice(e.path.lastIndexOf('/') + 1);
    const depth = e.path.split('/').length - 1;
    if (depth <= 1 && COMPOSE.test(base)) add(e.path, 'config', 2);
    if (ENTRY_NAMES.test(e.path) && isSourcePath(e.path)) add(e.path, 'source', 3);
    if (depth <= 2 && SCRIPT_EXT.test(base)) add(e.path, 'script', 4);
  }

  const rest = blobs
    .filter((e) => isSourcePath(e.path))
    .sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1),
    );
  for (const e of rest) add(e.path, 'source', 5);

  const candidates = [...picked.values()].sort(
    (a, b) => a.priority - b.priority || (a.path < b.path ? -1 : 1),
  );
  return { candidates, skippedTooLarge };
}

/** Next-round candidates: local files referenced by already fetched scripts/build files. */
export function nextRefCandidates(
  fetched: { path: string; content: string; role: FileRole }[],
  entries: TreeEntry[],
  alreadyKnown: ReadonlySet<string>,
): { paths: string[]; skippedTooLarge: number } {
  const treeSet = new Set(
    entries.filter((e) => e.type === 'blob' && isSafeTreePath(e.path)).map((e) => e.path),
  );
  const sizeOf = new Map(entries.map((e) => [e.path, e.size ?? 0]));
  const out: string[] = [];
  let skippedTooLarge = 0;
  for (const f of fetched) {
    if (f.role === 'source' || f.role === 'workflow' || f.role === 'manifest') continue;
    for (const r of extractLocalRefs(f.content, f.path, treeSet)) {
      if (alreadyKnown.has(r) || out.includes(r)) continue;
      if ((sizeOf.get(r) ?? 0) > LIMITS.maxScanFileBytes) {
        skippedTooLarge++;
        continue;
      }
      out.push(r);
      if (out.length >= LIMITS.maxRefsPerRound) return { paths: out, skippedTooLarge };
    }
  }
  return { paths: out, skippedTooLarge };
}
