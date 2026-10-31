import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const mutant = process.env.SCENE_GATE_MUTANT;

/** Runs the scene-gate suite; with SCENE_GATE_MUTANT=<file> that one check module is replaced by a no-op. */
export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: mutant
      ? [{ find: new RegExp(`^.*/checks/${mutant}\.ts$`), replacement: resolve(import.meta.dirname, 'disabled.ts') }]
      : [],
  },
  test: {
    include: ['packages/scene-gate/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
