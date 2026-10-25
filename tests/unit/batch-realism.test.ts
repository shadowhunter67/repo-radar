import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBatchList, runBatch } from '../../src/batch.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

describe('batch operational realism', () => {
  it('continues through twelve repositories and reports exact summary fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-batch-realism-'));
    try {
      const names = Array.from({ length: 12 }, (_, i) => `acme/repo-${i + 1}`);
      writeFileSync(join(root, 'repos.txt'), names.join('\n'));
      const specs = new Map(
        names.map((name) => {
          const [owner, repo] = name.split('/');
          const extra =
            repo === 'repo-7'
              ? { rateLimited: ['/commits?per_page=1'] }
              : repo === 'repo-8'
                ? { failing: ['/git/trees'] }
                : {};
          return [name, goodRepo({ owner, repo, ...extra })] as const;
        }),
      );
      const fetch = async (url: string, init?: RequestInit) => {
        const match = url.match(/api\.github\.com\/repos\/([^/]+)\/([^/]+)/);
        const key = match ? `${match[1]}/${match[2]}` : names[0]!;
        return fakeFetch(specs.get(key)!)(url, init);
      };
      const result = await runBatch({
        listFile: join(root, 'repos.txt'),
        snapshotDir: root,
        fetch,
        clock: fixedClock,
        scorecard: false,
        osv: false,
        depsDev: false,
      });
      expect(result.requested).toBe(12);
      expect(result.analyzed).toBe(11);
      expect(result.failed).toBe(1);
      expect(result.incomplete).toBe(0);
      expect(result.policy_failures).toBe(0);
      expect(result).not.toHaveProperty('aggregate_score');
      expect(result.repositories.analyzed).toHaveLength(11);
      expect(result.repositories.failed.map((x) => x.repository)).toEqual(['acme/repo-7']);
      expect(result.stopped_by).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops visibly at a repository budget and rejects malformed credentials before fetch', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-batch-input-'));
    try {
      const file = join(root, 'repos.txt');
      writeFileSync(file, 'https://user:pass@github.com/acme/repo\n');
      expect(() => readBatchList(file)).toThrow(/only https:\/\/github\.com/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
