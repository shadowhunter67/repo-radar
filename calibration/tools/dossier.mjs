// Prints an evidence dossier for one corpus repository, to be READ BY A HUMAN (or AI-assisted reviewer) when labelling.
//
// Independence: the patterns below are deliberately separate, broader and cruder than the analyzer's detector pack
// (src/analysis/detectors.ts); labels must never be copied from analyzer output (that would be circular). The dossier
// only gives a reviewer a starting point; hits are leads to read, not labels.
//
// Safety: `git` is run with an argument array (no shell) against a bare clone; no repository file is checked out or executed.
// Usage: node calibration/tools/dossier.mjs owner/repo        (env RR_CORPUS_DIR as in fetch-corpus.mjs)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repo = process.argv[2];
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('usage: dossier.mjs owner/repo');
const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, '..', 'pins.json'), 'utf8')).repos[repo];
const dir = join(
  process.env.RR_CORPUS_DIR ?? join(tmpdir(), 'repo-radar-corpus'),
  repo.replace('/', '__'),
);
const run = (cmd, args, opt = {}) =>
  spawnSync(cmd, args, {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
    ...opt,
  });
const git = (...args) => run('git', ['-c', 'core.quotepath=off', ...args]).stdout ?? '';
const show = (path) => {
  const r = run('git', ['show', `HEAD:${path}`]);
  return r.status === 0 ? r.stdout : null;
};

const files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);
const out = [];
const p = (s = '') => out.push(s);
p(`== ${repo} @ ${pins.commit.slice(0, 12)} (${pins.branch}); ${files.length} files`);

// API metadata (current state, context only)
const meta = run('gh', [
  'api',
  `repos/${repo}`,
  '--jq',
  '[.description,.archived,(.topics|join(",")),.language,.stargazers_count]|@tsv',
]);
p(`api: ${(meta.stdout ?? '').trim()}`);

const ext = {};
for (const f of files) {
  const m = /\.([A-Za-z0-9]+)$/.exec(f);
  if (m) ext[m[1].toLowerCase()] = (ext[m[1].toLowerCase()] ?? 0) + 1;
}
p(
  `ext: ${Object.entries(ext)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')}`,
);

const manifests = files.filter(
  (f) =>
    /(^|\/)(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|go\.mod|Cargo\.toml|build\.rs|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile|binding\.gyp|CMakeLists\.txt)$/.test(
      f,
    ) &&
    f.split('/').length <= 3 &&
    !/(^|\/)(node_modules|vendor|test|tests|examples?|docs?|fixtures?)\//i.test(f),
);
p(
  `manifests(<=depth2, non-sample): ${manifests.slice(0, 25).join(' ')}${manifests.length > 25 ? ' ...' : ''}`,
);

const LIFE = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'preprepare',
  'postprepare',
  'prepublish',
];
for (const m of manifests.filter((f) => f.endsWith('package.json')).slice(0, 12)) {
  const txt = show(m);
  if (!txt) continue;
  try {
    const j = JSON.parse(txt);
    const hooks = LIFE.filter((k) => j.scripts?.[k]).map(
      (k) => `${k}=${String(j.scripts[k]).slice(0, 90)}`,
    );
    p(
      `npm ${m}: name=${j.name ?? '?'} private=${!!j.private} bin=${j.bin ? JSON.stringify(j.bin).slice(0, 60) : '-'} main=${j.main ?? '-'} gypfile=${!!j.gypfile} hooks=[${hooks.join(' | ')}] workspaces=${j.workspaces ? 'yes' : 'no'}`,
    );
  } catch {
    p(`npm ${m}: unparseable`);
  }
}
const pyproject = show('pyproject.toml');
if (pyproject)
  p(
    `pyproject build-backend: ${/build-backend\s*=\s*["']([^"']+)/.exec(pyproject)?.[1] ?? '(none)'}; scripts: ${/\[project\.scripts\]/.test(pyproject) ? 'yes' : 'no'}`,
  );
if (files.includes('setup.py')) p('python: setup.py present');
const cargo = show('Cargo.toml');
if (cargo)
  p(
    `rust: build.rs=${files.includes('build.rs')}; [[bin]]=${/\[\[bin\]\]/.test(cargo)}; workspace=${/\[workspace\]/.test(cargo)}`,
  );
p(
  `java: pom=${files.some((f) => f.endsWith('pom.xml'))} gradle=${files.some((f) => /build\.gradle/.test(f))}`,
);
p(
  `docker: ${
    files
      .filter((f) => /(^|\/)Dockerfile/.test(f))
      .slice(0, 6)
      .join(' ') || '-'
  }`,
);
p(
  `installers: ${
    files
      .filter(
        (f) =>
          /(^|\/)(install|setup|bootstrap)[^/]*\.(sh|ps1|bat)$|(^|\/)configure$/.test(f) &&
          !/(test|example|docs?)\//i.test(f),
      )
      .slice(0, 8)
      .join(' ') || '-'
  }`,
);

const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f));
if (readme) {
  const t = (show(readme) ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 14)
    .map((l) => '   | ' + l.slice(0, 130));
  p('README:');
  out.push(...t);
}

// --- independent capability leads -------------------------------------------------------------------------------------
const INCLUDE = [
  '*.js',
  '*.mjs',
  '*.cjs',
  '*.ts',
  '*.tsx',
  '*.py',
  '*.go',
  '*.rs',
  '*.java',
  '*.kt',
  '*.php',
  '*.rb',
  '*.sh',
  '*.bash',
  'Dockerfile*',
  'Makefile',
  '*.c',
  '*.cc',
  '*.cpp',
  '*.h',
];
const EXCLUDE = [
  'test',
  'tests',
  '__tests__',
  'spec',
  'e2e',
  'example',
  'examples',
  'docs',
  'doc',
  'vendor',
  'node_modules',
  'fixtures',
  'fixture',
  'testdata',
  'bench',
  'benchmark',
  'benchmarks',
  'third_party',
  'dist',
  'build',
  '.github',
  'samples',
  'demo',
  'mock',
  'mocks',
].map((d) => `:(exclude,glob)**/${d}/**`);
const hits = (label, pattern) => {
  const r = run('git', [
    'grep',
    '-n',
    '-I',
    '-E',
    '-e',
    pattern,
    'HEAD',
    '--',
    ...INCLUDE,
    ...EXCLUDE,
  ]);
  const lines = (r.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/\.min\.js|\.d\.ts:/.test(l));
  const fileSet = new Set(lines.map((l) => l.split(':')[1]));
  const top = lines
    .slice(0, 3)
    .map((l) => l.replace(/^HEAD:/, '').slice(0, 120))
    .join('  ||  ');
  p(
    `  ${label.padEnd(18)} files=${String(fileSet.size).padStart(3)} hits=${String(lines.length).padStart(4)}  ${top}`,
  );
};
p('CAPABILITY LEADS (non-test/example/docs source; crude independent patterns):');
hits(
  'PROCESS_EXEC',
  'child_process|subprocess\\.|os\\.system|os\\.popen|exec\\.Command|Command::new|std::process::Command|Runtime\\.getRuntime\\(\\)\\.exec|ProcessBuilder|popen\\(|execvp|[^a-zA-Z_.]spawn\\(',
);
hits(
  'NETWORK_CLIENT',
  'https?\\.request|https?\\.get\\(|fetch\\(|axios|requests\\.(get|post|put|request|Session)|urllib|httpx|http\\.(Get|Post|NewRequest)|reqwest|ureq|HttpClient|XMLHttpRequest|net\\.Dial|java\\.net\\.http',
);
hits(
  'NETWORK_SERVER',
  'createServer|\\.listen\\(|http\\.server|ListenAndServe|TcpListener|uvicorn|app\\.run\\(|ServerSocket|net\\.Listen',
);
hits(
  'REMOTE_DOWNLOAD',
  '(curl|wget)[[:space:]]+-|Invoke-WebRequest|urlretrieve|downloadFile|download\\(|\\.download',
);
hits(
  'FILESYSTEM_WRITE',
  'writeFile|createWriteStream|os\\.WriteFile|ioutil\\.WriteFile|fs::write|File::create|shutil\\.copy|open\\([^)]*[\'"][wa]b?[\'"]|FileOutputStream|file_put_contents|fwrite',
);
hits(
  'FILESYSTEM_DELETE',
  'unlink|rmSync|rmtree|os\\.Remove|remove_file|remove_dir_all|rimraf|Files\\.delete',
);
hits(
  'DYNAMIC_CODE_LOAD',
  '[^a-zA-Z_.]eval\\(|new Function\\(|__import__|importlib\\.import_module|plugin\\.Open|dlopen|vm\\.run|Class\\.forName|[^a-zA-Z_.]exec\\(',
);
hits(
  'CREDENTIAL_ACCESS',
  '\\.ssh/|id_rsa|\\.aws/|\\.npmrc|\\.netrc|keyring|keychain|Login Data|\\.git-credentials|\\.docker/config',
);
hits(
  'ENVIRONMENT_READ',
  'process\\.env|os\\.environ|os\\.Getenv|os\\.LookupEnv|env::var|System\\.getenv|getenv\\(|\\$_ENV',
);
hits(
  'BACKGROUND_PROCESS',
  'nohup|setsid|disown|detached|daemon|start_new_session|DETACHED_PROCESS|fork\\(',
);
hits(
  'PERSISTENCE',
  'systemctl|crontab|LaunchAgents|LaunchDaemons|CurrentVersion.Run|schtasks|authorized_keys|\\.bashrc|\\.zshrc|\\.bash_profile|\\.zprofile|/etc/init\\.d|autostart',
);
hits('PIPE_TO_SHELL', '(curl|wget)[^|]*\\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh');
hits(
  'SECRET_PATTERNS',
  'AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|gh[pous]_[A-Za-z0-9]{36}|xox[abp]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{35}',
);
p(
  'SECRET-NAMED FILES (any path): ' +
    (files
      .filter(
        (f) =>
          /(^|\/)\.env(\.[a-z]+)?$|(^|\/)id_rsa$|\.pem$|\.p12$|\.pfx$|\.jks$/.test(f) &&
          !/\.example$|\.sample$/.test(f),
      )
      .slice(0, 8)
      .join(' ') || '-'),
);
process.stdout.write(out.join('\n') + '\n');
