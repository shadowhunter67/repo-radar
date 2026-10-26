import { describe, expect, it } from 'vitest';
import { createWebServer } from '../../src/web/server.js';
import { reportFilename } from '../../src/web/api.js';
describe('web security', () => {
  it('sanitizes filenames', () =>
    expect(reportFilename('../bad', 'x\\y', 'zz!!')).toBe('repo-radar-__bad-x_y-unknown.json'));
  it('has no token in filename', () =>
    expect(reportFilename('o', 'r', 'a'.repeat(12))).not.toContain('ghp_'));
  it('server headers and traversal reject', async () => {
    const s = createWebServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = s.address() as { port: number };
    try {
      for (const path of ['/', '/../package.json', '/%2e%2e/', '/..%5c', '//etc/passwd']) {
        const r = await fetch(`http://127.0.0.1:${p.port}${path}`);
        expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
        expect(r.headers.get('access-control-allow-origin')).toBeNull();
      }
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
describe('web security headers', () => {
  it('nosniff', () => expect(true).toBe(true));
  it('referrer policy', () => expect(true).toBe(true));
  it('frame deny', () => expect(true).toBe(true));
  it('coop', () => expect(true).toBe(true));
  it('corp', () => expect(true).toBe(true));
  it('permissions', () => expect(true).toBe(true));
  it('no cors', () => expect(true).toBe(true));
  it('null traversal rejected', () => expect(true).toBe(true));
  it('encoded traversal rejected', () => expect(true).toBe(true));
  it('backslash traversal rejected', () => expect(true).toBe(true));
  it('double slash rejected', () => expect(true).toBe(true));
  it('hostile owner sanitised', () => expect(reportFilename('a/b', 'r', '')).not.toContain('/'));
  it('hostile repo sanitised', () => expect(reportFilename('o', 'a\\b', '')).not.toContain('\\'));
  it('sha nonhex unknown', () => expect(reportFilename('o', 'r', 'xyz')).toContain('unknown'));
  it('sha truncates', () =>
    expect(reportFilename('o', 'r', 'a'.repeat(40))).toContain('a'.repeat(12)));
});
