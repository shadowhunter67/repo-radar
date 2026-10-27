/**
 * Shared GitHub budget accounting for the hosted process. All users share one server-side token, so admission is decided
 * against the token's REAL remaining quota (from the free rate-limit endpoint of the GitHub API) minus what already-running
 * jobs are expected to spend, with a reserve that is never handed out. Per-job limits live in the engine's own budgets; this
 * is the global layer on top.
 */
export type RateSnapshot = { remaining: number; limit: number; resetAt: number; fetchedAt: number };
export type FetchRateLimit = () => Promise<{ remaining: number; limit: number; resetAt: number }>;
export type Admission = { ok: true } | { ok: false; resetAt: string; remaining: number };
export type QuotaOptions = {
  fetchRateLimit?: FetchRateLimit | undefined;
  reserve: number;
  defaultEstimate: number;
  /** A snapshot older than this is refreshed before it is trusted. */
  maxAgeMs?: number;
  clock?: () => number;
};
const RECENT = 20;

export class QuotaTracker {
  private snap: RateSnapshot | undefined;
  private observed: number[] = [];
  private refreshing: Promise<void> | undefined;
  private totalRequests = 0;
  private readonly now: () => number;
  private readonly maxAge: number;
  constructor(private readonly o: QuotaOptions) {
    this.now = o.clock ?? (() => Date.now());
    this.maxAge = o.maxAgeMs ?? 30_000;
  }
  /** Requests one analysis is assumed to cost: the larger of the configured estimate and the largest recent real cost. */
  get estimate(): number {
    return Math.max(this.o.defaultEstimate, ...this.observed);
  }
  get requestsObserved(): number {
    return this.totalRequests;
  }
  get snapshot(): RateSnapshot | undefined {
    return this.snap;
  }
  /** Record the real request count of a finished analysis. */
  record(requests: number): void {
    if (!Number.isFinite(requests) || requests < 0) return;
    this.totalRequests += requests;
    this.observed.push(requests);
    if (this.observed.length > RECENT) this.observed.shift();
    // keep the local picture current between refreshes
    if (this.snap) this.snap.remaining = Math.max(0, this.snap.remaining - requests);
  }
  private async refresh(): Promise<void> {
    if (!this.o.fetchRateLimit) return;
    this.refreshing ??= (async () => {
      try {
        const r = await this.o.fetchRateLimit!();
        this.snap = { ...r, fetchedAt: this.now() };
      } catch {
        // an unreachable rate-limit endpoint must not take the service down: keep the last picture, admit if there is none
      } finally {
        this.refreshing = undefined;
      }
    })();
    await this.refreshing;
  }
  /**
   * Is there room to start one more analysis while `running` others are in flight?
   * Fails open only when quota is unknowable (no endpoint, or it has never answered).
   */
  async admit(running: number): Promise<Admission> {
    if (!this.o.fetchRateLimit) return { ok: true };
    const t = this.now();
    if (!this.snap || t - this.snap.fetchedAt > this.maxAge || t >= this.snap.resetAt)
      await this.refresh();
    const s = this.snap;
    if (!s) return { ok: true };
    const need = this.estimate;
    const available = s.remaining - Math.max(0, running) * need - this.o.reserve;
    if (available >= need) return { ok: true };
    return { ok: false, resetAt: new Date(s.resetAt).toISOString(), remaining: s.remaining };
  }
  /** Coarse, non-sensitive view for readiness and metrics. */
  state(): 'unknown' | 'ok' | 'low' {
    const s = this.snap;
    if (!s) return 'unknown';
    return s.remaining - this.o.reserve >= this.estimate ? 'ok' : 'low';
  }
}
