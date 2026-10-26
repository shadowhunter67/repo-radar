import { randomBytes } from 'node:crypto';
import type { Report } from '../report/schema.js';
import type { WebConfig } from './config.js';
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
};
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  constructor(
    private readonly config: WebConfig,
    private readonly run: RunAnalysis,
    private readonly clock = () => Date.now(),
  ) {}
  enqueue(repo: WebRepo): Job {
    if (this.queue.length >= this.config.maxQueue) throw new Error('QUEUE_FULL');
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
    if (j && this.clock() - j.createdAt > this.config.jobTtlSeconds * 1000) {
      if (j.state !== 'expired') {
        j.state = 'expired';
        delete j.report;
      }
    }
    return this.jobs.get(id);
  }
  private pump(): void {
    while (this.running < this.config.maxConcurrency && this.queue.length) {
      const j = this.queue.shift()!;
      this.running++;
      j.state = 'running';
      j.startedAt = this.clock();
      this.run(j.repo, (s) => (j.stage = s))
        .then((r) => {
          j.report = r;
          j.state = partialReport(r) ? 'partial' : 'completed';
        })
        .catch((e) => {
          j.state = 'failed';
          j.error = {
            code: e?.code === 'REPOSITORY_NOT_FOUND' ? 'REPOSITORY_NOT_FOUND' : 'INTERNAL_ERROR',
            message:
              e?.code === 'REPOSITORY_NOT_FOUND' ? 'repository was not found' : 'analysis failed',
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
  const r = report as unknown as Record<string, unknown>;
  const retrieval = r.retrieval as Record<string, unknown> | undefined;
  const coverage = r.coverage_map as Record<string, unknown> | undefined;
  return (
    retrieval?.completeness === 'partial' ||
    retrieval?.completeness === 'incomplete' ||
    Object.values(coverage ?? {}).some(
      (v) => v === 'unknown' || v === 'unavailable' || v === 'partial',
    )
  );
}
