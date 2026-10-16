import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBatch, readBatchList } from '../../src/batch.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';
import { EMPTY_TRUST } from '../../src/trust/config.js';

describe('batch foundation', () => {
  it('analyzes sequentially, reuses immutable snapshots, and aggregates exact counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-batch-'));
    const list = join(dir, 'repos.txt');
    writeFileSync(list, 'acme/widget\n');
    const spec = goodRepo();
    const options = {
      listFile: list,
      snapshotDir: dir,
      fetch: fakeFetch(spec),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    };
    const first = await runBatch(options);
    expect(first.repositories.analyzed).toEqual(['acme/widget']);
    expect(first.repositories.reused).toEqual([]);
    expect(first.repositories.failed).toEqual([]);
    expect(first.requested).toBe(1);
    expect(first.analyzed).toBe(1);
    expect(first.reused).toBe(0);
    expect(first.refreshed).toBe(0);
    expect(first.failed).toBe(0);
    expect(first.critical_findings).toBe(0);
    expect(first).not.toHaveProperty('aggregate_score');
    expect(first.stopped_by).toBeNull();
    expect(first.policy_failures).toBe(0);
    expect(first.freshness['acme/widget']).toBe('snapshot_missing');
    const second = await runBatch(options);
    expect(second.repositories.analyzed).toEqual([]);
    expect(second.repositories.reused).toEqual(['acme/widget']);
    expect(second.repositories.failed).toEqual([]);
    expect(second.reused).toBe(1);
    expect(second.freshness['acme/widget']).toBe('snapshot_exact_match');
    rmSync(dir, { recursive: true, force: true });
  });
  it('stops at max-repos and isolates an analysis failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-batch-'));
    const list = join(dir, 'repos.txt');
    writeFileSync(list, 'acme/widget\nacme/missing\nacme/widget-two\n');
    const result = await runBatch({
      listFile: list,
      maxRepos: 2,
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    });
    expect(result.repositories.analyzed).toEqual(['acme/widget']);
    expect(result.repositories.failed.map((x) => x.repository)).toEqual(['acme/missing']);
    expect(result.repositories.incomplete).toEqual([]);
    expect(result.stopped_by).toBe('max_repos');
    const stopped = await runBatch({
      listFile: list,
      maxRepos: 1,
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    });
    expect(stopped.repositories.analyzed).toEqual(['acme/widget']);
    expect(stopped.stopped_by).toBe('max_repos');
    rmSync(dir, { recursive: true, force: true });
  });
  it('rejects unsafe list entries before any fetch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-batch-'));
    const list = join(dir, 'bad.txt');
    writeFileSync(list, 'https://user:pass@github.com/acme/widget\n');
    expect(() => readBatchList(list)).toThrow('only https://github.com');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not reuse a snapshot when any analysis-affecting flag changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-batch-flags-'));
    const list = join(dir, 'repos.txt');
    writeFileSync(list, 'acme/widget\n');
    const base = {
      listFile: list,
      snapshotDir: dir,
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    };
    await runBatch(base);
    const variants = [
      { verifyCrypto: true },
      { trust: { ...EMPTY_TRUST, expectedIdentity: { issuer: 'issuer' } } },
      { inspectDependencyArtifacts: true },
      { compliance: false },
      { dependencyRegistryBudget: { maxAttestations: 0 } },
      { registry: false },
      { nameIntelligence: true },
    ];
    for (const variant of variants) {
      const result = await runBatch({ ...base, ...variant });
      expect(result.repositories.reused).toEqual([]);
      expect(result.freshness['acme/widget']).toBe('snapshot_incompatible');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('enforces request, byte, wall-clock, and snapshot-read budgets with visible incomplete work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-batch-budgets-'));
    const list = join(dir, 'repos.txt');
    writeFileSync(list, 'acme/one\nacme/two\n');
    const base = {
      listFile: list,
      fetch: fakeFetch(goodRepo()),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    };
    const requests = await runBatch({ ...base, maxRequests: 1 });
    expect(requests.stopped_by).toBe('max_requests');
    expect(requests.repositories.incomplete).toEqual(['acme/two']);
    const snapshots = await runBatch({ ...base, snapshotDir: dir, maxSnapshotReads: 0 });
    expect(snapshots.stopped_by).toBe('max_snapshot_reads');
    expect(snapshots.repositories.incomplete).toEqual(['acme/one']);
    const bytes = await runBatch({
      ...base,
      maxBytes: 1,
      fetch: async () => new Response('{}', { headers: { 'content-length': '2' } }),
    });
    expect(bytes.stopped_by).toBe('max_bytes');
    expect(bytes.repositories.incomplete).toEqual(['acme/one']);
    const time = await runBatch({ ...base, maxMinutes: 0 });
    expect(time.stopped_by).toBe('max_minutes');
    expect(time.repositories.incomplete).toEqual(['acme/one', 'acme/two']);
    rmSync(dir, { recursive: true, force: true });
  });
});
