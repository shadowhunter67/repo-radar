export type RateDecision = { allowed: boolean; retryAfter: number };
type Entry = { minute: number[]; hour: number[]; touched: number };
export class RateLimiter {
  private entries = new Map<string, Entry>();
  constructor(
    private readonly perMinute: number,
    private readonly perHour: number,
    private readonly maxEntries = 10000,
    private readonly now = () => Date.now(),
  ) {}
  check(key: string): RateDecision {
    const t = this.now();
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.maxEntries) {
        const oldest = [...this.entries.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
        if (oldest) this.entries.delete(oldest[0]);
      }
      e = { minute: [], hour: [], touched: t };
      this.entries.set(key, e);
    }
    e.minute = e.minute.filter((x) => t - x < 60000);
    e.hour = e.hour.filter((x) => t - x < 3600000);
    e.touched = t;
    if (e.minute.length >= this.perMinute || e.hour.length >= this.perHour) {
      const next = Math.max(e.minute[0] ?? t, e.hour[0] ?? t);
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((next + (e.minute.length >= this.perMinute ? 60000 : 3600000) - t) / 1000),
        ),
      };
    }
    e.minute.push(t);
    e.hour.push(t);
    return { allowed: true, retryAfter: 0 };
  }
  get size() {
    return this.entries.size;
  }
}
