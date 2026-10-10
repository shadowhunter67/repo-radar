import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Locates the repo-radar package root (the directory holding `standards/` and `profiles/`)
 * by walking up from this module. Works from `src/`, `dist/` and the bundled GitHub Action.
 */
export function packageRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj) && existsSync(join(dir, 'standards'))) {
      try {
        const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name;
        if (name === 'repo-radar') return (cached = dir);
      } catch {
        /* keep walking */
      }
    }
    dir = dirname(dir);
  }
  throw new Error('could not locate repo-radar package root (standards/ directory missing)');
}
