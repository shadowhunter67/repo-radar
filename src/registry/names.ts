export type NameEcosystem = 'npm' | 'pypi' | 'crates.io';
export type NameSignal =
  | 'edit_distance'
  | 'keyboard_adjacency'
  | 'separator_variation'
  | 'duplication_or_omission'
  | 'homoglyph'
  | 'scope_confusion'
  | 'prefix_suffix_trick';
export interface NameComparison {
  left: string;
  right: string;
  ecosystem: NameEcosystem;
  signals: NameSignal[];
  distance: number;
  legitimate: boolean;
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
export function normalizePackageName(name: string, ecosystem: NameEcosystem): string {
  const n = name.normalize('NFKC').toLowerCase();
  if (ecosystem === 'pypi') return n.replace(/[_.-]+/g, '-');
  if (ecosystem === 'crates.io') return n.replace(/[-_]+/g, '-');
  return n;
}
function skeleton(n: string): string {
  return [...n].map((c) => CONFUSABLES[c] ?? c).join('');
}
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 4;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array<number>(b.length + 1).fill(i));
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
          ? d[i - 2]![j - 2]! + 1
          : 99,
      );
  return d[a.length]![b.length]!;
}
function adjacent(a: string, b: string): boolean {
  return (
    a.length === b.length &&
    [...a].every(
      (c, i) =>
        c === b[i] ||
        KEYBOARD.some((r) => r.includes(c) && Math.abs(r.indexOf(c) - r.indexOf(b[i] ?? '')) === 1),
    )
  );
}
export function comparePackageNames(
  left: string,
  right: string,
  ecosystem: NameEcosystem,
  legitimate = false,
): NameComparison {
  const a = normalizePackageName(left, ecosystem),
    b = normalizePackageName(right, ecosystem),
    signals: NameSignal[] = [];
  const sa = skeleton(a),
    sb = skeleton(b),
    d = distance(a, b);
  if (d > 0 && d <= Math.max(2, Math.floor(Math.min(a.length, b.length) / 3)))
    signals.push('edit_distance');
  if (adjacent(a, b)) signals.push('keyboard_adjacency');
  if (a.replace(/[-_.]/g, '') === b.replace(/[-_.]/g, '') && a !== b)
    signals.push('separator_variation');
  if (sa === sb && a !== b) signals.push('homoglyph');
  if (a.replace(/(.)\1/g, '$1') === b || b.replace(/(.)\1/g, '$1') === a)
    signals.push('duplication_or_omission');
  if (a.startsWith('@') !== b.startsWith('@') || a.split('/').length !== b.split('/').length)
    signals.push('scope_confusion');
  if ((a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 3)
    signals.push('prefix_suffix_trick');
  return {
    left,
    right,
    ecosystem,
    signals: legitimate ? [] : [...new Set(signals)],
    distance: d,
    legitimate,
  };
}
