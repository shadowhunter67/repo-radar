import type { Report } from '../report/schema.js';
import type { WebConfig } from './config.js';
import type { WebRepo } from './validate.js';
type WorkerLike = {
  on(event: string, listener: (value: unknown) => void): WorkerLike;
  terminate(): Promise<number>;
};
export type WorkerFactory = (
  url: URL,
  options: {
    workerData: unknown;
    execArgv?: string[];
    resourceLimits?: { maxOldGenerationSizeMb: number };
  },
) => WorkerLike | Promise<WorkerLike>;
type RunnerError = Error & { code: string; resetAt?: string };
const fail = (code: string, message: string): RunnerError =>
  Object.assign(new Error(message), { code }) as RunnerError;
const isReport = (v: unknown): v is Report =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as { schema_version?: unknown }).schema_version === 'string' &&
  typeof (v as { generated_at?: unknown }).generated_at === 'string' &&
  !!(v as { integrity?: unknown }).integrity;

/**
 * Runs one analysis in a worker thread and settles exactly once: with the report, or with an error that carries a stable
 * code. Whatever the worker does (throws, exits, hangs, runs out of memory, posts nonsense) the promise settles, the timer
 * is cleared and the worker is terminated, so the queue behind it keeps moving and nothing is left running.
 */
export function createWorkerRunner(
  config: WebConfig,
  factory?: WorkerFactory,
  workerUrl: URL = new URL('./worker.js', import.meta.url),
): (repo: WebRepo, onStage: (s: string) => void, signal?: AbortSignal) => Promise<Report> {
  return (repo, onStage, signal) =>
    new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let worker: WorkerLike | undefined;
      const finish = (error: RunnerError | undefined, report?: Report): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        void worker?.terminate().catch(() => undefined);
        if (error) reject(error);
        else resolve(report as Report);
      };
      signal?.addEventListener('abort', () => finish(fail('SHUTTING_DOWN', 'aborted')), {
        once: true,
      });
      if (signal?.aborted) return finish(fail('SHUTTING_DOWN', 'aborted'));
      void (async () => {
        const f: WorkerFactory =
          factory ??
          (async (url, options) => {
            const mod = (await import('node:' + 'worker_' + 'threads')) as {
              Worker: new (url: URL, options: unknown) => WorkerLike;
            };
            return new mod.Worker(url, options);
          });
        // the timer starts before the worker so a stuck start-up cannot outlive the limit
        timer = setTimeout(
          () => finish(fail('ANALYSIS_TIMEOUT', 'analysis timeout')),
          config.analysisTimeoutSeconds * 1000,
        );
        worker = await f(workerUrl, {
          workerData: { owner: repo.owner, repo: repo.repo, ref: repo.ref, token: config.token },
          execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
          resourceLimits: { maxOldGenerationSizeMb: config.workerMaxOldSpaceMb },
        });
        if (settled) {
          void worker.terminate().catch(() => undefined);
          return;
        }
        worker
          .on('message', (value: unknown) => {
            const m = (value ?? {}) as {
              type?: string;
              stage?: unknown;
              report?: unknown;
              code?: unknown;
              resetAt?: unknown;
            };
            if (m.type === 'stage' && typeof m.stage === 'string') onStage(m.stage);
            else if (m.type === 'result' && isReport(m.report)) finish(undefined, m.report);
            else if (m.type === 'error') {
              const e = fail(
                typeof m.code === 'string' ? m.code : 'INTERNAL_ERROR',
                'analysis failed',
              );
              if (typeof m.resetAt === 'string') e.resetAt = m.resetAt;
              finish(e);
            } else finish(fail('INTERNAL_ERROR', 'worker returned an unexpected message'));
          })
          .on('error', () => finish(fail('INTERNAL_ERROR', 'worker failed')))
          .on('messageerror', () => finish(fail('INTERNAL_ERROR', 'worker message failed')))
          // an exit before a result is a failure whatever the exit code (a clean exit without a result is still no result)
          .on('exit', () => finish(fail('INTERNAL_ERROR', 'worker exited without a result')));
      })().catch(() => finish(fail('INTERNAL_ERROR', 'worker could not start')));
    });
}
