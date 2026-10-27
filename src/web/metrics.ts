/** Aggregate operational counters. No repository names, no addresses, no report content. */
export class Metrics {
  private started = Date.now();
  private counters = new Map<string, number>();
  private durations: number[] = [];
  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  observeDuration(ms: number): void {
    this.durations.push(ms);
    if (this.durations.length > 200) this.durations.shift();
  }
  snapshot(gauges: Record<string, number | string>): Record<string, unknown> {
    const d = [...this.durations].sort((a, b) => a - b);
    const pct = (p: number) =>
      d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : null;
    return {
      uptime_seconds: Math.round((Date.now() - this.started) / 1000),
      counters: Object.fromEntries([...this.counters].sort(([a], [b]) => (a < b ? -1 : 1))),
      job_duration_ms: { samples: d.length, p50: pct(0.5), p95: pct(0.95), max: d.at(-1) ?? null },
      gauges,
    };
  }
}
