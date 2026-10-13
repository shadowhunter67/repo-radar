import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import {
  DEFAULT_RETRIEVAL_BUDGET,
  dirPriority,
  retrieveTargeted,
  type TreeFetcher,
  type TreeNode,
} from '../../src/collectors/github/retrieval.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

/** A repository as a map dir -> listing, so the fetcher can answer `tree:<dir>` like GitHub does. */
function fsFetcher(
  files: string[],
  log: string[] = [],
  fail: Set<string> = new Set(),
): TreeFetcher {
  return async (shaOrRef, recursive) => {
    log.push(`${shaOrRef}${recursive ? '?r' : ''}`);
    if (fail.has(shaOrRef)) return undefined;
    const dir = shaOrRef.startsWith('tree:') ? shaOrRef.slice(5) : '';
    const prefix = dir ? `${dir}/` : '';
    const out = new Map<string, TreeNode>();
    for (const f of files.filter((p) => p.startsWith(prefix))) {
      const sub = f.slice(prefix.length);
      const parts = sub.split('/');
      if (recursive) {
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join('/');
          out.set(d, { path: d, type: 'tree', sha: `tree:${prefix}${d}` });
        }
        out.set(sub, { path: sub, type: 'blob', size: 10 });
      } else if (parts.length === 1) out.set(sub, { path: sub, type: 'blob', size: 10 });
      else {
        const d = parts[0] as string;
        out.set(d, { path: d, type: 'tree', sha: `tree:${prefix}${d}` });
      }
    }
    return { tree: [...out.values()], truncated: false, bytes: 100 };
  };
}
const opts = { reason: 'response_too_large' as const, githubTruncated: false };
/** The v2 behaviour: only the generic pool pays for anything (no declared-path pool, no manifest seeking). */
const GENERIC_ONLY = {
  declared: { maxRequests: 0, maxHintReads: 0 },
  seek: { enabled: false },
} as const;

describe('directory priority', () => {
  it('reads CI and build directories first, source roots next, low-ranks docs/tests/vendor, and never reads dependency/VCS directories', () => {
    expect(dirPriority('.github')).toBeGreaterThan(dirPriority('src'));
    expect(dirPriority('.github/workflows')).toBe(1000);
    // breadth first: every directory of one level before any directory one level deeper
    expect(dirPriority('flink-core')).toBeGreaterThan(dirPriority('flink-core/src'));
    expect(dirPriority('zzz')).toBeGreaterThan(dirPriority('src/main'));
    expect(dirPriority('scripts')).toBeGreaterThan(dirPriority('packages'));
    expect(dirPriority('packages')).toBeGreaterThan(dirPriority('random-dir'));
    for (const d of ['node_modules', 'src/node_modules', '.git', 'a/b/.venv'])
      expect(dirPriority(d), d).toBe(-1);
    // low does not mean never
    for (const d of ['vendor', 'docs', 'tests', 'examples', 'testdata', 'dist']) {
      expect(dirPriority(d), d).toBeGreaterThan(0);
      expect(dirPriority(d), d).toBeLessThan(dirPriority('random-dir'));
    }
  });
});

describe('targeted retrieval', () => {
  const repo = [
    'package.json',
    'README.md',
    '.github/workflows/ci.yml',
    'packages/a/package.json',
    'packages/b/package.json',
    'src/index.ts',
    'node_modules/x/package.json',
    'docs/guide.md',
    'tests/unit/a.test.ts',
    'scripts/install.sh',
  ];

  it('lists the root, then CI/build directories and package roots, and reports what it left unread', async () => {
    const log: string[] = [];
    const r = await retrieveTargeted(fsFetcher(repo, log), 'main', DEFAULT_RETRIEVAL_BUDGET, opts);
    const paths = r.entries.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'package.json',
        '.github/workflows/ci.yml',
        'packages/a/package.json',
        'scripts/install.sh',
        'src/index.ts',
      ]),
    );
    expect(log.join(' ')).not.toMatch(/node_modules/);
    expect(r.report.method).toBe('targeted');
    expect(r.report.complete).toBe(false); // node_modules is known but never read
    expect(r.report.skipped_by_rule).toBe(1);
    expect(r.report.passes.map((x) => x.name)).toEqual(
      expect.arrayContaining(['root', 'ci_build']),
    );
    expect(r.report.stopped_by).toBe('complete');
    expect(log[0]).toBe('main'); // root first
    expect(log.indexOf('tree:.github')).toBeLessThan(log.indexOf('tree:src'));
  });

  it('request budget stops the walk visibly instead of truncating silently', async () => {
    const log: string[] = [];
    const r = await retrieveTargeted(
      fsFetcher(repo, log),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, ...GENERIC_ONLY, maxRequests: 2 },
      opts,
    );
    expect(log).toHaveLength(2);
    expect(r.report.requests).toBe(2);
    expect(r.report.stopped_by).toBe('request_budget');
    expect(r.report.complete).toBe(false);
  });

  it('node, byte and time budgets are enforced', async () => {
    const files = Array.from({ length: 50 }, (_, i) => `f${i}.txt`);
    const nodes = await retrieveTargeted(
      fsFetcher(files),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxNodes: 10 },
      opts,
    );
    expect(nodes.entries.length).toBeLessThanOrEqual(10);
    const bytes = await retrieveTargeted(
      fsFetcher(repo),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxBytes: 150 },
      opts,
    );
    expect(bytes.report.stopped_by).toBe('byte_budget');
    let t = 0;
    const time = await retrieveTargeted(
      fsFetcher(repo),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxMillis: 5 },
      {
        ...opts,
        now: () => (t += 10),
      },
    );
    expect(time.report.stopped_by).toBe('time_budget');
  });

  it('depth is limited', async () => {
    const deep = ['a/b/c/d/e/f/package.json', 'src/x/y/z/w/v/u/t.ts'];
    const log: string[] = [];
    await retrieveTargeted(
      fsFetcher(deep, log),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, ...GENERIC_ONLY, maxDepth: 1 },
      opts,
    );
    expect(log.some((l) => /tree:a\/b\/c/.test(l))).toBe(false);
  });

  it('a failed subtree request is recorded and the directory stays unread', async () => {
    const r = await retrieveTargeted(
      fsFetcher(repo, [], new Set(['tree:packages'])),
      'main',
      DEFAULT_RETRIEVAL_BUDGET,
      opts,
    );
    expect(r.report.failed_requests).toBe(1);
    expect(r.report.complete).toBe(false);
    expect(r.report.unexplored).toContain('packages');
  });

  it('hostile names (traversal, backslash, control characters) are never added or followed', async () => {
    const fetcher: TreeFetcher = async (ref) => ({
      truncated: false,
      bytes: 10,
      tree:
        ref === 'main'
          ? [
              { path: '..', type: 'tree', sha: 'tree:..' },
              { path: 'a\\b', type: 'blob', size: 1 },
              { path: 'x\u001b[2Jy', type: 'blob', size: 1 },
              { path: 'ok.txt', type: 'blob', size: 1 },
            ]
          : [],
    });
    const r = await retrieveTargeted(fetcher, 'main', DEFAULT_RETRIEVAL_BUDGET, opts);
    expect(r.entries.map((e) => e.path)).toEqual(['ok.txt']);
  });

  it('a truncated recursive listing is merged, not refetched, and the result stays incomplete', async () => {
    const initial: TreeNode[] = [
      { path: 'package.json', type: 'blob', size: 1 },
      { path: 'src', type: 'tree', sha: 'tree:src' },
      { path: 'src/a.ts', type: 'blob', size: 1 },
    ];
    const log: string[] = [];
    const r = await retrieveTargeted(fsFetcher(repo, log), 'main', DEFAULT_RETRIEVAL_BUDGET, {
      initial,
      reason: 'github_truncated',
      githubTruncated: true,
    });
    expect(log).not.toContain('tree:src'); // already has children
    expect(r.report.complete).toBe(false);
    expect(r.report.github_truncated).toBe(true);
  });
});

describe('analysis of repositories whose recursive tree is too large or truncated', () => {
  const big = (over: Partial<FakeSpec> = {}): FakeSpec => {
    const spec = goodRepo();
    spec.files = {
      'package.json': JSON.stringify({
        name: 'big',
        version: '1.0.0',
        dependencies: { left: '1.0.0' },
      }),
      '.github/workflows/ci.yml':
        'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
      'packages/a/package.json': JSON.stringify({ name: 'a', version: '1.0.0' }),
      'packages/b/package.json': JSON.stringify({ name: 'b', version: '1.0.0' }),
      'src/index.js': 'module.exports = 1;\n',
      'node_modules/x/package.json': '{}',
      'docs/a.md': '# hi',
    };
    Object.assign(spec, over);
    return spec;
  };
  const run = (spec: FakeSpec, extra: Parameters<typeof analyzeRepository>[1] = {}) =>
    analyzeRepository(`${spec.owner}/${spec.repo}`, {
      fetch: fakeFetch(spec),
      clock: fixedClock,
      ...extra,
    });

  it('an oversized recursive tree triggers a targeted walk that still finds manifests and workflows', async () => {
    const spec = big({ treeTooLarge: true });
    const r = await run(spec);
    expect(r.retrieval).toMatchObject({
      method: 'targeted',
      complete: false,
      reason: 'response_too_large',
    });
    expect(r.diagnostics.map((d) => d.code)).toContain('tree_incomplete');
    expect(r.coverage_map.manifest.state).toBe('targeted');
    expect(r.coverage_map.documentation.state).toBe('partial');
    expect(r.dependency_intel.summary.discovered).toBeGreaterThan(0);
    expect(r.evidence.find((e) => e.id === 'github.workflows.count')?.value).toBe(1);
    expect(spec.treeRequests.some((p) => /node_modules/.test(decodeURIComponent(p)))).toBe(false);
  });

  it('a tree GitHub truncated is not treated as complete, and absence in it stays uncertain', async () => {
    const spec = big({ treeTruncated: true, treeKeep: 2 });
    const r = await run(spec);
    expect(r.retrieval.github_truncated).toBe(true);
    expect(r.retrieval.complete).toBe(false);
    expect(r.retrieval.method).toBe('targeted');
    expect(r.coverage_map.source.state).not.toBe('complete');
  });

  it('with the targeted walk disabled the tree is unavailable and says so', async () => {
    const r = await run(big({ treeTooLarge: true }), { targetedTree: false });
    expect(r.retrieval.method).toBe('none');
    expect(r.diagnostics.map((d) => d.code)).toContain('tree_unavailable');
    expect(r.coverage_map.manifest.state).toBe('none');
  });

  it('a tiny request budget is respected and reported', async () => {
    const spec = big({ treeTooLarge: true });
    const r = await run(spec, {
      retrievalBudget: { ...DEFAULT_RETRIEVAL_BUDGET, ...GENERIC_ONLY, maxRequests: 2 },
    });
    expect(r.retrieval.requests).toBeLessThanOrEqual(2);
    expect(r.retrieval.stopped_by).toBe('request_budget');
  });

  it('a normal repository reports a complete recursive tree and complete structural coverage', async () => {
    const r = await run(goodRepo());
    expect(r.retrieval).toMatchObject({ method: 'recursive', complete: true });
    expect(r.coverage_map.manifest.state).toBe('complete');
  });
});

describe('retrieval v2: structural hints, wide directories, passes', () => {
  const files = [
    'Cargo.toml',
    'crates/a/Cargo.toml',
    'crates/b/Cargo.toml',
    'zzz-other/readme.txt',
    'aaa-first/readme.txt',
    'src/lib.rs',
    'CMakeLists.txt',
    'engine/CMakeLists.txt',
    'engine/core/x.c',
  ];
  const reader = (texts: Record<string, string>) => async (path: string) => texts[path];

  it('a Cargo workspace names its members, which then outrank unknown directories', async () => {
    const log: string[] = [];
    const r = await retrieveTargeted(
      fsFetcher(files, log),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxRequests: 4 },
      {
        ...opts,
        readHint: reader({ 'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n' }),
      },
    );
    expect(r.report.hints.files).toContain('Cargo.toml');
    expect(r.report.hints.directories_named).toBeGreaterThan(0);
    expect(log.indexOf('tree:crates')).toBeGreaterThan(-1);
    expect(log.indexOf('tree:crates')).toBeLessThan(
      log.indexOf('tree:aaa-first') === -1 ? 99 : log.indexOf('tree:aaa-first'),
    );
  });

  it('CMake add_subdirectory targets are followed before alphabetically earlier unrelated directories', async () => {
    const log: string[] = [];
    await retrieveTargeted(
      fsFetcher(files, log),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxRequests: 4 },
      {
        ...opts,
        readHint: reader({ 'CMakeLists.txt': 'add_subdirectory(engine)\n' }),
      },
    );
    expect(log).toContain('tree:engine');
    expect(log).not.toContain('tree:aaa-first');
  });

  it('hint reads are budgeted and counted as requests', async () => {
    const reads: string[] = [];
    const r = await retrieveTargeted(
      fsFetcher(files),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, ...GENERIC_ONLY, maxHintReads: 1 },
      {
        ...opts,
        readHint: async (p) => (reads.push(p), '[workspace]\nmembers = ["crates/*"]\n'),
      },
    );
    expect(reads.length).toBe(1);
    expect(r.report.hints.files_read).toBe(1);
    expect(r.report.requests).toBeGreaterThanOrEqual(2);
  });

  it('a wide directory is recorded and its children are deprioritised', async () => {
    const wide = Array.from({ length: 30 }, (_, i) => `drivers/d${i}/x.c`);
    const r = await retrieveTargeted(
      fsFetcher([...wide, 'src/a.c', 'src/sub/b.c']),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, ...GENERIC_ONLY, wideFanout: 10, maxRequests: 6 },
      opts,
    );
    expect(r.report.wide_directories).toContain('drivers');
    expect(r.report.explored).toContain('src');
    expect(r.report.explored.filter((d) => d.startsWith('drivers/')).length).toBeLessThan(4);
  });

  it('hostile hint content cannot produce unsafe paths', async () => {
    const r = await retrieveTargeted(fsFetcher(files), 'main', DEFAULT_RETRIEVAL_BUDGET, {
      ...opts,
      readHint: reader({
        'Cargo.toml': '[workspace]\nmembers = ["../../etc", "/abs", "crates/*", "a/../b"]\n',
      }),
    });
    expect(r.entries.every((e) => !e.path.includes('..') && !e.path.startsWith('/'))).toBe(true);
  });
});

describe('retrieval v2: hint extraction', () => {
  it('extracts the directories each build/workspace file names, as data only', async () => {
    const { extractHints } = await import('../../src/collectors/github/hints.js');
    expect(
      extractHints('go.work', '', 'use (\n\t./staging/src/k8s.io/api\n\t./cmd/x\n)\n').exact,
    ).toEqual(['staging/src/k8s.io/api', 'cmd/x']);
    expect(
      extractHints(
        'settings.gradle',
        '',
        "include ':app', ':libs:core'\nincludeBuild('build-logic')\n",
      ).exact,
    ).toEqual(['app', 'libs/core', 'build-logic']);
    expect(
      extractHints('pom.xml', '', '<modules><module>a</module><module>b/c</module></modules>')
        .exact,
    ).toEqual(['a', 'b/c']);
    expect(extractHints('package.json', '', '{"workspaces":["packages/*","tools/cli"]}')).toEqual({
      exact: ['tools/cli'],
      parents: ['packages'],
      rejected: 0,
    });
    expect(
      extractHints('Makefile', '', 'core-y += kernel/ mm/ fs/\ndrivers-y += drivers/ \\n').exact,
    ).toEqual(expect.arrayContaining(['kernel', 'mm', 'fs', 'drivers']));
    expect(extractHints('Makefile.am', '', 'SUBDIRS = lib src\n').exact).toEqual(['lib', 'src']);
    expect(extractHints('meson.build', '', "subdir('src')\n").exact).toEqual(['src']);
    expect(extractHints('package.json', '', 'not json').exact).toEqual([]);
  });

  it('directories on the way to a hinted directory are listed first (ancestors)', async () => {
    const files = ['go.work', 'deep/a/b/go.mod', 'aaa/x.txt', 'deep/a/x.txt'];
    const log: string[] = [];
    await retrieveTargeted(
      fsFetcher(files, log),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxRequests: 5 },
      {
        ...opts,
        readHint: async (p) => (p === 'go.work' ? 'use ./deep/a/b\n' : undefined),
      },
    );
    expect(log).toContain('tree:deep/a');
    expect(log.indexOf('tree:deep')).toBeLessThan(
      log.indexOf('tree:aaa') === -1 ? 99 : log.indexOf('tree:aaa'),
    );
  });
});
