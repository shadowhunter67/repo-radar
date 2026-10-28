import { parentPort } from 'node:worker_threads';
export const post = (m) => parentPort.postMessage(m);
export const report = {
  schema_version: '0.16',
  generated_at: '2026-01-01T00:00:00.000Z',
  integrity: { report_sha256: 'x' },
};
