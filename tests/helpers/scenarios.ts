import { baseSpec, type FakeSpec, type FakeItem } from './fake-github.js';

const WORKFLOW_GOOD = `
name: ci
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
      - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567
      - run: npm ci
      - run: npm test
  codeql:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: github/codeql-action/analyze@0123456789abcdef0123456789abcdef01234567
`;

const README_GOOD = `# Widget

Widget is a distributed task queue for Node.js that runs background jobs on worker processes.

## Installation

\`\`\`sh
npm install widget
\`\`\`

## Usage

\`\`\`js
import { Queue } from 'widget';
\`\`\`

\`\`\`js
await queue.add('job');
\`\`\`

## Configuration

Set WIDGET_URL.
${'More documentation text. '.repeat(100)}
`;

const items = (n: number, mk: (i: number) => FakeItem): FakeItem[] =>
  Array.from({ length: n }, (_, i) => mk(i));

/** A healthy, well-run project: everything present, Scorecard + OSV data available. */
export function goodRepo(over: Partial<FakeSpec> = {}): FakeSpec {
  const files: Record<string, string> = {
    'README.md': README_GOOD,
    LICENSE: 'MIT',
    'SECURITY.md': 'report to security@example.com',
    'CONTRIBUTING.md': 'be nice',
    'CODE_OF_CONDUCT.md': 'be kind',
    'CHANGELOG.md': '# changes',
    CODEOWNERS: '* @acme/core',
    '.github/ISSUE_TEMPLATE/bug.md': 'bug',
    '.github/PULL_REQUEST_TEMPLATE.md': 'pr',
    '.github/dependabot.yml': 'version: 2',
    '.github/workflows/ci.yml': WORKFLOW_GOOD,
    'package.json': JSON.stringify({
      name: 'widget',
      description: 'Distributed task queue for background jobs',
      keywords: ['task-queue', 'background-jobs'],
      dependencies: { bullmq: '^5.0.0', redis: '^4.0.0' },
      devDependencies: { eslint: '^9.0.0', vitest: '^3.0.0' },
    }),
    'package-lock.json': JSON.stringify({
      packages: {
        '': { name: 'widget' },
        'node_modules/bullmq': { version: '5.1.0' },
        'node_modules/redis': { version: '4.6.0' },
        'node_modules/lodash': { version: '4.17.10' },
      },
    }),
    'tsconfig.json': '{}',
    'eslint.config.js': 'export default []',
    'sbom.json': '{}',
    'docs/guide.md': 'docs',
    'examples/basic.js': 'example',
    '.env.example': 'X=1',
  };
  for (let i = 0; i < 10; i++) files[`src/mod${i}.ts`] = 'export {}';
  for (let i = 0; i < 8; i++) files[`tests/mod${i}.test.ts`] = 'test';
  return baseSpec({
    description: 'Distributed task queue for Node.js background jobs',
    topics: ['task-queue', 'background-jobs', 'nodejs'],
    createdDaysAgo: 1500,
    pushedDaysAgo: 3,
    files,
    readme: README_GOOD,
    contributors: Array.from({ length: 30 }, (_, i) => ({
      login: `dev${i}`,
      contributions: 100 - i * 2,
    })),
    releases: [
      {
        daysAgo: 10,
        assets: ['widget.tgz', 'widget.tgz.sig', 'widget.intoto.jsonl', 'sbom.spdx.json'],
      },
      { daysAgo: 50, assets: ['widget.tgz'] },
      { daysAgo: 95, assets: ['widget.tgz'] },
      { daysAgo: 140, assets: ['widget.tgz'] },
    ],
    commitDaysAgo: Array.from({ length: 100 }, (_, i) => 1 + i * 2),
    commitsTotal: 1500,
    issues: [
      ...items(10, (i) => ({
        state: 'closed' as const,
        createdDaysAgo: 30 + i,
        updatedDaysAgo: 20,
        closedDaysAgo: 28 + i,
      })),
      ...items(4, () => ({ state: 'open' as const, createdDaysAgo: 20, updatedDaysAgo: 5 })),
    ],
    pulls: [
      ...items(10, (i) => ({
        state: 'closed' as const,
        createdDaysAgo: 20 + i,
        updatedDaysAgo: 10,
        closedDaysAgo: 19 + i,
      })),
      ...items(4, () => ({ state: 'open' as const, createdDaysAgo: 20, updatedDaysAgo: 5 })),
    ],
    branchProtected: true,
    scorecard: {
      date: '2025-12-20T00:00:00Z',
      score: 8.4,
      checks: [
        'Branch-Protection',
        'Dangerous-Workflow',
        'Token-Permissions',
        'Pinned-Dependencies',
        'Security-Policy',
        'Signed-Releases',
        'Vulnerabilities',
        'SAST',
        'Code-Review',
        'Maintained',
        'Binary-Artifacts',
        'CII-Best-Practices',
        'Fuzzing',
        'CI-Tests',
        'Dependency-Update-Tool',
      ].map((name) => ({ name, score: 9 })),
    },
    osvVulns: {},
    ...over,
  });
}

/** Barely exists: no readme, no tests, no history. */
export function emptyRepo(over: Partial<FakeSpec> = {}): FakeSpec {
  return baseSpec({
    repo: 'tmp',
    description: null,
    language: null,
    license: null,
    createdDaysAgo: 3,
    pushedDaysAgo: 3,
    files: { 'main.py': 'print(1)' },
    commitDaysAgo: [3],
    commitsTotal: 1,
    ...over,
  });
}

export function archivedRepo(): FakeSpec {
  return goodRepo({
    archived: true,
    pushedDaysAgo: 900,
    commitDaysAgo: [900, 905, 910],
    commitsTotal: 300,
    releases: [{ daysAgo: 900 }],
  });
}

export function noReleasesRepo(): FakeSpec {
  return goodRepo({ releases: [], hasTags: false });
}

/** A coined brand name that says nothing about purpose; and a name with symbols/Unicode. */
export function brandNameRepo(): FakeSpec {
  return goodRepo({ displayName: 'zorblax' });
}
export function unicodeNameRepo(): FakeSpec {
  return goodRepo({ displayName: 'xq⚡-Ünïcode' });
}

/** Impressive README, tiny implementation, no tests, thin history. */
export function readmeHeavyRepo(): FakeSpec {
  const readme = `# Hyperion\n\nHyperion is a revolutionary next generation framework for everything.\n\n## Installation\n\n\`\`\`sh\nnpm i hyperion\n\`\`\`\n\n## Usage\n\n${'Lots of impressive marketing prose goes here. '.repeat(250)}`;
  return baseSpec({
    repo: 'hyperion',
    description: 'Revolutionary next generation framework',
    topics: ['framework'],
    createdDaysAgo: 60,
    pushedDaysAgo: 2,
    readme,
    files: {
      'README.md': readme,
      'index.js': 'module.exports = {}',
      'lib/a.js': 'x',
      '.github/workflows/ci.yml':
        'name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo hello\n',
    },
    commitDaysAgo: [2, 2, 2],
    commitsTotal: 3,
    contributors: [{ login: 'solo', contributions: 3 }],
  });
}
