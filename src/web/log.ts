import { createHash, randomBytes } from 'node:crypto';
const salt = randomBytes(16);
export function clientHash(ip: string): string {
  return createHash('sha256').update(salt).update(ip).digest('hex').slice(0, 16);
}
export function logJob(
  event: string,
  jobId: string,
  state: string,
  started: number,
  extra: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({ event, job_id: jobId, state, duration_ms: Date.now() - started, ...extra }),
  );
}
