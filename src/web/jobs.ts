import { randomBytes } from 'node:crypto';
import type { Report } from '../report/schema.js';
import type { WebConfig } from './config.js';
import { classifyReport } from './classify.js';
import type { WebRepo } from './validate.js';
export type JobState = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'expired';
export type RunAnalysis = (repo: WebRepo, onStage: (s: string) => void) => Promise<Report>;
export type Job = {
  id: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  repo: WebRepo;
  stage?: string;
  report?: Report;
  error?: { code: string; message: string };
  analyzedSha?: string;
};
export class JobStore {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  constructor(
    private config: WebConfig,
    private run: RunAnalysis,
    private clock = () => Date.now(),
  ) {}
  enqueue(repo: WebRepo): Job {
    if (this.queue.length + this.running >= this.config.maxQueue)
      throw Object.assign(new Error('queue full'), { code: 'QUEUE_FULL' });
    const j: Job = {
      id: randomBytes(16).toString('base64url'),
      state: 'queued',
      createdAt: this.clock(),
      repo,
    };
    this.jobs.set(j.id, j);
    this.queue.push(j);
    this.pump();
    return j;
  }
  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    if (!j) return;
    if (j.state !== 'expired' && this.clock() - j.createdAt > this.config.jobTtlSeconds * 1000) {
      j.state = 'expired';
      delete j.report;
    }
    if (
      j.state === 'expired' &&
      this.clock() - j.createdAt > (this.config.jobTtlSeconds + 300) * 1000
    ) {
      this.jobs.delete(id);
      return;
    }
    return j;
  }
  queuePosition(id: string): number | undefined {
    const n = this.queue.findIndex((j) => j.id === id);
    return n < 0 ? undefined : n + 1;
  }
  private pump() {
    while (this.running < this.config.maxConcurrency && this.queue.length) {
      const j = this.queue.shift()!;
      this.running++;
      j.state = 'running';
      j.startedAt = this.clock();
      this.run(j.repo, (s) => (j.stage = s))
        .then((r) => {
          if (Buffer.byteLength(JSON.stringify(r)) > this.config.maxReportBytes) {
            j.state = 'failed';
            j.error = { code: 'REPORT_TOO_LARGE', message: 'report exceeds configured size limit' };
            return;
          }
          j.report = r;
          j.analyzedSha = String((r as unknown as Record<string, unknown>).repository_sha ?? '');
          j.state = classifyReport(r);
        })
        .catch((e: unknown) => {
          const code = (e as { code?: string })?.code;
          j.state = 'failed';
          j.error = {
            code: ['REPOSITORY_NOT_FOUND', 'ANALYSIS_TIMEOUT', 'UPSTREAM_UNAVAILABLE'].includes(
              code ?? '',
            )
              ? code!
              : 'INTERNAL_ERROR',
            message:
              code === 'REPOSITORY_NOT_FOUND'
                ? 'repository was not found'
                : code === 'ANALYSIS_TIMEOUT'
                  ? 'analysis timed out'
                  : 'analysis failed',
          };
        })
        .finally(() => {
          j.finishedAt = this.clock();
          this.running--;
          this.pump();
        });
    }
  }
}
export function partialReport(report: Report): boolean {
  return classifyReport(report) === 'partial';
}
