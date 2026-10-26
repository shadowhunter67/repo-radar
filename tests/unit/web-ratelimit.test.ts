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
describe('web rate-limit decisions', () => {
  it('returns retry seconds', () => {
    const t = 0;
    const r = new RateLimiter(1, 5, 3, () => t);
    r.check('x');
    expect(r.check('x').retryAfter).toBe(60);
  });
  it('expires minute entries', () => {
    let t = 0;
    const r = new RateLimiter(1, 5, 3, () => t);
    r.check('x');
    t = 60000;
    expect(r.check('x').allowed).toBe(true);
  });
  it('expires hour entries', () => {
    let t = 0;
    const r = new RateLimiter(5, 1, 3, () => t);
    r.check('x');
    t = 3600000;
    expect(r.check('x').allowed).toBe(true);
  });
  it('evicts oldest keys', () => {
    const t = 0;
    const r = new RateLimiter(5, 5, 2, () => t);
    r.check('a');
    r.check('b');
    r.check('c');
    expect(r.size).toBe(2);
  });
});
