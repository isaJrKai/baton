import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Never load PostCSS/Tailwind configs from parent directories — keeps the
  // test run hermetic when this repo is nested inside another project.
  css: { postcss: { plugins: [] } },
  test: {
    include: ['test/**/*.test.ts'],
    // v1.3.2 P3 (test speed): build dist/cli.js once when stale so tests
    // spawn node dist/cli.js instead of npx tsx src/cli.ts per command.
    globalSetup: './test/global-setup.ts',
    testTimeout: 10000,
  },
  resolve: {
    extensions: ['.ts', '.js', '.mjs', '.json'],
  },
});
