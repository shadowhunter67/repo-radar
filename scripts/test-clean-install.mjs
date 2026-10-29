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
  const capture = (args) => runBin(args, { encoding: 'utf8' });
  const packed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const helpText = capture(['--help']);
  for (const needle of [
    'repo-radar analyze',
    '--mode <quick|deep>',
    '--ref',
    '--format',
    '--history',
  ])
    if (!helpText.includes(needle)) throw new Error(`--help does not mention ${needle}`);
  if (!capture(['analyze', '--help']).includes('--no-scorecard'))
    throw new Error('analyze --help does not list the advanced options');
  if (capture(['--version']).trim() !== `repo-radar ${packed.version}`)
    throw new Error('--version does not report the package version');
  // usage errors are answered locally: nothing is fetched and the exit status is 64
  for (const bad of [
    ['analyze'],
    ['analyze', 'owner/repo', '--mode', 'turbo'],
    ['analyze', 'https://evil.example/a/b'],
    ['analyze', 'owner/repo', '--nope'],
  ]) {
    let status;
    try {
      runBin(bad, {
        stdio: 'ignore',
        env: {
          ...process.env,
          HTTPS_PROXY: 'http://127.0.0.1:9',
          HTTP_PROXY: 'http://127.0.0.1:9',
        },
      });
    } catch (error) {
      status = error.status;
    }
    if (status !== 64) throw new Error(`expected exit 64 for ${bad.join(' ')}, got ${status}`);
  }
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
  // Optional live check of the installed package (network, small repository): CLEAN_INSTALL_LIVE=1
  if (process.env.CLEAN_INSTALL_LIVE === '1') {
    for (const mode of ['quick', 'deep']) {
      const raw = runBin(
        ['analyze', 'sindresorhus/is-plain-obj', '--mode', mode, '--format', 'json'],
        {
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        },
      );
      const report = JSON.parse(raw);
      if (
        report.schema_version !== '0.16' ||
        !/^[0-9a-f]{40}$/.test(report.analysis_manifest.commit)
      )
        throw new Error(`live ${mode} analysis returned an unexpected report`);
      log(
        `live ${mode} analysis: score ${report.overall.score}, commit ${report.analysis_manifest.commit.slice(0, 12)}`,
      );
    }
  } else
    log(
      'live analysis: skipped (set CLEAN_INSTALL_LIVE=1 to run it against a small public repository)',
    );
  log('PASS clean-install: CLI help, version, profiles, rules, usage exit, and schema succeeded');
} finally {
  rmSync(out, { recursive: true, force: true });
}
