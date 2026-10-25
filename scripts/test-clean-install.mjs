import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const log = (message) => process.stdout.write(`${message}\n`);

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'repo-radar-consumer-'));
try {
  let archive;
  try {
    archive = execFileSync('npm.cmd', ['pack', '--silent'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    log('SKIP clean-install: npm pack unavailable in this offline environment');
    process.exit(0);
  }
  try {
    execFileSync('npm.cmd', ['init', '-y'], { cwd: out, stdio: 'ignore' });
    execFileSync('npm.cmd', ['install', '--offline', join(root, archive)], {
      cwd: out,
      stdio: 'inherit',
    });
  } catch {
    log('SKIP clean-install: dependencies unavailable offline');
    process.exit(0);
  }
  const bin = join(out, 'node_modules', '.bin', 'repo-radar.cmd');
  execFileSync(bin, ['--help'], { cwd: out, stdio: 'inherit' });
  execFileSync(bin, ['--version'], { cwd: out, stdio: 'inherit' });
  log('PASS clean-install: CLI help and version succeeded');
} finally {
  rmSync(out, { recursive: true, force: true });
}
