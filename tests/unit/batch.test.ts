import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBatch, readBatchList } from '../../src/batch.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

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
    expect(first.stopped_by).toBeNull();
    expect(first.policy_failures).toBe(0);
    const second = await runBatch(options);
    expect(second.repositories.analyzed).toEqual([]);
    expect(second.repositories.reused).toEqual(['acme/widget']);
    expect(second.repositories.failed).toEqual([]);
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
});
