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
export function createWorkerRunner(
  config: WebConfig,
  factory?: WorkerFactory,
): (repo: WebRepo, onStage: (s: string) => void) => Promise<Report> {
  return (repo, onStage) =>
    new Promise((resolve, reject) => {
      void (async () => {
        const f =
          factory ??
          (async (url, options) => {
            const mod = (await import('node:' + 'worker_' + 'threads')) as {
              Worker: new (url: URL, options: unknown) => WorkerLike;
            };
            return new mod.Worker(url, options);
          });
        const w = await f(new URL('./worker.js', import.meta.url), {
          workerData: { owner: repo.owner, repo: repo.repo, ref: repo.ref, token: config.token },
          execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
          resourceLimits: { maxOldGenerationSizeMb: config.workerMaxOldSpaceMb },
        });
        let ended = false;
        const terminate = () => {
          if (!ended) {
            ended = true;
            void w.terminate();
          }
        };
        const timer = setTimeout(() => {
          terminate();
          const e = new Error('analysis timeout') as Error & { code: string };
          e.code = 'ANALYSIS_TIMEOUT';
          reject(e);
        }, config.analysisTimeoutSeconds * 1000);
        w.on('message', (value: unknown) => {
          const m = value as { type: string; stage?: string; report?: Report; code?: string };
          if (m.type === 'stage') onStage(m.stage!);
          else if (m.type === 'result') {
            clearTimeout(timer);
            terminate();
            resolve(m.report!);
          } else {
            clearTimeout(timer);
            terminate();
            const e = new Error('analysis failed') as Error & { code?: string };
            e.code = m.code;
            reject(e);
          }
        })
          .on('error', () => {
            clearTimeout(timer);
            terminate();
            reject(Object.assign(new Error('worker failed'), { code: 'INTERNAL_ERROR' }));
          })
          .on('messageerror', () => {
            clearTimeout(timer);
            terminate();
            reject(Object.assign(new Error('worker message failed'), { code: 'INTERNAL_ERROR' }));
          })
          .on('exit', (code: unknown) => {
            if (!ended && code !== 0) {
              clearTimeout(timer);
              terminate();
              reject(Object.assign(new Error('worker exited'), { code: 'INTERNAL_ERROR' }));
            }
          });
      })().catch(reject);
    });
}
