import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'scripts/*.test.ts', 'scripts/benchmark/*.test.ts', 'scripts/ai-panel/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Several builders run the full suite on one machine at once; generous timeouts keep CPU contention from failing
    // correct tests (PGlite boots a WASM Postgres per test file).
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Six builders share an 8-core Mac: cap workers so parallel suites don't starve each other.
    maxWorkers: Number(process.env.AGFN_TEST_WORKERS ?? 2),
  },
})
