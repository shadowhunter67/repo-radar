import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdout } from 'node:process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const names = readdirSync(root).filter((n) => !n.startsWith('.') && n !== '.bin');
const category = (license) => {
  const s = String(license ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('gpl') || s.includes('agpl')) return 'strong-copyleft';
  if (s.includes('lgpl') || s.includes('mpl') || s.includes('epl') || s.includes('cpl'))
    return 'weak-copyleft';
  if (
    s.includes('mit') ||
    s.includes('apache') ||
    s.includes('bsd') ||
    s.includes('isc') ||
    s.includes('0bsd')
  )
    return 'permissive';
  return 'unknown';
};
const rows = [];
for (const name of names) {
  const file = join(root, name, 'package.json');
  if (!existsSync(file)) continue;
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    rows.push({
      name: p.name ?? name,
      version: p.version ?? 'unknown',
      license: p.license ?? null,
      category: category(p.license),
    });
  } catch {
    /* inventory is best-effort metadata, never execution */
  }
}
rows.sort((a, b) => a.name.localeCompare(b.name));
stdout.write(JSON.stringify(rows, null, 2) + '\n');
