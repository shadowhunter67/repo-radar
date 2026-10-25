import { mkdtempSync } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { buildMetadata, sha256 } from '../dist/release/dry-run.js';
import { execFixed } from './command.mjs';

const root = process.cwd();
const run = (command, args, cwd = root) =>
  execFixed(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });

function main() {
  const out = mkdtempSync(join(tmpdir(), 'repo-radar-release-'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  run('npm', ['run', 'check']);
  run('npm', ['run', 'build']);
  const packed = run('npm', ['pack', '--silent', '--pack-destination', out])
    .trim()
    .split(/\r?\n/)
    .at(-1);
  run('npm', ['run', 'package:action']);
  run(process.execPath, ['scripts/check-package-content.mjs', join(out, packed)]);
  const sbom = join(out, 'sbom.json');
  writeFileSync(
    sbom,
    run('npm', ['sbom', '--sbom-format', 'cyclonedx', '--sbom-type', 'application']),
  );
  const metadata = buildMetadata({
    version: pkg.version,
    node: process.version,
    npm: run('npm', ['--version']).trim(),
    commit: run('git', ['rev-parse', 'HEAD']).trim(),
    commands: ['npm run check', 'npm run build', 'npm pack', 'npm run package:action', 'npm sbom'],
  });
  const metadataFile = join(out, 'release-metadata.json');
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
  // SHA256SUMS lists ONLY the files that are shipped next to it (basenames). The Action bundle is not a release attachment while the
  // OpenPGP legal decision is pending (docs/release/preview-policy.json); its digest is only printed, never listed in the shipped file.
  const files = [join(out, packed), sbom, metadataFile];
  const actionBundle = join(root, 'dist', 'action', 'repo-radar.mjs');
  process.stdout.write(
    `action bundle (NOT shipped) ${actionBundle} ${sha256(readFileSync(actionBundle))}\n`,
  );
  writeFileSync(
    join(out, 'SHA256SUMS'),
    files.map((file) => `${sha256(readFileSync(file))}  ${basename(file)}`).join('\n') + '\n',
  );
  for (const file of [...files, join(out, 'SHA256SUMS')])
    process.stdout.write(`${file} ${sha256(readFileSync(file))}\n`);
  process.stdout.write(`release dry-run output: ${out}\n`);
}
if (process.argv[1]?.endsWith('release-dry-run.mjs')) main();
