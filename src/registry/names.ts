export type NameEcosystem = 'npm' | 'pypi' | 'crates.io';
export type NameSignal =
  | 'edit_distance'
  | 'keyboard_adjacency'
  | 'separator_variation'
  | 'duplication_or_omission'
  | 'homoglyph'
  | 'scope_confusion'
  | 'prefix_suffix_trick';
export interface NameHistory {
  sameRepositoryNames?: string[];
  deprecatedUse?: string | null;
}
export interface NameComparison {
  left: string;
  right: string;
  ecosystem: NameEcosystem;
  normalized_left: string;
  normalized_right: string;
  skeleton_left: string;
  skeleton_right: string;
  distance: number | null;
  signals: NameSignal[];
  suppressed: boolean;
  suppression_reason: 'same_repository_history' | 'deprecated_use' | null;
}
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  Α: 'a',
  Β: 'b',
  Ε: 'e',
  Ι: 'i',
  Ο: 'o',
  Ρ: 'p',
  Τ: 't',
  Χ: 'x',
};
const KEYBOARD = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const MAX_DISTANCE_LENGTH = 80;
export const POPULAR_PACKAGE_SEEDS: Record<NameEcosystem, string[]> = {
  npm: [
    'react',
    'lodash',
    'express',
    'chalk',
    'axios',
    'typescript',
    'webpack',
    'esbuild',
    'jest',
    'vite',
    'vue',
    'eslint',
    'prettier',
    'core-js',
    'colors',
    'sigstore',
  ],
  pypi: [
    'requests',
    'urllib3',
    'numpy',
    'pandas',
    'setuptools',
    'pip',
    'six',
    'pyyaml',
    'flask',
    'django',
    'pytest',
    'click',
    'cryptography',
  ],
  'crates.io': [
    'serde',
    'serde-json',
    'tokio',
    'rand',
    'clap',
    'regex',
    'reqwest',
    'anyhow',
    'thiserror',
    'itoa',
    'log',
    'tracing',
  ],
};
export function normalizePackageName(name: string, ecosystem: NameEcosystem): string {
  const n = name.normalize('NFKC').toLowerCase();
  if (ecosystem === 'pypi') return n.replace(/[_.-]+/g, '-');
  if (ecosystem === 'crates.io') return n.replace(/[-_]+/g, '-');
  return n;
}
export function confusableSkeleton(name: string): string {
  return [...name.normalize('NFKC').toLowerCase()].map((c) => CONFUSABLES[c] ?? c).join('');
}
export function damerauLevenshtein(a: string, b: string, max = 3): number | null {
  if (
    a.length > MAX_DISTANCE_LENGTH ||
    b.length > MAX_DISTANCE_LENGTH ||
    Math.abs(a.length - b.length) > max
  )
    return null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i),
    prev2: number[] | null = null;
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, sub);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2![j - 2]! + 1);
      row[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return null;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length] ?? null;
}
function singleKeyboardSubstitution(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let changes = 0;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) {
      changes++;
      if (
        changes > 1 ||
        !KEYBOARD.some(
          (r) => r.includes(a[i]!) && Math.abs(r.indexOf(a[i]!) - r.indexOf(b[i]!)) === 1,
        )
      )
        return false;
    }
  return changes === 1;
}
function suppression(
  left: string,
  right: string,
  history?: NameHistory,
): NameComparison['suppression_reason'] {
  if (!history) return null;
  if (history.sameRepositoryNames?.some((x) => x.toLowerCase() === right.toLowerCase()))
    return 'same_repository_history';
  if (
    history.deprecatedUse &&
    normalizePackageName(history.deprecatedUse, 'npm') === normalizePackageName(right, 'npm')
  )
    return 'deprecated_use';
  return null;
}
export function comparePackageNames(
  left: string,
  right: string,
  ecosystem: NameEcosystem,
  history?: NameHistory,
): NameComparison {
  const rawA = left.normalize('NFKC').toLowerCase(),
    rawB = right.normalize('NFKC').toLowerCase(),
    a = normalizePackageName(left, ecosystem),
    b = normalizePackageName(right, ecosystem),
    sa = confusableSkeleton(a),
    sb = confusableSkeleton(b),
    signals: NameSignal[] = [],
    distance = damerauLevenshtein(a, b);
  if (
    distance !== null &&
    distance > 0 &&
    // names under 5 characters differ by one edit all the time (abc/abd): too noisy to mean anything
    Math.min(a.length, b.length) >= 5 &&
    distance <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 3))
  )
    signals.push('edit_distance');
  if (Math.min(a.length, b.length) >= 5 && singleKeyboardSubstitution(a, b))
    signals.push('keyboard_adjacency');
  if (rawA.replace(/[-_.]/g, '') === rawB.replace(/[-_.]/g, '') && rawA !== rawB)
    signals.push('separator_variation');
  if (sa === sb && a !== b) signals.push('homoglyph');
  if (
    Math.min(a.length, b.length) >= 5 &&
    a !== b &&
    (a.replace(/(.)\1/g, '$1') === b || b.replace(/(.)\1/g, '$1') === a)
  )
    signals.push('duplication_or_omission');
  // Scope confusion means the SAME base name under a different (or missing) scope: `@types/node` vs `node`, `@a/x` vs `@b/x`.
  // A scoped and an unscoped name that merely differ in shape (`openpgp` vs `@eslint/js`) are unrelated and must not be reported.
  const baseOf = (n: string): string => (n.startsWith('@') ? n.slice(n.indexOf('/') + 1) : n);
  const scopeOf = (n: string): string => (n.startsWith('@') ? n.slice(0, n.indexOf('/')) : '');
  if (scopeOf(a) !== scopeOf(b) && baseOf(a) === baseOf(b) && baseOf(a).length > 0)
    signals.push('scope_confusion');
  if (a !== b && (a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 5)
    signals.push('prefix_suffix_trick');
  if (a === b && rawA === rawB) signals.length = 0;
  const reason = suppression(left, right, history);
  return {
    left,
    right,
    ecosystem,
    normalized_left: a,
    normalized_right: b,
    skeleton_left: sa,
    skeleton_right: sb,
    distance,
    signals,
    suppressed: reason !== null,
    suppression_reason: reason,
  };
}
export function compareCandidates(
  target: { name: string; ecosystem: NameEcosystem },
  candidates: { name: string; ecosystem: NameEcosystem; history?: NameHistory }[],
): NameComparison[] {
  return candidates
    .filter((c) => c.ecosystem === target.ecosystem && c.name !== target.name)
    .map((c) => comparePackageNames(target.name, c.name, target.ecosystem, c.history))
    .filter((c) => c.signals.length > 0 && !c.suppressed)
    .slice(0, 100);
}
