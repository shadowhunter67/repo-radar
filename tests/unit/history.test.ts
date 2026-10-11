import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { BlobCache } from '../../src/collectors/github/blobcache.js';
import { compareSnapshots, renderHistoricalText } from '../../src/history/index.js';
import type { Report } from '../../src/report/schema.js';
import { installerRepo } from '../helpers/code-scenarios.js';
import { fakeFetch, fixedClock, blobSha, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const run = (
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    ...extra,
  });

describe('historical comparison', () => {
  it('a newly introduced install hook with a download-and-execute chain is reported as a new execution path and a risk increase', async () => {
    const before = await run(goodRepo());
    const after = await run(installerRepo());
    const d = compareSnapshots(before, after);
    expect(d.comparability.level).toBe('comparable');
    const hook = d.execution.find((e) => e.change === 'new' && e.for_dependents);
    expect(hook).toBeDefined();
    expect(hook?.path).toMatch(/postinstall/);
    expect(d.capabilities.find((c) => c.capability === 'PROCESS_EXEC')?.change).toBe('new');
    expect(d.capabilities.find((c) => c.capability === 'REMOTE_DOWNLOAD')?.change).toBe('new');
    const up = d.risk.reasons
      .filter((r) => r.direction === 'increase')
      .map((r) => r.text)
      .join('\n');
    expect(up).toMatch(/new install-time hook/);
    expect(up).toMatch(/new capability/);
    for (const r of d.risk.reasons) expect(r.traces.length).toBeGreaterThan(0);
    expect(renderHistoricalText(d)).toMatch(/RISK DELTA[\s\S]*\+ new install-time hook/);
  });

  it('the reverse comparison reports removals and a decrease, and removals are observed only when coverage allows', async () => {
    const d = compareSnapshots(await run(installerRepo()), await run(goodRepo()));
    expect(d.execution.some((e) => e.change === 'removed')).toBe(true);
    expect(d.risk.reasons.some((r) => r.direction === 'decrease')).toBe(true);
  });

  it('dependency deltas: added, removed, version changed, new vulnerability, new git dependency, new unpinned', async () => {
    const a = goodRepo();
    const b = goodRepo();
    b.files['package.json'] = JSON.stringify({
      name: 'widget',
      dependencies: { bullmq: '^5.0.0', leftpad: '1.3.0', fresh: 'github:evil/fresh', loose: '*' },
    });
    b.files['package-lock.json'] = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/bullmq': { version: '5.2.0' },
        'node_modules/leftpad': { version: '1.3.0' },
      },
    });
    b.osvVulns = { leftpad: ['GHSA-new'] };
    const d = compareSnapshots(await run(a), await run(b));
    const kinds = d.dependencies.map((x) => `${x.kind}:${x.package}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'added:npm:leftpad',
        'removed:npm:redis',
        'version_changed:npm:bullmq',
        'new_vulnerability:npm:leftpad',
        'new_git_or_path_dependency:npm:fresh',
        'new_unpinned_dependency:npm:loose',
      ]),
    );
    expect(d.dependencies.find((x) => x.kind === 'new_vulnerability')?.advisory_ids).toEqual([
      'GHSA-new',
    ]);
    expect(d.risk.reasons.some((r) => /new vulnerability GHSA-new/.test(r.text))).toBe(true);
  });

  it('a removal in an incomplete tree is inconclusive, not a clean result', async () => {
    const full = goodRepo();
    const partial = goodRepo({ treeTruncated: true, treeKeep: 1 });
    delete partial.files['sbom.json'];
    const d = compareSnapshots(await run(full), await run(partial));
    expect(d.comparability.level).not.toBe('comparable');
    expect(
      d.dependencies
        .filter((x) => x.kind === 'removed')
        .every((x) => x.certainty === 'inconclusive'),
    ).toBe(true);
  });

  it('different methodologies make scores not directly comparable and withhold numeric deltas', async () => {
    const a = await run(goodRepo());
    const b = JSON.parse(JSON.stringify(await run(goodRepo()))) as Report;
    b.methodology.version = '9.9';
    const d = compareSnapshots(a, b);
    expect(d.comparability.level).toBe('not_directly_comparable');
    expect(d.risk.overall.delta).toBeNull();
    expect(d.risk.dimensions.every((x) => x.delta === null)).toBe(true);
    expect(renderHistoricalText(d)).toMatch(/not meaningful/);
  });

  it('identical analyses produce no deltas and tolerate old or empty reports', async () => {
    const r = await run(goodRepo());
    const d = compareSnapshots(r, r);
    expect(d.dependencies).toEqual([]);
    expect(d.execution).toEqual([]);
    expect(d.capabilities.every((c) => c.change === 'unchanged')).toBe(true);
    expect(compareSnapshots({}, null).risk.reasons).toEqual([]);
  });

  it('terminal control characters in changed names never reach the rendered text', async () => {
    const esc = String.fromCharCode(27);
    const b = goodRepo();
    b.files['package.json'] = JSON.stringify({
      name: 'w',
      dependencies: { [`x${esc}[2Jy`]: '1.0.0' },
    });
    const d = compareSnapshots(await run(goodRepo()), await run(b));
    expect(renderHistoricalText(d).includes(esc)).toBe(false);
  });
});

describe('within-run blob reuse', () => {
  it('a second analysis of unchanged files is served from the cache, with fewer requests', async () => {
    const spec = installerRepo();
    const cache = new BlobCache();
    const r1 = await run(spec, { blobCache: cache });
    const r2 = await run(spec, { blobCache: cache });
    expect(cache.hits).toBeGreaterThan(0);
    expect(r2.stats.http_requests).toBeLessThan(r1.stats.http_requests);
    expect(r2.code_analysis.execution.hooks.length).toBe(r1.code_analysis.execution.hooks.length);
  });

  it('only content-addressed (40-hex) keys are stored and capacity is bounded', () => {
    const c = new BlobCache(2, 1000);
    c.set('o/r', 'nothex', 'x');
    c.set('o/r', blobSha('a'), 'a');
    c.set('o/r', blobSha('b'), 'b');
    c.set('o/r', blobSha('c'), 'c');
    expect(c.size).toBe(2);
    expect(c.get('o/r', undefined)).toBeUndefined();
  });
});
