// Fetches the calibration corpus as bare object databases and pins each repository to one commit.
//
// Safety: repositories are untrusted data. We only run `git` with an argument array (no shell), clone with
// --no-checkout (no repository file is ever written to the working tree, no hooks or filters run) and read blobs
// with `git grep` / `git show` / `git ls-tree` later. Nothing from a repository is executed.
//
// Usage: node calibration/tools/fetch-corpus.mjs [--repin]
// Env:   RR_CORPUS_DIR  where clones go (default: <tmp>/repo-radar-corpus). Delete it when finished.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const calib = join(here, '..');
const corpus = process.env.RR_CORPUS_DIR ?? join(tmpdir(), 'repo-radar-corpus');
const repin = process.argv.includes('--repin');
const dataset = parse(readFileSync(join(calib, 'dataset.yaml'), 'utf8'));
const pinsPath = join(calib, 'pins.json');
const pins = existsSync(pinsPath)
  ? JSON.parse(readFileSync(pinsPath, 'utf8'))
  : { dataset_version: dataset.version, repos: {} };
pins.dataset_version = dataset.version;
mkdirSync(corpus, { recursive: true });

const git = (args, cwd, timeout = 600_000) =>
  spawnSync('git', ['-c', 'core.symlinks=false', '-c', 'core.longpaths=true', ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });

for (const { repo } of dataset.repositories) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo))
    throw new Error(`bad repo name ${repo}`);
  const dir = join(corpus, repo.replace('/', '__'));
  if (!existsSync(join(dir, 'HEAD'))) {
    const r = git(
      [
        'clone',
        '--depth',
        '1',
        '--no-checkout',
        '--single-branch',
        '--no-tags',
        '--bare',
        `https://github.com/${repo}.git`,
        dir,
      ],
      corpus,
    );
    if (r.status !== 0) {
      process.stdout.write(`FAIL ${repo}: ${(r.stderr ?? '').split('\n')[0]}\n`);
      pins.repos[repo] = { ...(pins.repos[repo] ?? {}), error: 'clone failed' };
      continue;
    }
  }
  const sha = git(['rev-parse', 'HEAD'], dir).stdout.trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).stdout.trim();
  const size = git(['count-objects', '-vH'], dir).stdout.match(/size-pack: (.+)/)?.[1] ?? '?';
  const existing = pins.repos[repo];
  if (existing?.commit && !repin) {
    process.stdout.write(
      `keep ${repo} ${existing.commit.slice(0, 10)} (clone head ${sha.slice(0, 10)}) ${size}\n`,
    );
    continue;
  }
  pins.repos[repo] = { commit: sha, branch, pinned_on: new Date().toISOString().slice(0, 10) };
  process.stdout.write(`pin  ${repo} ${sha.slice(0, 10)} ${branch} ${size}\n`);
}
writeFileSync(pinsPath, JSON.stringify(pins, null, 2) + '\n');
process.stdout.write(`corpus dir: ${corpus}\n`);
