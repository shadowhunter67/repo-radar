import { runWebAnalysis } from './analysis.js';
import { RepoNotFoundError } from '../collectors/github/collector.js';
import { HttpError, RateLimitError } from '../util/http.js';
import { RepoRefError } from '../util/repo-ref.js';
const runtime = (await import('node:' + 'worker_' + 'threads')) as {
  parentPort: { postMessage(value: unknown): void } | null;
  workerData: unknown;
};
const parentPort = runtime.parentPort;
const d = runtime.workerData as { owner: string; repo: string; ref?: string; token?: string };
if (!parentPort) throw new Error('worker requires parentPort');
runWebAnalysis(
  { owner: d.owner, repo: d.repo, ...(d.ref ? { ref: d.ref } : {}) },
  {
    ...(d.token ? { token: d.token } : {}),
    onStage: (stage) => parentPort.postMessage({ type: 'stage', stage }),
  },
)
  .then((report) => parentPort.postMessage({ type: 'result', report }))
  .catch((error: unknown) => {
    const e = error as Error;
    const code =
      e instanceof RepoNotFoundError
        ? 'REPOSITORY_NOT_FOUND'
        : e instanceof RateLimitError
          ? 'RATE_LIMITED'
          : e instanceof RepoRefError
            ? 'INVALID_REF'
            : e instanceof HttpError
              ? 'UPSTREAM_UNAVAILABLE'
              : 'INTERNAL_ERROR';
    parentPort.postMessage({
      type: 'error',
      code,
      ...(e instanceof RateLimitError && e.resetAt ? { resetAt: e.resetAt.toISOString() } : {}),
    });
  });
