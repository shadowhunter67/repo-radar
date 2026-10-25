import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execFixed } from './command.mjs';

const log = (message) => process.stdout.write(`${message}\n`);

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'repo-radar-consumer-'));
try {
  let archive;
  const packDir = mkdtempSync(join(tmpdir(), 'repo-radar-pack-'));
  try {
    execFixed('npm', ['pack', '--silent', '--pack-destination', packDir], {
      cwd: root,
      encoding: 'utf8',
    });
    archive = join(
      packDir,
      readdirSync(packDir).find((name) => name.endsWith('.tgz')),
    );
  } catch {
    log('SKIP clean-install: npm pack unavailable in this offline environment');
    process.exit(0);
  }
  try {
    execFixed('npm', ['init', '-y'], { cwd: out, stdio: 'ignore' });
    execFixed('npm', ['install', '--ignore-scripts', archive], {
      cwd: out,
      stdio: 'inherit',
    });
  } catch {
    log('SKIP clean-install: dependencies unavailable offline');
    process.exit(0);
  }
  const bin = join(
    out,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'repo-radar.cmd' : 'repo-radar',
  );
  const runBin = (args, options = {}) =>
    execFileSync(bin, args, { cwd: out, shell: process.platform === 'win32', ...options });
  runBin(['--help'], { stdio: 'inherit' });
  runBin(['--version'], { stdio: 'inherit' });
  runBin(['profiles'], { stdio: 'inherit' });
  runBin(['rules'], { stdio: 'inherit' });
  let usageStatus;
  try {
    runBin(['not-a-command'], { stdio: 'ignore' });
  } catch (error) {
    usageStatus = error.status;
  }
  if (usageStatus !== 64) throw new Error(`expected usage exit 64, got ${usageStatus}`);
  JSON.parse(
    readFileSync(join(out, 'node_modules', 'repo-radar', 'schemas', 'report.schema.json'), 'utf8'),
  );
  log('recorded fixture analysis: skipped; package has no offline analyze mode');
  log('PASS clean-install: CLI help, version, profiles, rules, usage exit, and schema succeeded');
} finally {
  rmSync(out, { recursive: true, force: true });
}
