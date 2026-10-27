import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const lines = dockerfile.split('\n').filter((l) => !l.trim().startsWith('#'));
const ignore = readFileSync('.dockerignore', 'utf8')
  .split('\n')
  .map((l) => l.trim());
const runtime = dockerfile.split(/^FROM .* AS runtime$/m)[1] ?? '';

describe('Dockerfile for the web analyzer', () => {
  it('has a separate runtime stage that runs as a non-root user', () => {
    expect(runtime.length).toBeGreaterThan(0);
    const users = [...runtime.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).not.toBe('root');
    expect(users.at(-1)).not.toBe('0');
    // USER must come before CMD so the server itself is not root
    expect(runtime.indexOf('USER ')).toBeLessThan(runtime.indexOf('CMD '));
  });

  it('declares a healthcheck against the versioned health route', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
    expect(dockerfile).toContain('/api/v1/health');
  });

  it('installs only production dependencies in the runtime image', () => {
    expect(runtime).toContain('npm ci --omit=dev');
  });

  it('sets production mode and the documented port without any secret', () => {
    expect(runtime).toMatch(/NODE_ENV=production/);
    expect(runtime).toMatch(/PORT=8787/);
    expect(runtime).toMatch(/^EXPOSE 8787$/m);
    const joined = lines.join('\n');
    expect(joined).not.toMatch(/GITHUB_TOKEN/);
    expect(joined).not.toMatch(/ghp_|github_pat_/);
    expect(joined).not.toMatch(/^ARG\s+.*(TOKEN|SECRET|PASSWORD)/im);
  });

  it('starts the compiled server', () => {
    expect(runtime).toContain('CMD ["node", "dist/web/server.js"]');
  });

  it('keeps dependencies, history and secrets out of the build context', () => {
    expect(ignore).toContain('node_modules');
    expect(ignore).toContain('.git');
    expect(ignore).toContain('.env');
  });
});
