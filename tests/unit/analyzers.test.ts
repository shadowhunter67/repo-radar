import { describe, expect, it } from 'vitest';
import { analyzeReadme } from '../../src/collectors/github/readme.js';
import { analyzeTree, isSafeTreePath, type TreeEntry } from '../../src/collectors/github/tree.js';
import { analyzeWorkflow } from '../../src/collectors/github/workflows.js';

const blobs = (...paths: string[]): TreeEntry[] => paths.map((path) => ({ path, type: 'blob' }));

describe('analyzeWorkflow', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  it('counts pinned vs unpinned external actions and ignores local/docker-less refs', () => {
    const f = analyzeWorkflow(`
on: push
jobs:
  a:
    steps:
      - uses: actions/checkout@${sha}
      - uses: actions/setup-node@v4
      - uses: ./.github/actions/local
      - uses: docker://alpine@sha256:${'a'.repeat(64)}
      - uses: docker://alpine:3
`);
    expect(f).toMatchObject({ parsed: true, externalActions: 4, pinnedActions: 2 });
  });

  it('detects permissions at top level, or on every job, but not on only some', () => {
    expect(
      analyzeWorkflow('on: push\npermissions: read-all\njobs:\n  a:\n    steps: []').hasPermissions,
    ).toBe(true);
    expect(
      analyzeWorkflow(
        'on: push\njobs:\n  a:\n    permissions: {}\n    steps: []\n  b:\n    permissions: {}\n    steps: []',
      ).hasPermissions,
    ).toBe(true);
    expect(
      analyzeWorkflow(
        'on: push\njobs:\n  a:\n    permissions: {}\n    steps: []\n  b:\n    steps: []',
      ).hasPermissions,
    ).toBe(false);
  });

  it('flags pull_request_target + head checkout as dangerous, but not pull_request_target alone', () => {
    const risky = analyzeWorkflow(`
on: [pull_request_target]
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`);
    expect(risky).toMatchObject({ pullRequestTarget: true, dangerousCheckout: true });
    const safe = analyzeWorkflow(
      'on:\n  pull_request_target:\n    types: [opened]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n',
    );
    expect(safe).toMatchObject({ pullRequestTarget: true, dangerousCheckout: false });
  });

  it('detects untrusted event data interpolated into run scripts', () => {
    const bad = analyzeWorkflow(
      'on: issues\njobs:\n  a:\n    steps:\n      - run: echo "${{ github.event.issue.title }}"\n',
    );
    expect(bad.expressionInjection).toBe(true);
    expect(
      analyzeWorkflow(
        'on: push\njobs:\n  a:\n    steps:\n      - run: echo "${{ github.head_ref }}"\n',
      ).expressionInjection,
    ).toBe(true);
    const fine = analyzeWorkflow(
      'on: issues\njobs:\n  a:\n    steps:\n      - env:\n          T: ${{ github.event.issue.title }}\n        run: echo "$T"\n      - run: echo ${{ github.sha }}\n',
    );
    expect(fine.expressionInjection).toBe(false);
  });

  it.each([
    ['npm test', true],
    ['npm run test:unit', true],
    ['pnpm run unit', true],
    ['yarn test --ci', true],
    ['npx vitest run', true],
    ['pytest -q', true],
    ['python -m unittest', true],
    ['go test ./...', true],
    ['cargo test --all', true],
    ['make test', true],
    ['dotnet test', true],
    ['npm run lint', false],
    ['npm run build', false],
    ['echo "no tests here"', false],
    ['go build ./...', false],
  ])('test command detection: %s -> %s', (cmd, expected) => {
    expect(
      analyzeWorkflow(`on: push\njobs:\n  a:\n    steps:\n      - run: ${cmd}\n`).runsTests,
    ).toBe(expected);
  });

  it('recognises SAST and provenance actions', () => {
    const f = analyzeWorkflow(
      `on: push\njobs:\n  a:\n    steps:\n      - uses: github/codeql-action/analyze@v3\n      - uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2\n`,
    );
    expect(f).toMatchObject({ usesSast: true, usesProvenance: true });
  });

  it('survives hostile YAML: alias bombs, tags, garbage, non-mappings', () => {
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10)
            .fill('*' + (i === 0 ? 'a' : String.fromCharCode(97 + i)))
            .join(',')}]`,
      ),
    ].join('\n');
    expect(() => analyzeWorkflow(bomb)).not.toThrow();
    expect(analyzeWorkflow(bomb).parsed).toBe(false);
    expect(
      analyzeWorkflow('on: push\njobs: !!python/object/apply:os.system ["echo pwned"]')
        .externalActions,
    ).toBe(0);
    expect(analyzeWorkflow('{{{{ not yaml').parsed).toBe(false);
    expect(analyzeWorkflow('- just\n- a list').parsed).toBe(false);
    expect(analyzeWorkflow('').parsed).toBe(false);
  });

  it('handles `on` given as list, string and mapping', () => {
    for (const on of [
      'pull_request_target',
      '[pull_request_target]',
      '{pull_request_target: {}}',
    ]) {
      expect(analyzeWorkflow(`on: ${on}\njobs: {}`).pullRequestTarget, on).toBe(true);
    }
  });
});

describe('analyzeTree', () => {
  it('counts source and test files, ignoring vendored and doc directories', () => {
    const t = analyzeTree(
      blobs(
        'src/a.ts',
        'src/b.ts',
        'lib/c.py',
        'src/a.test.ts',
        'tests/test_x.py',
        'pkg/x_test.go',
        'spec/y.rb',
        'node_modules/dep/index.js',
        'vendor/z.go',
        'dist/bundle.js',
        'docs/example.js',
        'examples/demo.py',
        'README.md',
      ),
    );
    expect(t.sourceFileCount).toBe(3);
    expect(t.testFileCount).toBe(4);
  });

  it('detects health and supply-chain files in conventional locations only', () => {
    const t = analyzeTree(
      blobs(
        '.github/SECURITY.md',
        'CODE_OF_CONDUCT.md',
        'docs/CONTRIBUTING.md',
        'CHANGELOG.md',
        'LICENSE-MIT',
        '.github/CODEOWNERS',
        '.github/ISSUE_TEMPLATE/bug.yml',
        '.github/pull_request_template.md'.replace(
          'pull_request_template',
          'PULL_REQUEST_TEMPLATE',
        ),
        '.github/dependabot.yaml',
        'Dockerfile',
        'pnpm-lock.yaml',
        'eslint.config.mjs',
        'tsconfig.json',
        '.env.example',
        'docs/guide.md',
        'examples/a.js',
        'action.yml',
        'Makefile',
        'k8s/deploy.yaml',
        'sbom.cdx.json',
      ),
    );
    for (const [k, v] of Object.entries(t.flags)) expect(v, k).toBe(true);
  });

  it('does not invent files: nested lookalikes and near-misses are not matches', () => {
    const t = analyzeTree(
      blobs(
        'src/deep/SECURITY.md',
        'vendor/pkg/LICENSE',
        'securityx.md',
        'notes/CONTRIBUTING.md',
        'src/Dockerfilex',
      ),
    );
    expect(t.flags.security_policy).toBe(false);
    expect(t.flags.contributing).toBe(false);
    expect(t.flags.license_file).toBe(false);
    expect(t.flags.dockerfile).toBe(false);
  });

  it('collects workflow, manifest and lock paths with depth limits', () => {
    const t = analyzeTree(
      blobs(
        '.github/workflows/ci.yml',
        '.github/workflows/nested/x.yml',
        'package.json',
        'a/b/package.json',
        'a/b/c/d/package.json',
        'package-lock.json',
        'x/y/z/package-lock.json',
        'node_modules/p/package.json',
      ),
    );
    expect(t.workflowPaths).toEqual(['.github/workflows/ci.yml']);
    expect(t.manifestPaths).toEqual(['package.json', 'a/b/package.json']);
    expect(t.lockPaths).toEqual(['package-lock.json']);
  });

  it('drops unsafe tree paths (traversal, backslashes, empties) and non-blob entries', () => {
    expect(isSafeTreePath('a/../b')).toBe(false);
    expect(isSafeTreePath('a\\b')).toBe(false);
    expect(isSafeTreePath('/abs')).toBe(false);
    expect(isSafeTreePath('a//b')).toBe(false);
    expect(isSafeTreePath('ok/path.ts')).toBe(true);
    const t = analyzeTree([
      { path: '../evil.js', type: 'blob' },
      { path: 'sub', type: 'tree' },
      { path: 'mod', type: 'commit' },
      { path: 'ok.js', type: 'blob' },
    ]);
    expect(t.fileCount).toBe(1);
  });

  it('handles an empty tree', () => {
    const t = analyzeTree([]);
    expect(t.fileCount).toBe(0);
    expect(Object.values(t.flags).every((v) => v === false)).toBe(true);
  });
});

describe('analyzeReadme', () => {
  it('finds structure and a purpose statement while skipping badges and headings', () => {
    const r = analyzeReadme(
      `<h1 align="center">Logo</h1>\n\n[![CI](https://x/badge.svg)](https://x)\n\n# Tool\n\nTool turns CSV files into typed JSON documents quickly.\n\n## Install\n\n\`\`\`sh\nnpm i tool\n\`\`\`\n\n## Usage\n\n\`\`\`js\ntool()\n\`\`\`\n\n### Configuration options\n\n## Deploying with Docker\n`,
    );
    expect(r).toMatchObject({
      hasInstall: true,
      hasUsage: true,
      hasConfigDocs: true,
      hasDeployDocs: true,
      codeBlockCount: 2,
    });
    expect(r.purposeStatement).toBe('Tool turns CSV files into typed JSON documents quickly.');
  });
  it('reports no purpose statement for headings/badges-only READMEs', () => {
    expect(analyzeReadme('# T\n\n![b](x.svg)\n\n---\n').purposeStatement).toBeUndefined();
    expect(analyzeReadme('').lengthChars).toBe(0);
  });
  it('is not fooled by headings inside code or prose that merely mention install', () => {
    const r = analyzeReadme('# T\n\nPlease install it somehow and then use it.\n');
    expect(r.hasInstall).toBe(false);
    expect(r.hasUsage).toBe(false);
  });
  it('stays fast on pathological input (ReDoS guard)', () => {
    const t0 = Date.now();
    analyzeReadme(
      '#'.repeat(50_000) + '\n' + '['.repeat(50_000) + '`'.repeat(50_000) + ' '.repeat(100_000),
    );
    analyzeReadme(('![' + 'a'.repeat(1000)).repeat(500));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('handles non-Latin purpose statements', () => {
    const r = analyzeReadme(
      '# Công cụ\n\nCông cụ này giúp sao lưu cơ sở dữ liệu PostgreSQL theo từng phần.\n',
    );
    expect(r.purposeStatement).toContain('sao lưu');
  });
});
