/**
 * The REAL worker_threads path of the runner: failures of every kind must settle the job with a safe stable code, terminate
 * the worker, release the timer, and let the queue continue. The workers below are small fixture scripts, not the analyzer.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../../src/web/jobs.js';
import { loadWebConfig } from '../../src/web/config.js';
import { createWorkerRunner, type WorkerFactory } from '../../src/web/runner.js';

const dir = join(process.cwd(), 'tests', 'fixtures', 'workers');
const fixture = (name: string) => pathToFileURL(join(dir, name));
type W = { on(e: string, l: (v: unknown) => void): W; terminate(): Promise<number> };

function harness(over: Record<string, number> = {}) {
  const exited: Promise<void>[] = [];
  const factory: WorkerFactory = async (url, options) => {
    const { Worker } = (await import('node:worker_threads')) as unknown as {
      Worker: new (u: URL, o: unknown) => W;
    };
    const w = new Worker(url, options);
    exited.push(new Promise<void>((r) => w.on('exit', () => r())));
    return w;
  };
  const config = { ...loadWebConfig({ PORT: '0' }), analysisTimeoutSeconds: 1, ...over };
  const run = (name: string) => createWorkerRunner(config, factory, fixture(name));
  return { run, exited, config };
}
const repo = { owner: 'o', repo: 'r' };
const noStage = () => undefined;
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: { code?: string; message?: string }) => `${e.code}|${e.message}`,
  );

describe('worker runner against a real worker thread', () => {
  it('returns the report and forwards stages', async () => {
    const h = harness();
    const stages: string[] = [];
    const r = (await h.run('ok.mjs')(repo, (s) => stages.push(s))) as { schema_version: string };
    expect(r.schema_version).toBe('0.16');
    expect(stages).toEqual(['repository_resolved']);
    await Promise.all(h.exited);
  });

  it.each([
    ['a worker that throws', 'throws.mjs', 'INTERNAL_ERROR'],
    ['a worker that exits with a non-zero code', 'exits-nonzero.mjs', 'INTERNAL_ERROR'],
    ['a worker that exits cleanly without a result', 'exits-clean.mjs', 'INTERNAL_ERROR'],
    ['a worker that returns a malformed result', 'malformed.mjs', 'INTERNAL_ERROR'],
    ['a worker that posts a non-object', 'garbage.mjs', 'INTERNAL_ERROR'],
    ['a worker that reports a typed error', 'error-code.mjs', 'REPOSITORY_NOT_FOUND'],
  ])('%s fails with a safe code and the worker is gone', async (_n, file, expected) => {
    const h = harness();
    const out = await code(h.run(file)(repo, noStage));
    expect(out.startsWith(`${expected}|`)).toBe(true);
    expect(out).not.toContain('boom'); // no worker-side message ever reaches the caller
    await Promise.all(h.exited);
  });

  it('terminates a worker that hangs at the timeout', async () => {
    const h = harness({ analysisTimeoutSeconds: 0.4 });
    const started = Date.now();
    expect((await code(h.run('hangs.mjs')(repo, noStage))).startsWith('ANALYSIS_TIMEOUT|')).toBe(
      true,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    await Promise.all(h.exited); // the hung worker really exited: no zombie
  });

  it('survives a worker that exhausts its memory cap (small, controlled cap)', async () => {
    const h = harness({ workerMaxOldSpaceMb: 16, analysisTimeoutSeconds: 20 });
    expect((await code(h.run('oom.mjs')(repo, noStage))).startsWith('INTERNAL_ERROR|')).toBe(true);
    await Promise.all(h.exited);
    // the process is healthy afterwards
    expect(await h.run('ok.mjs')(repo, noStage)).toBeTruthy();
  }, 30_000);

  it('a failing job does not stop the queue: the next job still runs and nothing is left running', async () => {
    const h = harness({ analysisTimeoutSeconds: 0.4 });
    const files = ['hangs.mjs', 'throws.mjs', 'ok.mjs'];
    let n = 0;
    const store = new JobStore({ ...h.config, maxConcurrency: 1, maxQueue: 10 }, (r, s) =>
      h.run(files[n++] ?? 'ok.mjs')(r, s),
    );
    const jobs = files.map((_, i) => store.enqueue({ owner: 'o', repo: `r${i}` }));
    for (
      let i = 0;
      i < 100 &&
      jobs.some(
        (j) => store.get(j.id)?.state !== 'completed' && store.get(j.id)?.state !== 'failed',
      );
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    expect(jobs.map((j) => store.get(j.id)?.state)).toEqual(['failed', 'failed', 'completed']);
    expect(jobs.map((j) => store.get(j.id)?.error?.code)).toEqual([
      'ANALYSIS_TIMEOUT',
      'INTERNAL_ERROR',
      undefined,
    ]);
    expect(store.runningCount).toBe(0);
    await Promise.all(h.exited);
  }, 30_000);

  it('settles exactly once: a result arriving after the timeout is ignored', async () => {
    const h = harness({ analysisTimeoutSeconds: 0.05 });
    expect(
      (await code(h.run('slow-then-ok.mjs')(repo, noStage))).startsWith('ANALYSIS_TIMEOUT|'),
    ).toBe(true);
    await Promise.all(h.exited);
  });
});
