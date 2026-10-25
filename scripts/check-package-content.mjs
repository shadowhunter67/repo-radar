import { statSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { execFixed } from './command.mjs';

const archive = process.argv[2];
if (!archive) throw new Error('usage: check-package-content.mjs archive.tgz');
const archiveDir = dirname(archive);
const archiveName = basename(archive);
const portableDir = archiveDir.replaceAll('\\', '/');
const entries = execFixed('tar', ['-tzf', archiveName], { cwd: portableDir, encoding: 'utf8' })
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
  'package/THIRD_PARTY_NOTICES.md',
]) {
  if (!entries.some((entry) => entry === required || entry.startsWith(required)))
    throw new Error(`missing package entry: ${required}`);
}
if (statSync(archive).size >= 4 * 1024 * 1024) throw new Error('packed size exceeds 4 MiB');
const unpacked = mkdtempSync(join(tmpdir(), 'repo-radar-content-'));
execFixed('tar', ['-xzf', archiveName, '-C', unpacked.replaceAll('\\', '/')], { cwd: portableDir });
function size(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, e) =>
      sum + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size),
    0,
  );
}
if (size(unpacked) >= 12 * 1024 * 1024) throw new Error('unpacked size exceeds 12 MiB');
process.stdout.write(`package content ok: ${entries.length} entries\n`);
