import { analyzeRepository } from '../analyze.js';
const runtime = (await import('node:' + 'worker_' + 'threads')) as {
  parentPort: { postMessage(value: unknown): void } | null;
  workerData: unknown;
};
const parentPort = runtime.parentPort;
const d = runtime.workerData as { owner: string; repo: string; ref?: string; token?: string };
if (!parentPort) throw new Error('worker requires parentPort');
analyzeRepository(`${d.owner}/${d.repo}`, {
  ...(d.token ? { token: d.token } : {}),
  ...(d.ref ? { ref: d.ref } : {}),
  onStage: (stage) => parentPort.postMessage({ type: 'stage', stage }),
})
  .then((report) => parentPort.postMessage({ type: 'result', report }))
  .catch((error) =>
    parentPort.postMessage({ type: 'error', code: error?.code, message: 'analysis failed' }),
  );
