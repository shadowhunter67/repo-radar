import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', acceptDownloads: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node tests/e2e/fixture-server.mjs',
    url: 'http://127.0.0.1:4173/api/v1/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
