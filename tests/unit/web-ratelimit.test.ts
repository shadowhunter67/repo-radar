import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/web/ratelimit.js';
describe('web rate limits', () => {
  it('limits minute and hour with deterministic clock', () => {
    let t = 0;
    const r = new RateLimiter(2, 3, 10, () => t);
    expect(r.check('a').allowed).toBe(true);
    expect(r.check('a').allowed).toBe(true);
    expect(r.check('a').allowed).toBe(false);
    t = 60001;
    expect(r.check('a').allowed).toBe(true);
    expect(r.check('a').allowed).toBe(false);
  });
  it('bounds rotating clients', () => {
    const r = new RateLimiter(10, 10, 3, () => 0);
    for (let i = 0; i < 20; i++) r.check(String(i));
    expect(r.size).toBe(3);
  });
});
