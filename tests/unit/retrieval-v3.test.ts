import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { extractHints } from '../../src/collectors/github/hints.js';
import {
  DEFAULT_RETRIEVAL_BUDGET,
  retrieveTargeted,
  type RetrievalBudget,
  type TreeFetcher,
  type TreeNode,
} from '../../src/collectors/github/retrieval.js';
import { ReportSchema } from '../../src/report/schema.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

/** A repository as a path list; recursive listings can be forced to report `truncated`. */
function fsFetcher(
  files: string[],
  log: string[] = [],
  o: { truncateRecursive?: boolean } = {},
): TreeFetcher {
  return async (shaOrRef, recursive) => {
    log.push(`${shaOrRef}${recursive ? '?r' : ''}`);
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
    return {
      tree: [...out.values()],
      truncated: recursive && o.truncateRecursive === true,
      bytes: 100,
    };
  };
}
const opts = { reason: 'response_too_large' as const, githubTruncated: false };
const reader = (texts: Record<string, string>) => async (path: string) => texts[path];
const V2: Partial<RetrievalBudget> = {
  declared: { maxRequests: 0, maxHintReads: 0 },
  seek: { enabled: false },
};
const KUBE = [
  'go.work',
  'README.md',
  'staging/src/k8s.io/api/go.mod',
  'staging/src/k8s.io/api/core/v1/types.go',
  'staging/src/k8s.io/client-go/go.mod',
  'staging/src/k8s.io/apimachinery/go.mod',
  'cmd/kubectl/main.go',
  'aaa/x.txt',
  'zzz/y.txt',
];
const GO_WORK =
  'use (\n\t.\n\t./staging/src/k8s.io/api\n\t./staging/src/k8s.io/client-go\n\t./staging/src/k8s.io/apimachinery\n)\n';

describe('retrieval v3: declared paths', () => {
  it('follows a path the build file declares even when it lies deeper than the generic depth budget', async () => {
    const budget = { ...DEFAULT_RETRIEVAL_BUDGET, maxDepth: 1, seek: { enabled: false } };
    const v3 = await retrieveTargeted(fsFetcher(KUBE), 'main', budget, {
      ...opts,
      readHint: reader({ 'go.work': GO_WORK }),
    });
    const found = v3.entries.map((e) => e.path).filter((p) => p.endsWith('go.mod'));
    expect(found.sort()).toEqual([
      'staging/src/k8s.io/api/go.mod',
      'staging/src/k8s.io/apimachinery/go.mod',
      'staging/src/k8s.io/client-go/go.mod',
    ]);
    expect(v3.report.declared_paths.deep).toBeGreaterThanOrEqual(3);
    expect(v3.report.declared_paths.followed).toBeGreaterThanOrEqual(3);
    expect(v3.report.passes.map((p) => p.name)).toContain('declared_deep');
    // the generic limit was not widened: a non-declared directory of the same depth is not listed
    expect(v3.report.explored).not.toContain('staging/src/k8s.io/api/core');
    // the v2 behaviour with the same generic depth finds none of them
    const v2 = await retrieveTargeted(
      fsFetcher(KUBE),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, ...V2, maxDepth: 1 },
      { ...opts, readHint: reader({ 'go.work': GO_WORK }) },
    );
    expect(v2.entries.filter((e) => e.path.endsWith('go.mod'))).toHaveLength(0);
  });

  it('is paid for from its own pool: a tiny generic budget does not starve declared paths', async () => {
    const r = await retrieveTargeted(
      fsFetcher(KUBE),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxRequests: 3, maxDepth: 1, seek: { enabled: false } },
      { ...opts, readHint: reader({ 'go.work': GO_WORK }) },
    );
    expect(r.report.declared_paths.requests).toBeGreaterThan(0);
    expect(r.entries.some((e) => e.path === 'staging/src/k8s.io/api/go.mod')).toBe(true);
    // the report counts every request, whichever pool paid
    expect(r.report.requests).toBeGreaterThan(3);
  });

  it('an exhausted declared pool is a visible stop, not a silent one', async () => {
    const r = await retrieveTargeted(
      fsFetcher(KUBE),
      'main',
      {
        ...DEFAULT_RETRIEVAL_BUDGET,
        maxDepth: 1,
        declared: { maxRequests: 2 },
        seek: { enabled: false },
      },
      { ...opts, readHint: reader({ 'go.work': GO_WORK }) },
    );
    expect(r.report.declared_paths.stopped_by).toBe('request_budget');
    expect(r.report.declared_paths.requests).toBeLessThanOrEqual(2);
    expect(r.report.complete).toBe(false);
  });

  it('declared paths are attacker-controlled: traversal, absolute, drive-letter and template paths are never followed', async () => {
    const hostile =
      'use (\n\t../../etc\n\t/etc/passwd\n\t./ok\n\t../sibling\n\tC:\\windows\n\t./${HOME}/x\n\t./a/../../b\n)\n';
    const log: string[] = [];
    const r = await retrieveTargeted(
      fsFetcher(['go.work', 'ok/go.mod', 'etc/passwd', 'sibling/x'], log),
      'main',
      DEFAULT_RETRIEVAL_BUDGET,
      { ...opts, readHint: reader({ 'go.work': hostile }) },
    );
    expect(r.report.declared_paths.rejected_unsafe).toBeGreaterThanOrEqual(4);
    expect(r.report.declared_paths.accepted).toBe(1);
    expect(r.entries.every((e) => !e.path.includes('..') && !e.path.startsWith('/'))).toBe(true);
    expect(log.some((l) => /\.\.|^tree:\/|windows/.test(l))).toBe(false);
  });

  it('the extractor itself rejects (and counts) unsafe paths from every build-file format', () => {
    expect(extractHints('go.work', '', 'use ../x\nuse ./y\n')).toMatchObject({
      exact: ['y'],
      rejected: 1,
    });
    expect(
      extractHints('pom.xml', '', '<module>../../x</module><module>ok</module>'),
    ).toMatchObject({
      exact: ['ok'],
      rejected: 1,
    });
    expect(
      extractHints('CMakeLists.txt', '', 'add_subdirectory(/abs)\nadd_subdirectory(ok)'),
    ).toMatchObject({
      exact: ['ok'],
      rejected: 1,
    });
    expect(
      extractHints('Cargo.toml', 'sub', '[workspace]\nmembers = ["../up", "inside/*"]'),
    ).toMatchObject({ parents: ['sub/inside'], rejected: 1 });
    expect(extractHints('settings.gradle', '', "include ':a', ':../b'")).toMatchObject({
      exact: ['a'],
    });
  });

  it('thousands of declared modules are capped, counted and do not blow the budget', async () => {
    const many = Array.from({ length: 5000 }, (_, i) => `use ./m${i}`).join('\n');
    const cargo = `[workspace]\nmembers = [${Array.from({ length: 800 }, (_, i) => `"c${i}"`).join(',')}]\n`;
    const pom = Array.from({ length: 800 }, (_, i) => `<module>p${i}</module>`).join('');
    const files = [
      'go.work',
      'Cargo.toml',
      'pom.xml',
      ...Array.from({ length: 50 }, (_, i) => `m${i}/go.mod`),
    ];
    const started = Date.now();
    const r = await retrieveTargeted(fsFetcher(files), 'main', DEFAULT_RETRIEVAL_BUDGET, {
      ...opts,
      readHint: reader({ 'go.work': many, 'Cargo.toml': cargo, 'pom.xml': pom }),
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.report.declared_paths.accepted).toBeLessThanOrEqual(400);
    expect(r.report.declared_paths.rejected_over_limit).toBeGreaterThan(0);
    expect(r.report.declared_paths.stopped_by).toBe('path_limit');
    expect(r.report.requests).toBeLessThanOrEqual(
      DEFAULT_RETRIEVAL_BUDGET.maxRequests +
        (DEFAULT_RETRIEVAL_BUDGET.declared?.maxRequests ?? 0) +
        (DEFAULT_RETRIEVAL_BUDGET.seek?.maxRequests ?? 0),
    );
  });

  it('paths deeper than the declared depth limit are rejected and counted', async () => {
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/');
    const r = await retrieveTargeted(
      fsFetcher(['go.work', `${deep}/go.mod`]),
      'main',
      DEFAULT_RETRIEVAL_BUDGET,
      {
        ...opts,
        readHint: reader({ 'go.work': `use ./${deep}\n` }),
      },
    );
    expect(r.report.declared_paths.rejected_depth).toBe(1);
    expect(r.report.declared_paths.accepted).toBe(0);
  });

  it('recursive and self references cannot loop', async () => {
    const files = ['pom.xml', 'a/pom.xml', 'b/pom.xml', 'a/x.txt'];
    const log: string[] = [];
    const r = await retrieveTargeted(fsFetcher(files, log), 'main', DEFAULT_RETRIEVAL_BUDGET, {
      ...opts,
      readHint: reader({
        'pom.xml': '<module>a</module><module>b</module><module>.</module><module>./</module>',
        'a/pom.xml': '<module>../b</module><module>../a</module><module>a</module>',
        'b/pom.xml': '<module>../a</module><module>b</module>',
      }),
    });
    expect(r.report.requests).toBeLessThan(30);
    expect(new Set(log).size).toBe(log.length); // nothing was listed twice
    expect(r.report.hints.files_read).toBeLessThanOrEqual(3);
  });

  it('malformed build files produce no hints and no crash', () => {
    expect(extractHints('go.work', '', '\u0000\u0000use ( ./a')).toMatchObject({ rejected: 0 });
    expect(extractHints('pom.xml', '', '<module>unterminated').exact).toEqual([]);
    expect(extractHints('CMakeLists.txt', '', 'add_subdirectory(').exact).toEqual([]);
    expect(extractHints('Cargo.toml', '', '[workspace]\nmembers = [').exact).toEqual([]);
    expect(extractHints('package.json', '', '{"workspaces": 12}').exact).toEqual([]);
    expect(
      extractHints('pyproject.toml', '', '[tool.uv.workspace]\nmembers = ["pkgs/*"]').parents,
    ).toEqual(['pkgs']);
    expect(
      extractHints(
        'Directory.sln',
        'src',
        'Project("{AAAA-BBBB}") = "App", "App\\App.csproj", "{X}"',
      ).exact,
    ).toEqual(['src/App']);
  });

  it('a huge CMake graph is read quickly and capped', () => {
    const cmake = Array.from({ length: 30_000 }, (_, i) => `add_subdirectory(sub${i})`).join('\n');
    const t = Date.now();
    const h = extractHints('CMakeLists.txt', '', cmake);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(h.exact.length).toBeLessThanOrEqual(200);
  });

  it('hint files inside declared directories are read from the declared pool (nested workspaces)', async () => {
    const files = [
      'package.json',
      'packages/web/package.json',
      'packages/web/apps/admin/package.json',
      'packages/web/apps/shop/package.json',
      'aaa/x.txt',
    ];
    const r = await retrieveTargeted(
      fsFetcher(files),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, seek: { enabled: false } },
      {
        ...opts,
        readHint: reader({
          'package.json': '{"workspaces":["packages/*"]}',
          'packages/web/package.json': '{"workspaces":["apps/*"]}',
        }),
      },
    );
    expect(r.report.hints.files).toContain('packages/web/package.json');
    expect(r.entries.map((e) => e.path)).toContain('packages/web/apps/admin/package.json');
  });
});

describe('retrieval v3: manifest seeking', () => {
  const FILES = [
    'README.md',
    ...Array.from({ length: 12 }, (_, i) => `mods/m${i}/sub/pkg/package.json`),
    ...Array.from({ length: 12 }, (_, i) => `mods/m${i}/sub/pkg/src/a.ts`),
    'docs/deep/inner/package.json',
    'tests/inner/deep/package.json',
    'vendor/lib/deep/package.json',
  ];

  it('finds deep manifests with one recursive listing per subtree and keeps ONLY manifest files', async () => {
    const log: string[] = [];
    const r = await retrieveTargeted(
      fsFetcher(FILES, log),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxDepth: 1, declared: { maxRequests: 0 } },
      opts,
    );
    expect(r.report.manifest_seek.manifests_found).toBe(12);
    expect(r.report.manifest_seek.subtrees).toBeGreaterThan(0);
    expect(r.report.manifest_seek.requests).toBe(r.report.manifest_seek.subtrees);
    expect(r.report.passes.map((p) => p.name)).toContain('manifest_seek');
    const kept = r.entries.filter((e) => e.type === 'blob' && e.path.startsWith('mods/'));
    expect(kept.every((e) => e.path.endsWith('package.json'))).toBe(true);
    expect(r.entries.some((e) => e.path.endsWith('a.ts'))).toBe(false);
    // documentation, tests and vendored code are not worth a request
    expect(
      log.filter((l) => l.endsWith('?r')).some((l) => /^tree:(docs|tests|vendor)/.test(l)),
    ).toBe(false);
  });

  it('seeking can be switched off, and then the deep manifests stay unseen (and unexplored is reported)', async () => {
    const r = await retrieveTargeted(
      fsFetcher(FILES),
      'main',
      {
        ...DEFAULT_RETRIEVAL_BUDGET,
        maxDepth: 1,
        declared: { maxRequests: 0 },
        seek: { enabled: false },
      },
      opts,
    );
    expect(r.report.manifest_seek).toMatchObject({
      enabled: false,
      stopped_by: 'disabled',
      manifests_found: 0,
    });
    expect(r.report.unexplored_count).toBeGreaterThan(0);
    expect(r.report.complete).toBe(false);
  });

  it('subtree, request and scan budgets stop it visibly', async () => {
    const sub = await retrieveTargeted(
      fsFetcher(FILES),
      'main',
      {
        ...DEFAULT_RETRIEVAL_BUDGET,
        maxDepth: 1,
        declared: { maxRequests: 0 },
        seek: { maxSubtrees: 1 },
      },
      opts,
    );
    expect(sub.report.manifest_seek.subtrees).toBe(1);
    const req = await retrieveTargeted(
      fsFetcher(FILES),
      'main',
      {
        ...DEFAULT_RETRIEVAL_BUDGET,
        maxDepth: 1,
        declared: { maxRequests: 0 },
        seek: { maxRequests: 1 },
      },
      opts,
    );
    expect(req.report.manifest_seek.requests).toBe(1);
    expect(req.report.manifest_seek.stopped_by).toBe('request_budget');
    const scan = await retrieveTargeted(
      fsFetcher(FILES),
      'main',
      {
        ...DEFAULT_RETRIEVAL_BUDGET,
        maxDepth: 1,
        declared: { maxRequests: 0 },
        seek: { maxEntriesScanned: 1 },
      },
      opts,
    );
    expect(scan.report.manifest_seek.stopped_by).toBe('scan_budget');
  });

  it('a truncated subtree listing is partial: manifests are kept, the repository is never complete', async () => {
    const r = await retrieveTargeted(
      fsFetcher(FILES, [], { truncateRecursive: true }),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxDepth: 1, declared: { maxRequests: 0 } },
      opts,
    );
    expect(r.report.manifest_seek.truncated_subtrees).toBeGreaterThan(0);
    expect(r.report.manifest_seek.manifests_found).toBeGreaterThan(0);
    expect(r.report.complete).toBe(false);
  });

  it('shared limits (bytes) stop the walk before any seeking', async () => {
    const r = await retrieveTargeted(
      fsFetcher(FILES),
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxDepth: 1, maxBytes: 150 },
      opts,
    );
    expect(r.report.stopped_by).toBe('byte_budget');
    expect(r.report.manifest_seek.requests).toBe(0);
    expect(r.report.manifest_seek.stopped_by).toBe('byte_budget');
  });

  it('a failed subtree listing is counted and does not stop the others', async () => {
    const base = fsFetcher(FILES);
    const failing: TreeFetcher = async (sha, rec) =>
      sha === 'tree:mods/m3' ? undefined : base(sha, rec);
    const r = await retrieveTargeted(
      failing,
      'main',
      { ...DEFAULT_RETRIEVAL_BUDGET, maxDepth: 1, declared: { maxRequests: 0 } },
      opts,
    );
    expect(r.report.failed_requests + r.report.manifest_seek.failed_subtrees).toBeGreaterThan(0);
    expect(r.report.manifest_seek.manifests_found).toBeGreaterThan(0);
  });

  it('budgets written before v3 (no declared / seek fields) still work', async () => {
    const legacy: RetrievalBudget = {
      maxRequests: 50,
      maxNodes: 1000,
      maxBytes: 1e6,
      maxMillis: 10_000,
      maxDepth: 4,
      maxHintReads: 4,
      wideFanout: 100,
    };
    const r = await retrieveTargeted(fsFetcher(FILES), 'main', legacy, opts);
    expect(r.report.manifest_seek.enabled).toBe(true);
    expect(ReportSchema.shape.retrieval.safeParse(r.report).success).toBe(true);
  });
});

describe('retrieval v3 through the pipeline', () => {
  it('a go.work declared module deeper than the generic depth is found and reported', async () => {
    const base = goodRepo();
    const spec = goodRepo({
      treeTooLarge: true,
      files: {
        ...base.files,
        'go.work': GO_WORK,
        'staging/src/k8s.io/api/go.mod': 'module k8s.io/api\n\ngo 1.22\n',
      },
    });
    const r = await analyzeRepository(`${spec.owner}/${spec.repo}`, {
      fetch: fakeFetch(spec),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
      registry: false,
      retrievalBudget: { ...DEFAULT_RETRIEVAL_BUDGET, maxDepth: 1 },
    });
    expect(ReportSchema.safeParse(r).success).toBe(true);
    expect(r.retrieval.method).toBe('targeted');
    expect(r.retrieval.declared_paths.deep).toBeGreaterThanOrEqual(1);
    expect(r.retrieval.explored).toContain('staging/src/k8s.io/api');
  });
});
