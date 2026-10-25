import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import process from 'node:process';

const archive = process.argv[2];
if (!archive) throw new Error('usage: check-package-content.mjs archive.tgz');
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const forbidden =
  /^(?:package\/)?(?:calibration|tests|scripts|node_modules|snapshots|tmp)(?:\/|$)|(?:^|\/)(?:\.env[^/]*|.*\.log)$/i;
const bad = entries.filter((entry) => forbidden.test(entry));
if (bad.length) throw new Error(`forbidden package entries: ${bad.slice(0, 5).join(', ')}`);
for (const required of [
  'package/dist/',
  'package/README.md',
  'package/LICENSE',
  'package/SECURITY.md',
]) {
  if (!entries.some((entry) => entry === required || entry.startsWith(required)))
    throw new Error(`missing package entry: ${required}`);
}
if (statSync(archive).size >= 4 * 1024 * 1024) throw new Error('packed size exceeds 4 MiB');
process.stdout.write(`package content ok: ${entries.length} entries\n`);
