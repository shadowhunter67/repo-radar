import { defineConfig } from 'vitest/config';

// Sequential on purpose: one test file at a time, one worker, so a full run never saturates the machine.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
