// Packages the GitHub Action bundle for release: checks that action.yml points at the bundle,
// writes dist/action/MANIFEST.json (version, size, sha256) and prints it. Run after `npm run bundle`.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'action', 'repo-radar.mjs');
const action = readFileSync(join(root, 'action.yml'), 'utf8');
const referenced = /\$GITHUB_ACTION_PATH\/(dist\/action\/[\w.-]+)/.exec(action)?.[1];
if (referenced !== 'dist/action/repo-radar.mjs') {
  process.stderr.write(`action.yml must run dist/action/repo-radar.mjs (found: ${referenced})\n`);
  process.exit(1);
}
let size;
try {
  size = statSync(bundle).size;
} catch {
  process.stderr.write('bundle missing: run `npm run bundle` first\n');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
const manifest = {
  name: pkg.name,
  version: pkg.version,
  file: referenced,
  size,
  sha256,
  node: '>=20',
};
writeFileSync(
  join(root, 'dist', 'action', 'MANIFEST.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(manifest) + '\n');
