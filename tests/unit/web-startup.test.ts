/**
 * The built server must start from any install location: a path with spaces and non-ASCII characters (Windows user names,
 * localized folders), resolve its static files, package.json and rule files from there, and shut down on a signal.
 * The tree is copied to a temporary directory so nothing depends on the repository checkout path.
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const built = existsSync('dist/web/server.js') && existsSync('dist/web/public/index.html');

async function start(entry: string, cwd: string) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no listening line; output: ${out}`)), 15000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /"event":"server_start"[^\n]*"port":(\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (c) => reject(new Error(`exited ${c}: ${out}`)));
  });
  return { child, port, output: () => out };
}

describe.skipIf(!built)('built server started from an unusual install path', () => {
  const base = mkdtempSync(join(tmpdir(), 'rr '));
  const root = join(base, 'Tên Người', '测试', 'repo radar');
  mkdirSync(root, { recursive: true });
  for (const d of ['dist', 'standards', 'profiles', 'schemas'])
    cpSync(d, join(root, d), { recursive: true });
  cpSync('package.json', join(root, 'package.json'));
  // a junction/symlink, not a copy: dependencies are resolved through it exactly as in a real install
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  afterAll(() => {
    unlinkSync(join(root, 'node_modules')); // remove the link first so the recursive delete can never reach the real directory
    rmSync(base, { recursive: true, force: true });
  });

  it('serves health, the page and a static asset, and reports its version', async () => {
    const { child, port } = await start(join(root, 'dist', 'web', 'server.js'), root);
    try {
      const url = (p: string) => `http://127.0.0.1:${port}${p}`;
      const health = (await (await fetch(url('/api/v1/health'))).json()) as {
        ok: boolean;
        version: string;
      };
      expect(health.ok).toBe(true);
      expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
      const page = await fetch(url('/'));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>');
      expect((await fetch(url('/app.js'))).status).toBe(200);
      const ready = (await (await fetch(url('/api/v1/ready'))).json()) as { schema: string };
      expect(ready.schema).toBe('0.16');
    } finally {
      child.kill();
    }
  }, 60_000);

  it.skipIf(process.platform === 'win32')(
    'exits cleanly on SIGTERM and logs the shutdown',
    async () => {
      const { child, output } = await start(join(root, 'dist', 'web', 'server.js'), root);
      const code = await new Promise<number | null>((resolve) => {
        child.on('exit', (c) => resolve(c));
        child.kill('SIGTERM');
      });
      expect(code).toBe(0);
      expect(output()).toContain('"event":"server_shutdown"');
    },
    30_000,
  );
});
