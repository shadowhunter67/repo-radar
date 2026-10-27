import { randomBytes } from 'node:crypto';
import type { Report } from '../report/schema.js';
import type { WebConfig } from './config.js';
import { classifyReport } from './classify.js';
import type { QuotaTracker } from './quota.js';
import type { WebRepo } from './validate.js';
export type JobState = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'expired';
export type RunAnalysis = (
  repo: WebRepo,
  onStage: (s: string) => void,
  signal?: AbortSignal,
) => Promise<Report>;
export type Job = {
  id: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  repo: WebRepo;
  stage?: string;
  report?: Report;
  error?: { code: string; message: string; reset_at?: string };
  analyzedSha?: string;
  /** Exact commit the analysis was pinned to (resolved before the job was queued for a worker). */
  resolvedSha?: string;
  /** The report came from the short-lived exact-SHA cache. */
  cached?: boolean;
  /** The job shared one underlying analysis with an identical request that was already queued or running. */
  coalesced?: boolean;
};
export type JobEvent =
  'job_queued' | 'job_started' | 'job_finished' | 'quota_low' | 'cache_hit' | 'job_coalesced';
export type JobStoreExtras = {
  /** Resolves the repository (and optional ref) to an exact commit SHA. Absent in tests that inject a runner only. */
  resolve?: (repo: WebRepo, signal?: AbortSignal) => Promise<string>;
  quota?: QuotaTracker;
  /** Distinguishes analyses that may not share a cache entry (tool version, analysis configuration). */
  cacheSalt?: string;
  onEvent?: (event: JobEvent, job: Job, fields?: Record<string, unknown>) => void;
};
const KNOWN_ERRORS = [
  'REPOSITORY_NOT_FOUND',
  'ANALYSIS_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'RATE_LIMITED',
  'SERVICE_RATE_LIMITED',
  'INVALID_REF',
  'SHUTTING_DOWN',
];
const MESSAGES: Record<string, string> = {
  REPOSITORY_NOT_FOUND: 'repository was not found',
  ANALYSIS_TIMEOUT: 'analysis timed out',
  SERVICE_RATE_LIMITED: 'the hosted analyzer is temporarily rate-limited',
  SHUTTING_DOWN: 'the server is shutting down',
  INVALID_REF: 'the requested ref was not found',
  UPSTREAM_UNAVAILABLE: 'an upstream source was unavailable',
};
const MAX_CACHE_ENTRIES = 50;
const FINISHED: JobState[] = ['completed', 'partial', 'failed', 'expired'];

type Outcome = { report: Report } | { error: Job['error'] };

export class JobStore {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  private preparing = 0;
  private closing = false;
  private sweepTimer: ReturnType<typeof setInterval>;
  private controllers = new Map<string, AbortController>();
  private prepControllers = new Map<string, AbortController>();
  private cache = new Map<string, { report: Report; expiresAt: number }>();
  /** key -> jobs sharing the analysis led by the first job with that key */
  private followers = new Map<string, Job[]>();
  private leaders = new Map<string, Job>();
  private keyOf = new Map<string, string>();
  constructor(
    private config: WebConfig,
    private run: RunAnalysis,
    private clock = () => Date.now(),
    private onFinished: (job: Job) => void = () => undefined,
    private extras: JobStoreExtras = {},
  ) {
    this.sweepTimer = setInterval(
      () => this.sweep(),
      Math.max(1000, Math.min(60000, (config.jobTtlSeconds * 1000) / 2)),
    );
    this.sweepTimer.unref?.();
  }
  get size(): number {
    return this.jobs.size;
  }
  get runningCount(): number {
    return this.running;
  }
  get queueDepth(): number {
    return this.queue.length;
  }
  get cacheSize(): number {
    return this.cache.size;
  }
  /** Sizes of the internal bookkeeping tables; all must return to zero when no job is in flight (leak checks in tests). */
  inspect(): Record<string, number> {
    return {
      queue: this.queue.length,
      running: this.running,
      preparing: this.preparing,
      controllers: this.controllers.size + this.prepControllers.size,
      leaders: this.leaders.size,
      followerGroups: this.followers.size,
      keys: this.keyOf.size,
    };
  }
  /** Jobs that hold or wait for a worker slot (what the queue bound counts). */
  get inFlight(): number {
    return this.queue.length + this.running + this.preparing;
  }
  sweep(): void {
    const now = this.clock();
    for (const [id, j] of this.jobs) {
      if (j.state !== 'expired' && now - j.createdAt > this.config.jobTtlSeconds * 1000) {
        if (!['queued', 'running'].includes(j.state)) {
          j.state = 'expired';
          delete j.report;
        }
      } else if (
        j.state === 'expired' &&
        now - j.createdAt > (this.config.jobTtlSeconds + 300) * 1000
      )
        this.jobs.delete(id);
    }
    for (const [k, c] of this.cache) if (c.expiresAt <= now) this.cache.delete(k);
    while (this.jobs.size > this.config.maxStoredJobs) {
      const finished = [...this.jobs.values()]
        .filter((j) => FINISHED.includes(j.state))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!finished) break;
      this.jobs.delete(finished.id);
    }
  }
  enqueue(repo: WebRepo): Job {
    if (this.closing) throw Object.assign(new Error('shutting down'), { code: 'SHUTTING_DOWN' });
    this.sweep();
    if (this.inFlight >= this.config.maxQueue)
      throw Object.assign(new Error('queue full'), { code: 'QUEUE_FULL' });
    const j: Job = {
      id: randomBytes(16).toString('base64url'),
      state: 'queued',
      createdAt: this.clock(),
      repo,
    };
    this.jobs.set(j.id, j);
    this.emit('job_queued', j);
    if (this.extras.resolve) {
      this.preparing++;
      j.stage = 'resolving_revision';
      void this.prepare(j);
    } else {
      this.queue.push(j);
      this.pump();
    }
    return j;
  }
  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    if (!j) return;
    if (
      !['expired', 'queued', 'running'].includes(j.state) &&
      this.clock() - j.createdAt > this.config.jobTtlSeconds * 1000
    ) {
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
  /**
   * Stops accepting jobs, lets running jobs finish for `graceMs`, then aborts what is left (workers are terminated) and
   * fails everything still waiting with SHUTTING_DOWN. Resolves when nothing is running.
   */
  async shutdown(graceMs: number): Promise<void> {
    this.closing = true;
    clearInterval(this.sweepTimer);
    for (const j of this.queue.splice(0)) this.fail(j, 'SHUTTING_DOWN');
    const deadline = Date.now() + graceMs;
    while (this.running + this.preparing > 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    for (const c of [...this.controllers.values(), ...this.prepControllers.values()]) c.abort();
    for (let i = 0; i < 100 && this.running + this.preparing > 0; i++)
      await new Promise((r) => setTimeout(r, 25));
  }
  private emit(event: JobEvent, job: Job, fields?: Record<string, unknown>): void {
    try {
      this.extras.onEvent?.(event, job, fields);
    } catch {
      /* logging must never affect the queue */
    }
  }
  /** Resolve the exact commit, then serve from cache, join an identical in-flight analysis, or queue for a worker. */
  private async prepare(j: Job): Promise<void> {
    const controller = new AbortController();
    this.prepControllers.set(j.id, controller);
    try {
      const sha = await this.extras.resolve!(j.repo, controller.signal);
      if (this.closing) {
        this.fail(j, 'SHUTTING_DOWN');
        return;
      }
      j.resolvedSha = sha;
      const key =
        `${j.repo.owner}/${j.repo.repo}`.toLowerCase() + `@${sha}|${this.extras.cacheSalt ?? ''}`;
      this.keyOf.set(j.id, key);
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > this.clock()) {
        j.cached = true;
        this.emit('cache_hit', j);
        this.complete(j, hit.report);
        return;
      }
      const leader = this.leaders.get(key);
      if (leader) {
        j.coalesced = true;
        j.stage = 'waiting_for_identical_analysis';
        this.followers.get(key)!.push(j);
        this.emit('job_coalesced', j);
        return;
      }
      this.leaders.set(key, j);
      this.followers.set(key, []);
      j.stage = undefined;
      this.queue.push(j);
      this.pump();
    } catch (e) {
      this.fail(j, (e as { code?: string })?.code, e);
    } finally {
      this.preparing--;
      this.prepControllers.delete(j.id);
      if (!this.closing) this.pump();
    }
  }
  private complete(j: Job, r: Report): void {
    if (Buffer.byteLength(JSON.stringify(r)) > this.config.maxReportBytes) {
      this.fail(j, 'REPORT_TOO_LARGE', undefined, 'report exceeds configured size limit');
      return;
    }
    j.report = r;
    const manifest = (r as unknown as { analysis_manifest?: { commit?: unknown } })
      .analysis_manifest;
    j.analyzedSha =
      typeof manifest?.commit === 'string' && /^[a-f0-9]{40}$/i.test(manifest.commit)
        ? manifest.commit
        : undefined;
    j.state = classifyReport(r);
    this.finishJob(j);
  }
  private fail(j: Job, code?: string, e?: unknown, message?: string): void {
    const c =
      code && (KNOWN_ERRORS.includes(code) || code === 'REPORT_TOO_LARGE')
        ? code
        : 'INTERNAL_ERROR';
    j.state = 'failed';
    j.error = {
      code: c,
      message: message ?? MESSAGES[c] ?? 'analysis failed',
      ...(c === 'SERVICE_RATE_LIMITED' && typeof (e as { resetAt?: unknown })?.resetAt === 'string'
        ? { reset_at: (e as { resetAt: string }).resetAt }
        : {}),
    };
    this.finishJob(j);
  }
  private finishJob(j: Job): void {
    j.finishedAt = this.clock();
    delete j.stage;
    this.keyOf.delete(j.id);
    this.emit('job_finished', j);
    try {
      this.onFinished(j);
    } catch {
      /* logging must never affect the queue */
    }
  }
  /** The leader's outcome is shared with every job that joined it; the report object itself is shared, not copied. */
  private settleGroup(leader: Job, outcome: Outcome, key: string | undefined): void {
    const group = key ? (this.followers.get(key) ?? []) : [];
    if (key) {
      this.followers.delete(key);
      this.leaders.delete(key);
      if ('report' in outcome && leader.state === 'completed' && this.config.cacheTtlSeconds > 0) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(key, {
          report: outcome.report,
          expiresAt: this.clock() + this.config.cacheTtlSeconds * 1000,
        });
      }
    }
    for (const f of group) {
      if ('report' in outcome) this.complete(f, outcome.report);
      else {
        f.state = 'failed';
        f.error = outcome.error;
        this.finishJob(f);
      }
    }
  }
  private pump() {
    while (!this.closing && this.running < this.config.maxConcurrency && this.queue.length) {
      const j = this.queue.shift()!;
      this.running++;
      j.state = 'running';
      j.startedAt = this.clock();
      this.emit('job_started', j);
      const controller = new AbortController();
      this.controllers.set(j.id, controller);
      void this.execute(j, controller);
    }
  }
  private async execute(j: Job, controller: AbortController): Promise<void> {
    let outcome: Outcome | undefined;
    const key = this.keyOf.get(j.id);
    try {
      const quota = this.extras.quota;
      if (quota) {
        const decision = await quota.admit(this.running - 1);
        if (!decision.ok) {
          this.emit('quota_low', j, { reset_at: decision.resetAt });
          throw Object.assign(new Error('quota'), {
            code: 'SERVICE_RATE_LIMITED',
            resetAt: decision.resetAt,
          });
        }
      }
      const repo = j.resolvedSha ? { ...j.repo, ref: j.resolvedSha } : j.repo;
      const r = await this.run(repo, (s) => (j.stage = s), controller.signal);
      const requests = (r as unknown as { stats?: { http_requests?: unknown } }).stats
        ?.http_requests;
      if (typeof requests === 'number') this.extras.quota?.record(requests);
      this.complete(j, r);
      outcome = j.error ? { error: j.error } : { report: r };
    } catch (e) {
      this.fail(j, (e as { code?: string })?.code, e);
      outcome = { error: j.error };
    } finally {
      this.controllers.delete(j.id);
      this.running--;
      if (outcome) this.settleGroup(j, outcome, key);
      this.pump();
    }
  }
}
export function partialReport(report: Report): boolean {
  return classifyReport(report) === 'partial';
}
