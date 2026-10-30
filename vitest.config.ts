import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'providers/*/test/**/*.test.ts',
      'bench/test/**/*.test.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
