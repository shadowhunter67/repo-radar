/**
 * Render (or any platform that provides these variables) is supported by environment fallbacks only: nothing is
 * hard-coded, nothing is required, and an unusable platform value never stops the server from starting.
 */
import { describe, expect, it } from 'vitest';
import { loadWebConfig } from '../../src/web/config.js';

const SHA = '73d45c8a1b2c3d4e5f60718293a4b5c6d7e8f901';
const base = { NODE_ENV: 'production', GITHUB_TOKEN: 't' };

describe('platform build metadata', () => {
  it('uses RENDER_GIT_COMMIT and RENDER_EXTERNAL_URL when the explicit variables are absent', () => {
    const c = loadWebConfig({
      ...base,
      RENDER_GIT_COMMIT: SHA,
      RENDER_EXTERNAL_URL: 'https://repo-radar-kcd0.onrender.com',
    });
    expect(c.buildCommit).toBe(SHA);
    expect(c.publicBaseUrl).toBe('https://repo-radar-kcd0.onrender.com');
  });
  it('explicit BUILD_COMMIT and PUBLIC_BASE_URL win over the platform values', () => {
    const c = loadWebConfig({
      ...base,
      BUILD_COMMIT: 'abcdef1',
      PUBLIC_BASE_URL: 'https://example.org',
      RENDER_GIT_COMMIT: SHA,
      RENDER_EXTERNAL_URL: 'https://repo-radar-kcd0.onrender.com',
    });
    expect(c.buildCommit).toBe('abcdef1');
    expect(c.publicBaseUrl).toBe('https://example.org');
  });
  it('is empty without any of them, and ignores unusable platform values instead of failing', () => {
    expect(loadWebConfig(base)).toMatchObject({ buildCommit: undefined, publicBaseUrl: undefined });
    const c = loadWebConfig({
      ...base,
      RENDER_GIT_COMMIT: 'not a sha',
      RENDER_EXTERNAL_URL: 'javascript:alert(1)',
    });
    expect(c.buildCommit).toBeUndefined();
    expect(c.publicBaseUrl).toBeUndefined();
  });
});

describe('conservative defaults on Render Free (512 MB)', () => {
  it('starts with one worker, a short queue and a small worker heap unless set explicitly', () => {
    const c = loadWebConfig({ ...base, RENDER: 'true' });
    expect(c).toMatchObject({
      maxConcurrency: 1,
      maxQueue: 4,
      workerMaxOldSpaceMb: 192,
      maxStoredJobs: 40,
      maxReportBytes: 8 * 1024 * 1024,
    });
  });
  it('explicit values still win on Render, and other platforms keep the generic defaults', () => {
    expect(
      loadWebConfig({
        ...base,
        RENDER: 'true',
        MAX_CONCURRENCY: '2',
        WORKER_MAX_OLD_SPACE_MB: '256',
      }),
    ).toMatchObject({ maxConcurrency: 2, workerMaxOldSpaceMb: 256 });
    expect(loadWebConfig(base)).toMatchObject({
      maxConcurrency: 2,
      maxQueue: 20,
      workerMaxOldSpaceMb: 512,
    });
  });
  it('the worker heap default plus the server leaves room inside 512 MB', () => {
    const c = loadWebConfig({ ...base, RENDER: 'true' });
    expect(c.maxConcurrency * c.workerMaxOldSpaceMb).toBeLessThanOrEqual(256);
  });
});
