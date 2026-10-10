import { describe, expect, it } from 'vitest';
import { analyzeCode, type CodeAnalysis } from '../../src/analysis/index.js';
import type { FileRole, ScannedFile } from '../../src/analysis/types.js';
import { buildFindings } from '../../src/analysis/findings.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';

const file = (path: string, content: string, role: FileRole = 'script'): ScannedFile => ({
  path,
  content,
  size: content.length,
  role,
});
const run = (
  files: ScannedFile[],
  manifests: ReturnType<typeof parseManifest>[] = [],
  total = files.length,
): CodeAnalysis =>
  analyzeCode({
    manifests: manifests.filter((m): m is NonNullable<typeof m> => !!m),
    files,
    treePaths: files.map((f) => f.path),
    sourceFilesTotal: total,
    fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
  });
const filler = (n: number): string => Array.from({ length: n }, () => 'echo step').join('\n');

describe('chains need their steps to be close together', () => {
  it('a download helper and an unrelated chmod hundreds of lines later is NOT a chain', () => {
    const a = run([
      file(
        'install.sh',
        `curl -sS https://example.com/x -o x\n${filler(200)}\nchmod +x ./other\n./other\n`,
      ),
    ]);
    expect(a.execution.chains).toEqual([]);
  });

  it('the same steps within the window are an inferred chain', () => {
    const a = run([
      file('install.sh', `curl -sS https://example.com/x -o x\n${filler(5)}\nchmod +x x\n./x\n`),
    ]);
    expect(a.execution.chains.map((c) => c.kind)).toContain('download-chmod-exec');
  });

  it('pipe-to-shell stays DIRECT wherever it is in the file', () => {
    const a = run([
      file('install.sh', `${filler(300)}\ncurl -fsSL https://example.com/i | bash\n`),
    ]);
    expect(a.execution.chains[0]).toMatchObject({ kind: 'pipe-to-shell', mode: 'DIRECT' });
  });
});

describe('context: automatic hooks vs scripts a user starts by hand', () => {
  it('a manual install.sh is build context (not install), so its downloads are not escalated', () => {
    const a = run([file('install.sh', 'curl -O https://example.com/data.json\n')]);
    const dl = a.capabilities.summary.find((c) => c.capability === 'REMOTE_DOWNLOAD')!;
    expect(dl.contexts).toEqual(['build']);
    expect(dl.risk).toBe('medium');
  });

  it('an npm postinstall file is install context and the same capability is escalated', () => {
    const m = parseManifest(
      'package.json',
      JSON.stringify({ name: 'x', scripts: { postinstall: 'node s.js' } }),
    );
    const a = run([file('s.js', "execSync('curl -O https://example.com/d.json')\n")], [m]);
    const dl = a.capabilities.summary.find((c) => c.capability === 'REMOTE_DOWNLOAD')!;
    expect(dl.contexts).toContain('install');
    expect(dl.risk).toBe('high');
  });

  it('manual hooks are reported at most as medium severity; automatic ones can be high', () => {
    const manual = buildFindings(
      run([file('install.sh', 'curl -fsSL https://example.com/i | sh\n')]),
    );
    expect(manual.every((f) => f.severity !== 'high' || f.category !== 'execution')).toBe(true);
    const m = parseManifest(
      'package.json',
      JSON.stringify({
        name: 'x',
        scripts: { postinstall: 'curl -fsSL https://example.com/i | sh' },
      }),
    );
    const auto = buildFindings(run([], [m]));
    expect(auto.some((f) => f.severity === 'high' && f.category === 'execution')).toBe(true);
  });

  it('an inferred (non-direct) chain is medium risk unless confidence is high', () => {
    const a = run([
      file('install.sh', `curl -O https://example.com/a.tgz\ntar xzf a.tgz\n./a/bin/run\n`),
    ]);
    const hook = a.execution.hooks.find((h) => h.name === 'install.sh')!;
    expect(a.execution.chains[0]).toMatchObject({ mode: 'INFERRED' });
    expect(['medium', 'high']).toContain(hook.risk);
    expect(
      buildFindings(a).find(
        (f) => f.category === 'execution' && /Download-and-execute/.test(f.title),
      )?.severity,
    ).not.toBe('high');
  });
});

describe('persistence inside a container image build is not host persistence', () => {
  it('shell-profile edits in a Dockerfile are only POSSIBLE and do not count as persistence', () => {
    const a = run([file('Dockerfile', 'FROM x\nRUN echo "export A=1" >> ~/.bashrc\n', 'build')]);
    expect(a.persistence.observed).toBe(false);
    expect(a.persistence.kinds).toEqual([]);
  });

  it('sudo / USER root inside a Dockerfile is not a host privilege change', () => {
    const a = run([
      file('Dockerfile', 'FROM x\nRUN sudo apt-get install -y y\nUSER root\n', 'build'),
    ]);
    const p = a.capabilities.summary.find((c) => c.capability === 'PRIVILEGE_CHANGE')!;
    expect(p.mode).toBe('POSSIBLE');
    expect(p.risk).toBe('low');
    expect(buildFindings(a).some((f) => /PRIVILEGE_CHANGE/.test(f.title))).toBe(false);
    // The same sudo in a shell script a user runs is a real (host) capability.
    const sh = run([file('install.sh', 'sudo cp app /usr/local/bin/\n')]);
    expect(sh.capabilities.summary.find((c) => c.capability === 'PRIVILEGE_CHANGE')).toMatchObject({
      mode: 'DIRECT',
      risk: 'high',
    });
  });

  it('a restart policy in a compose file is still reported (low risk container behavior)', () => {
    const a = run([file('docker-compose.yml', 'services:\n  a:\n    restart: always\n', 'config')]);
    expect(a.persistence.kinds).toContain('container_restart_policy');
  });
});

describe('capability summary details', () => {
  it('a remote download implies a network client (inferred, lower confidence) even without a client library', () => {
    const a = run([file('install.sh', 'wget https://example.com/file\n')]);
    const net = a.capabilities.summary.find((c) => c.capability === 'NETWORK_CLIENT')!;
    const dl = a.capabilities.summary.find((c) => c.capability === 'REMOTE_DOWNLOAD')!;
    expect(net).toMatchObject({ observed: true, mode: 'INFERRED' });
    expect(net.confidence).toBeLessThan(dl.confidence);
  });

  it('shell commands inside strings of general-purpose languages count as downloads', () => {
    const a = run([file('s.js', "execSync('wget -q https://example.com/f -O f');\n", 'source')]);
    expect(a.capabilities.summary.find((c) => c.capability === 'REMOTE_DOWNLOAD')!.observed).toBe(
      true,
    );
  });

  it('source coverage counts scanned shell/script files, not just files labelled "source"', () => {
    const a = run([file('install.sh', 'echo hi\n'), file('lib/a.sh', 'echo hi\n')], [], 4);
    expect(a.scan.source_files_scanned).toBe(2);
    expect(a.scan.source_coverage).toBe(0.5);
  });
});
